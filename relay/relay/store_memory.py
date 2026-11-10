"""In-process store for tests. One asyncio lock plays the transaction; every value going in
or out is deep-copied so no caller can mutate stored state by aliasing."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .store import (
    DELIVERY_SCAN_LIMIT,
    MAX_LIVE_CREDENTIALS,
    STREAM_SCAN_LIMIT,
    TEAM_DELETED,
    AccountRecord,
    AdminAuditEntry,
    AuditEntry,
    BeyondHead,
    BoundariesFn,
    CreateOutcome,
    CredentialRecord,
    Envelope,
    IdempotencyRecord,
    LoginCode,
    LoginDoc,
    LoginFn,
    MemberDoc,
    MutateFn,
    ProgressEntry,
    Quota,
    QuotaExceeded,
    RedeemFn,
    RedeemOutcome,
    RequestDoc,
    RetiredId,
    RosterEntry,
    RosterFn,
    RosterOutcome,
    RosterState,
    StreamPage,
    TeamBoundaries,
    TeamCreateFn,
    TeamDeleteFn,
    TeamGone,
    TeamRecord,
    account_key,
    credentials_over_cap,
    membership_changes,
    monotonic_updated_at,
    revocable_by_email,
    roster_counts,
    stamp_deliveries,
)


@dataclass
class _Stream:
    head: int = 0
    cursor: int = 0
    messages: dict[int, Envelope] = field(default_factory=dict)


class MemoryStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._members: dict[tuple[str, str], MemberDoc] = {}
        self._streams: dict[tuple[str, str, str], _Stream] = {}
        self._requests: dict[tuple[str, str], RequestDoc] = {}
        self._progress: dict[tuple[str, str], list[ProgressEntry]] = {}
        self._idempotency: dict[tuple[str, str], IdempotencyRecord] = {}
        self._audit: list[AuditEntry] = []
        self._counters: dict[tuple[str, str], int] = {}
        self._roster: dict[str, dict[str, RosterEntry]] = {}
        # teams/{team}: roster_version lives on the record, as in Firestore.
        self._teams: dict[str, TeamRecord] = {}
        self._accounts: dict[str, AccountRecord] = {}
        self._admin_audit: list[AdminAuditEntry] = []
        self._retired: dict[str, dict[str, RetiredId]] = {}
        self._credentials: dict[tuple[str, str], CredentialRecord] = {}
        self._logins: dict[str, LoginDoc] = {}
        self._codes: dict[str, LoginCode] = {}
        self._login_counters: dict[str, int] = {}
        # teams/{team}/settings/boundaries (M10-SPEC §1).
        self._boundaries: dict[str, TeamBoundaries] = {}

    async def aclose(self) -> None:
        return None

    # Helpers (call with the lock held) --------------------------------------------------
    def _append(self, envelopes: Sequence[Envelope]) -> list[Envelope]:
        written = []
        for env in envelopes:
            stream = self._streams.setdefault((env.team, env.to, env.stream), _Stream())
            stored = copy.deepcopy(env)
            stream.head += 1
            stored.seq = stream.head
            stream.messages[stored.seq] = stored
            written.append(copy.deepcopy(stored))
        return written

    def _advance(self, team: str, state: _Stream, to: int, now: datetime) -> None:
        """Move the cursor to ``to`` (> cursor) and stamp the deliveries it passed (§3.2)."""
        passed: list[Envelope] = []
        for seq in range(state.cursor + 1, to + 1):
            if len(passed) >= DELIVERY_SCAN_LIMIT:
                break
            if seq in state.messages:
                passed.append(state.messages[seq])
        requests = {
            env.request_id: self._requests[(team, env.request_id)]
            for env in passed
            if (team, env.request_id) in self._requests
        }
        # stamp_deliveries edits the stored documents in place; the lock is held.
        stamp_deliveries(passed, requests, now)
        state.cursor = to

    def _take(self, team: str, quotas: Sequence[Quota]) -> None:
        """Check every quota, then count one against each; all or nothing."""
        for quota in quotas:
            if self._counters.get((team, quota.key), 0) >= quota.limit:
                raise QuotaExceeded(quota)
        for quota in quotas:
            self._counters[(team, quota.key)] = self._counters.get((team, quota.key), 0) + 1

    # Members --------------------------------------------------------------------------
    async def get_members(self, team: str, members: Sequence[str]) -> dict[str, MemberDoc]:
        async with self._lock:
            return {
                m: copy.deepcopy(self._members[(team, m)])
                for m in members
                if (team, m) in self._members
            }

    async def put_manifest(
        self,
        team: str,
        member: str,
        manifest: dict[str, Any],
        published_at: datetime,
        audit: Sequence[AuditEntry],
    ) -> None:
        async with self._lock:
            doc = self._members.setdefault((team, member), MemberDoc())
            doc.manifest = copy.deepcopy(manifest)
            doc.published_at = published_at
            self._audit.extend(copy.deepcopy(list(audit)))

    async def touch_presence(
        self, team: str, member: str, stream: str, now: datetime, min_interval: timedelta
    ) -> None:
        async with self._lock:
            doc = self._members.setdefault((team, member), MemberDoc())
            last = doc.presence.get(stream)
            if last is None or now - last >= min_interval:
                doc.presence[stream] = now
                if doc.last_seen is None or now > doc.last_seen:
                    doc.last_seen = now

    # Requests -------------------------------------------------------------------------
    async def get_idempotency(
        self, team: str, key_id: str, now: datetime
    ) -> IdempotencyRecord | None:
        async with self._lock:
            record = self._idempotency.get((team, key_id))
            if record is None or record.expire_at <= now:
                return None
            return copy.deepcopy(record)

    async def create_request(
        self,
        team: str,
        key_id: str,
        record: IdempotencyRecord,
        request: RequestDoc,
        envelopes: Sequence[Envelope],
        audit: Sequence[AuditEntry],
        now: datetime,
        quotas: Sequence[Quota] = (),
    ) -> CreateOutcome:
        async with self._lock:
            existing = self._idempotency.get((team, key_id))
            if existing is not None and existing.expire_at > now:
                return CreateOutcome(created=False, record=copy.deepcopy(existing))
            if (team, request.request_id) in self._requests:
                raise RuntimeError("request id collision")
            self._take(team, quotas)
            self._idempotency[(team, key_id)] = copy.deepcopy(record)
            self._requests[(team, request.request_id)] = copy.deepcopy(request)
            self._append(envelopes)
            self._audit.extend(copy.deepcopy(list(audit)))
            return CreateOutcome(created=True, record=copy.deepcopy(record))

    async def get_request(self, team: str, request_id: str) -> RequestDoc | None:
        async with self._lock:
            return copy.deepcopy(self._requests.get((team, request_id)))

    async def list_progress(self, team: str, request_id: str) -> list[ProgressEntry]:
        async with self._lock:
            entries = self._progress.get((team, request_id), [])
            return copy.deepcopy(sorted(entries, key=lambda e: e.seq))

    async def mutate_request[T](self, team: str, request_id: str, fn: MutateFn[T]) -> T:
        async with self._lock:
            current = copy.deepcopy(self._requests.get((team, request_id)))
            previous = current.updated_at if current is not None else None
            mutation = fn(current)  # raising here leaves everything untouched
            if mutation.request is not None:
                if mutation.request.request_id != request_id:
                    raise RuntimeError("a mutation may only write its own request")
                # M2-SPEC §7.1, on the value read under the lock.
                mutation.request.updated_at = monotonic_updated_at(
                    mutation.request.updated_at, previous
                )
                self._requests[(team, request_id)] = copy.deepcopy(mutation.request)
            self._append(mutation.envelopes)
            if mutation.progress:
                bucket = self._progress.setdefault((team, request_id), [])
                bucket.extend(copy.deepcopy(mutation.progress))
            self._audit.extend(copy.deepcopy(mutation.audit))
            return mutation.result

    async def due_requests(self, team: str, asker: str, now: datetime, limit: int) -> list[str]:
        async with self._lock:
            due = [
                doc
                for (t, _), doc in self._requests.items()
                if t == team
                and doc.asker == asker
                and doc.next_deadline is not None
                and doc.next_deadline <= now
            ]
            due.sort(key=lambda d: d.next_deadline)  # type: ignore[arg-type,return-value]
            return [d.request_id for d in due[:limit]]

    async def requests_updated_after(
        self, team: str, since: datetime, limit: int, *, descending: bool = False
    ) -> list[RequestDoc]:
        async with self._lock:
            found = [
                doc
                for (t, _), doc in self._requests.items()
                if t == team and doc.updated_at is not None and doc.updated_at > since
            ]
            found.sort(key=lambda d: (d.updated_at, d.request_id), reverse=descending)
            return copy.deepcopy(found[:limit])

    async def requests_updated_at(self, team: str, at: datetime, limit: int) -> list[RequestDoc]:
        async with self._lock:
            found = [
                doc for (t, _), doc in self._requests.items() if t == team and doc.updated_at == at
            ]
            found.sort(key=lambda d: d.request_id)
            return copy.deepcopy(found[:limit])

    # Streams --------------------------------------------------------------------------
    async def read_stream(
        self,
        team: str,
        member: str,
        stream: str,
        after: int | None,
        limit: int,
        now: datetime,
        *,
        advance: bool = True,
    ) -> StreamPage:
        async with self._lock:
            state = self._streams.get((team, member, stream), _Stream())
            out: list[Envelope] = []
            start = state.cursor if after is None else after
            seq = start
            expired_through = start  # the end of the expired run right after ``start``
            scanned = 0
            while len(out) < limit and seq < state.head and scanned < STREAM_SCAN_LIMIT:
                seq += 1
                env = state.messages.get(seq)
                if env is None:
                    continue
                scanned += 1
                if env.expire_at > now:
                    out.append(copy.deepcopy(env))
                elif not out:
                    expired_through = seq
            if advance and start == state.cursor and expired_through > state.cursor:
                self._advance(team, state, expired_through, now)  # (§11.5) under the lock
            return StreamPage(messages=out, cursor=state.cursor, head=state.head)

    async def set_cursor(
        self, team: str, member: str, stream: str, acked_seq: int, now: datetime
    ) -> int:
        async with self._lock:
            state = self._streams.get((team, member, stream))
            head = state.head if state else 0
            if acked_seq > head:
                raise BeyondHead()
            if state is None:
                return 0
            if acked_seq > state.cursor:
                self._advance(team, state, acked_seq, now)
            return state.cursor

    # Audit ----------------------------------------------------------------------------
    async def append_audit(self, entries: Sequence[AuditEntry]) -> None:
        async with self._lock:
            self._audit.extend(copy.deepcopy(list(entries)))

    async def append_audit_capped(
        self, team: str, entries: Sequence[AuditEntry], quota: Quota
    ) -> bool:
        async with self._lock:
            try:
                self._take(team, [quota])
            except QuotaExceeded:
                return False
            self._audit.extend(copy.deepcopy(list(entries)))
            return True

    async def list_audit(self, team: str, limit: int = 1000) -> list[AuditEntry]:
        async with self._lock:
            return copy.deepcopy([e for e in self._audit if e.team == team][:limit])

    async def count_quota(self, team: str, quota: Quota) -> bool:
        async with self._lock:
            try:
                self._take(team, [quota])
            except QuotaExceeded:
                return False
            return True

    # Roster ---------------------------------------------------------------------------
    async def roster_version(self, team: str) -> int:
        async with self._lock:
            record = self._teams.get(team)
            return record.roster_version if record is not None else 0

    async def read_roster(self, team: str) -> RosterState:
        async with self._lock:
            return self._roster_state(team)

    def _roster_state(self, team: str) -> RosterState:
        record = self._teams.get(team)
        return RosterState(
            version=record.roster_version if record is not None else 0,
            entries=copy.deepcopy(self._roster.get(team, {})),
            retired=copy.deepcopy(self._retired.get(team, {})),
        )

    def _index(self, team: str, changes: dict[str, str | None]) -> None:
        """Apply membership changes to the account index (a team the API created)."""
        for email, member in changes.items():
            key = account_key(email)
            account = self._accounts.setdefault(key, AccountRecord(key=key))
            if member is None:
                account.memberships.pop(team, None)
            else:
                account.memberships[team] = member
            if not account.memberships and not account.created:
                del self._accounts[key]

    async def mutate_roster[T](
        self, team: str, fn: RosterFn[T], now: datetime, quotas: Sequence[Quota] = ()
    ) -> RosterOutcome[T]:
        async with self._lock:
            record = self._teams.get(team)
            if record is not None and record.status == TEAM_DELETED:
                raise TeamGone(team)
            state = self._roster_state(team)
            version = state.version
            change = fn(state)  # raising here leaves everything untouched
            if not change.changed:
                return RosterOutcome(result=change.result, version=version, revoked=[])
            self._take(team, quotas)
            entries = self._roster.setdefault(team, {})
            before = copy.deepcopy(entries)
            revoked: list[str] = []
            for member in change.remove:
                entries.pop(member, None)
                for (t, key), cred in sorted(self._credentials.items()):
                    if t == team and cred.member == member and cred.live(now):
                        cred.revoked = True
                        cred.revoked_at = now
                        revoked.append(key)
            for member, email_sha256 in change.revoke_email:
                for (t, key), cred in sorted(self._credentials.items()):
                    if (
                        t == team
                        and cred.live(now)
                        and revocable_by_email(cred, member, email_sha256)
                    ):
                        cred.revoked = True
                        cred.revoked_at = now
                        revoked.append(key)
            for entry in change.put:
                entries[entry.member] = copy.deepcopy(entry)
            retired = self._retired.setdefault(team, {})
            for tomb in change.retire:
                retired[tomb.member] = copy.deepcopy(tomb)
            if record is None:
                record = self._teams[team] = TeamRecord(id=team, name=team)
            record.roster_version = version + 1
            record.members, record.owners = roster_counts(before, change.put, change.remove)
            if not record.seed:
                self._index(team, membership_changes(before, change.put, change.remove))
            self._audit.extend(copy.deepcopy(change.audit))
            return RosterOutcome(
                result=change.result, version=version + 1, revoked=sorted(set(revoked))
            )

    # Teams ----------------------------------------------------------------------------
    async def get_teams(self, teams: Sequence[str]) -> dict[str, TeamRecord]:
        async with self._lock:
            return {t: copy.deepcopy(self._teams[t]) for t in teams if t in self._teams}

    async def list_teams(self, after: str | None, limit: int) -> list[TeamRecord]:
        async with self._lock:
            found = sorted(
                (r for r in self._teams.values() if not r.seed and (after is None or r.id > after)),
                key=lambda r: r.id,
            )
            return copy.deepcopy(found[:limit])

    async def ensure_seed_team(self, team: str, name: str, now: datetime) -> TeamRecord:
        async with self._lock:
            record = self._teams.get(team)
            if record is None:
                record = self._teams[team] = TeamRecord(id=team, name=name)
            # M9-SPEC §7.1: a record the API created is never adopted, active or deleted.
            if record.status == TEAM_DELETED or not record.seed:
                return copy.deepcopy(record)
            if record.created_at is None:
                record.created_at = now
                record.name = name
            if record.members is None or record.owners is None:
                entries = self._roster.get(team, {})
                record.members, record.owners = roster_counts(entries, [], [])
            return copy.deepcopy(record)

    async def team_has_documents(self, team: str) -> bool:
        async with self._lock:
            return (
                team in self._teams
                or bool(self._roster.get(team))
                or bool(self._retired.get(team))
                or bool(self._team_documents(team))
            )

    async def create_team[T](
        self,
        team: str,
        email_sha256: str,
        fn: TeamCreateFn[T],
        quotas: Sequence[Quota] = (),
        sub_key: str | None = None,
    ) -> T:
        async with self._lock:
            creation = fn(
                copy.deepcopy(self._teams.get(team)),
                copy.deepcopy(self._accounts.get(email_sha256)),
                copy.deepcopy(self._accounts.get(sub_key)) if sub_key else None,
            )
            if creation.team is None:
                return creation.result
            if creation.team.id != team:
                raise RuntimeError("a creation may only write its own team")
            for quota in quotas:
                if self._login_counters.get(quota.key, 0) >= quota.limit:
                    raise QuotaExceeded(quota)
            for quota in quotas:
                self._login_counters[quota.key] = self._login_counters.get(quota.key, 0) + 1
            self._teams[team] = copy.deepcopy(creation.team)
            owner = creation.owner
            self._roster[team] = {owner.member: copy.deepcopy(owner)} if owner else {}
            for key in [email_sha256, *([sub_key] if sub_key else [])]:
                account = self._accounts.setdefault(key, AccountRecord(key=key))
                if team not in account.created:
                    account.created.append(team)
            if owner is not None:
                for email in owner.emails:
                    key = account_key(email)
                    self._accounts.setdefault(key, AccountRecord(key=key)).memberships[team] = (
                        owner.member
                    )
            self._audit.extend(copy.deepcopy(creation.audit))
            self._admin_audit.extend(copy.deepcopy(creation.admin_audit))
            return creation.result

    async def delete_team[T](self, team: str, fn: TeamDeleteFn[T]) -> T:
        async with self._lock:
            current = copy.deepcopy(self._teams.get(team))
            deletion = fn(current)
            if deletion.team is not None:
                if deletion.team.id != team:
                    raise RuntimeError("a deletion may only write its own team")
                was_deleted = current is not None and current.status == TEAM_DELETED
                self._teams[team] = copy.deepcopy(deletion.team)
                creators = (
                    [current.created_by_email_sha256, current.created_by_sub_sha256]
                    if current
                    else []
                )
                if deletion.team.status == TEAM_DELETED and not was_deleted:
                    for creator in filter(None, creators):
                        account = self._accounts.get(creator)
                        if account is not None and team in account.created:
                            account.created.remove(team)
                            if not account.memberships and not account.created:
                                del self._accounts[creator]
            self._admin_audit.extend(copy.deepcopy(deletion.admin_audit))
            return deletion.result

    def _team_documents(self, team: str) -> list[tuple[str, Any]]:
        """Everything under ``teams/{team}`` except its record, as (kind, key) pairs, in
        the order a purge removes them: the roster first (its emails leave the index)."""
        docs: list[tuple[str, Any]] = [("roster", m) for m in sorted(self._roster.get(team, {}))]
        docs += [("credential", k) for (t, k) in sorted(self._credentials) if t == team]
        docs += [("member", k) for k in sorted(self._members) if k[0] == team]
        for key in sorted(self._streams):
            if key[0] == team:
                docs += [("message", (key, seq)) for seq in sorted(self._streams[key].messages)]
                docs.append(("stream", key))
        for key in sorted(self._requests):
            if key[0] == team:
                docs += [("progress", key)] * len(self._progress.get(key, []))
                docs.append(("request", key))
        for key in sorted(self._progress):
            if key[0] == team and key not in self._requests:
                docs += [("progress", key)] * len(self._progress[key])
        docs += [("idempotency", k) for k in sorted(self._idempotency) if k[0] == team]
        docs += [("counter", k) for k in sorted(self._counters) if k[0] == team]
        docs += [("retired", m) for m in sorted(self._retired.get(team, {}))]
        if team in self._boundaries:
            docs.append(("boundaries", team))
        docs += [("audit", i) for i in range(sum(1 for e in self._audit if e.team == team))]
        return docs

    def _remove(self, team: str, kind: str, key: Any) -> None:
        if kind == "roster":
            entry = self._roster[team].pop(key)
            self._index(team, {email: None for email in entry.emails})
        elif kind == "credential":
            del self._credentials[(team, key)]
        elif kind == "member":
            del self._members[key]
        elif kind == "message":
            stream_key, seq = key
            del self._streams[stream_key].messages[seq]
        elif kind == "stream":
            del self._streams[key]
        elif kind == "progress":
            bucket = self._progress[key]
            bucket.pop()
            if not bucket:
                del self._progress[key]
        elif kind == "request":
            del self._requests[key]
        elif kind == "idempotency":
            del self._idempotency[key]
        elif kind == "counter":
            del self._counters[key]
        elif kind == "retired":
            del self._retired[team][key]
        elif kind == "boundaries":
            del self._boundaries[key]
        elif kind == "audit":
            index = next(i for i, e in enumerate(self._audit) if e.team == team)
            del self._audit[index]

    async def purge_team(self, team: str, budget: int) -> bool:
        async with self._lock:
            record = self._teams.get(team)
            if record is None or record.status != TEAM_DELETED:
                return False
            docs = self._team_documents(team)
            for kind, key in docs[:budget]:
                self._remove(team, kind, key)
            if len(docs) > budget:
                return False
            self._roster.pop(team, None)
            self._retired.pop(team, None)
            record.purge_complete = True
            return True

    # Boundaries (M10-SPEC §1) ---------------------------------------------------------
    async def get_boundaries(self, team: str) -> TeamBoundaries | None:
        async with self._lock:
            return copy.deepcopy(self._boundaries.get(team))

    async def set_boundaries[T](
        self, team: str, member: str, fn: BoundariesFn[T], quotas: Sequence[Quota] = ()
    ) -> T:
        async with self._lock:
            record = self._teams.get(team)
            if record is not None and record.status == TEAM_DELETED:
                raise TeamGone(team)
            change = fn(
                copy.deepcopy(self._boundaries.get(team)),
                copy.deepcopy(self._roster.get(team, {}).get(member)),
            )
            if change.boundaries is None:
                return change.result
            self._take(team, quotas)
            self._boundaries[team] = copy.deepcopy(change.boundaries)
            self._audit.extend(copy.deepcopy(change.audit))
            return change.result

    async def get_account(self, email_sha256: str) -> AccountRecord | None:
        async with self._lock:
            return copy.deepcopy(self._accounts.get(email_sha256))

    async def append_admin_audit(self, entries: Sequence[AdminAuditEntry]) -> None:
        async with self._lock:
            self._admin_audit.extend(copy.deepcopy(list(entries)))

    async def list_admin_audit(self, limit: int = 1000) -> list[AdminAuditEntry]:
        async with self._lock:
            return copy.deepcopy(self._admin_audit[:limit])

    # Device credentials ---------------------------------------------------------------
    async def find_credential(self, teams: Sequence[str], key: str) -> CredentialRecord | None:
        async with self._lock:
            for team in teams:
                record = self._credentials.get((team, key))
                if record is not None:
                    return copy.deepcopy(record)
            # The pointer: every credential here was minted by redeem_code, which writes one.
            for (_, k), record in self._credentials.items():
                if k == key:
                    return copy.deepcopy(record)
            return None

    async def touch_credential(
        self, team: str, key: str, last_used_at: datetime, expire_at: datetime
    ) -> None:
        async with self._lock:
            record = self._credentials.get((team, key))
            if record is not None and not record.revoked:
                record.last_used_at = last_used_at
                record.expire_at = expire_at

    async def list_credentials(self, team: str, member: str) -> list[CredentialRecord]:
        async with self._lock:
            return copy.deepcopy(
                [r for (t, _), r in self._credentials.items() if t == team and r.member == member]
            )

    async def revoke_credential(
        self, team: str, key: str, member: str, now: datetime, audit: Sequence[AuditEntry]
    ) -> CredentialRecord | None:
        async with self._lock:
            record = self._credentials.get((team, key))
            if record is None or record.member != member or not record.live(now):
                return None
            record.revoked = True
            record.revoked_at = now
            self._audit.extend(copy.deepcopy(list(audit)))
            return copy.deepcopy(record)

    # Login ----------------------------------------------------------------------------
    async def create_login(self, login: LoginDoc) -> None:
        async with self._lock:
            if login.key in self._logins:
                raise RuntimeError("login id collision")
            self._logins[login.key] = copy.deepcopy(login)

    async def mutate_login[T](self, key: str, fn: LoginFn[T]) -> T:
        async with self._lock:
            change = fn(copy.deepcopy(self._logins.get(key)))
            if change.code is not None and change.code.key in self._codes:
                raise RuntimeError("login code collision")
            if change.login is not None:
                if change.login.key != key:
                    raise RuntimeError("a login change may only write its own login")
                self._logins[key] = copy.deepcopy(change.login)
            if change.code is not None:
                self._codes[change.code.key] = copy.deepcopy(change.code)
            return change.result

    async def redeem_code[T](self, key: str, fn: RedeemFn[T], now: datetime) -> RedeemOutcome[T]:
        async with self._lock:
            plan = fn(copy.deepcopy(self._codes.get(key)))
            if plan.credential is not None:
                team_record = self._teams.get(plan.credential.team)
                if team_record is not None and team_record.status == TEAM_DELETED:
                    raise TeamGone(plan.credential.team)  # before any write
            revoked: list[CredentialRecord] = []
            if plan.code is not None:
                if plan.code.key != key:
                    raise RuntimeError("a redemption may only write its own code")
                self._codes[key] = copy.deepcopy(plan.code)
            if plan.credential is not None:
                cred = plan.credential
                existing = [
                    r
                    for (t, _), r in self._credentials.items()
                    if t == cred.team and r.member == cred.member
                ]
                for record in credentials_over_cap(existing, now, MAX_LIVE_CREDENTIALS - 1):
                    record.revoked = True
                    record.revoked_at = now
                    revoked.append(copy.deepcopy(record))
                if (cred.team, cred.key) in self._credentials:
                    raise RuntimeError("credential collision")
                self._credentials[(cred.team, cred.key)] = copy.deepcopy(cred)
            if plan.revoke is not None:
                record = self._credentials.get(plan.revoke)
                if record is not None and record.live(now):
                    record.revoked = True
                    record.revoked_at = now
                    revoked.append(copy.deepcopy(record))
            self._audit.extend(copy.deepcopy(plan.audit))
            return RedeemOutcome(result=plan.result, revoked=revoked)

    async def count_login_quota(self, quota: Quota) -> bool:
        async with self._lock:
            count = self._login_counters.get(quota.key, 0)
            if count >= quota.limit:
                return False
            self._login_counters[quota.key] = count + 1
            return True
