"""Service logic (M1-SPEC §3, §4, §5, §7; M2-SPEC §3): validation, the per-recipient state
machine, the deadline sweep, the audit trail, presence, tool events, the activity feed and
the directory's stats. Store-agnostic: every atomic step is one call to a
:class:`~relay.store.Store` primitive, and every state change is a pure function handed
to :meth:`~relay.store.Store.mutate_request`.

M11 (M11-SPEC §2-§4): a member's acceptance of the boundaries (their own only: the caller is
always the member it is for), their background answerer's status, the team's status, a
reply's full text kept with its request and handed to the asker only, and the asker's own
recent questions. A delegate (``member-self``) asks questions only, never a capability.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import statistics
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, ValidationError

from .boundaries import boundaries_json, parse_set_body
from .clock import Clock, format_time, truncate_ms, utc_now
from .config import TeamConfig
from .credentials import PUBLIC_ID_RE, Credentials, public_id
from .errors import ApiError, not_found
from .jsonutil import canonical_json, content_digest, sha256_hex
from .log import log_event
from .manifest import ManifestError, ManifestValidator, ParamsError, find_capability
from .manifest import validate_params as check_params
from .member_state import (
    acceptance_json,
    parse_accept_body,
    parse_status_body,
    status_json,
    stored_folder_count,
)
from .models import CreateRequestBody, CursorBody, ProgressBody, ReplyBody, ToolEventBody
from .roster import (
    OWNER,
    Roster,
    entry_json,
    parse_add,
    parse_update,
    plan_add,
    plan_remove,
    plan_update,
)
from .store import (
    STREAMS,
    Acceptance,
    AcceptanceChange,
    AnswerEntry,
    AuditEntry,
    BeyondHead,
    BoundariesChange,
    Envelope,
    IdempotencyRecord,
    MemberStatus,
    Mutation,
    ProgressEntry,
    Quota,
    QuotaExceeded,
    RecipientState,
    RequestDoc,
    RosterEntry,
    StatusChange,
    Store,
    StreamPage,
    TeamBoundaries,
    TeamGone,
    ToolEvent,
)
from .teams import Teams

REQUEST_ID_RE = re.compile(r"^rq_[0-9a-f]{32}$")
MAX_ACK_TIMEOUT = 3600
MAX_ANSWER_TIMEOUT = 86400
MAX_TTL = 2592000
MAX_PROGRESS_PER_RECIPIENT = 200
MAX_TOOL_EVENTS_PER_RECIPIENT = 50  # M2-SPEC §3.3
ANSWER_PREVIEW_CHARS = 2000  # M2-SPEC §3.4, in code points
SWEEP_BATCH = 50
# M2-SPEC §3.1: a poll records presence for its stream at most this often (was 60 s for
# the member-wide last_seen in M1 §3.4).
PRESENCE_INTERVAL = timedelta(seconds=15)
MAX_WAIT_SECONDS = 25
RELAY = "relay"
QUOTA_WINDOW_SECONDS = 60
ROSTER_QUOTA_WINDOW_SECONDS = 3600  # M6-SPEC §2: roster mutations per owner and hour
# GET /credentials lists at most this many of the caller's devices, most recently used first.
MAX_LISTED_CREDENTIALS = 100

# M2-SPEC §3.5, the activity feed.
ACTIVITY_WINDOW = timedelta(hours=24)  # an omitted `since`
ACTIVITY_DEFAULT_LIMIT = 100
ACTIVITY_MAX_LIMIT = 200
# A page never splits the requests that share one updated_at (the next page starts after
# it); when a whole page is one such group, all of it is returned, up to this many.
ACTIVITY_MAX_GROUP = 500
MAX_SINCE_LENGTH = 40
RFC3339 = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$"
)

# M2-SPEC §3.6, the directory's stats: one read of at most this many requests, the most
# recently updated first, over the last 24 hours.
STATS_WINDOW = timedelta(hours=24)
STATS_READ_CAP = 500
# M2-SPEC §7.3: the stats are derived data, not delivery state, so each process keeps a
# team's for this long and serves every member's directory from it.
STATS_CACHE_TTL = timedelta(seconds=10)
# Teams are created at run time (M9-SPEC §1): the stats cache keeps at most this many.
STATS_CACHE_SIZE = 1024


# M11-SPEC §3: a member's status is written at most once per this long, and a member whose
# status arrived within ANSWERING_WINDOW is answering.
STATUS_MIN_INTERVAL = timedelta(seconds=20)
ANSWERING_WINDOW = timedelta(seconds=180)
# M11-SPEC §4: GET me/requests.
MY_REQUESTS_DEFAULT = 20
MY_REQUESTS_MAX = 50
QUESTION_PREVIEW_CHARS = 200  # in code points

# M7-SPEC §1, the inbox summary: at most this many waiting messages are read (a count at the
# cap is reported with "more" when the stream holds later ones), and at most this many
# distinct senders are named.
INBOX_SUMMARY_CAP = 50
INBOX_SUMMARY_SENDERS = 5


EMPTY_STATS: dict[str, Any] = {
    "asked": 0,
    "answered": 0,
    "open": 0,
    "median_answer_seconds": None,
}


def still_open(doc: RequestDoc, state: RecipientState, now: datetime) -> bool:
    """M2-SPEC §7.2: a recipient is open while its relevant deadline is in the future:
    ``pending`` until the ack deadline, ``acked`` until the answer deadline. The feed and
    the directory do not run the sweep, so a stored ``pending`` past its ack deadline is
    one the sweep has not yet turned into ``no_response`` (and ``acked`` into
    ``timed_out``); neither counts as open."""
    if state.status == "pending":
        return now < doc.ack_deadline
    if state.status == "acked":
        return now < doc.answer_deadline
    return False


@dataclass(frozen=True)
class Caller:
    """The member every rule is applied to. ``delegate`` is the principal of the delegate
    acting on the member's behalf (M3-SPEC §2, M6-SPEC §3), for the logs and the audit
    detail only; it changes no rule. ``credential`` is the key of the device credential the
    call authenticated with (M5-SPEC §3), if it did. ``email`` is the Google email the call
    came as (an ID token's, or the one a delegate names), None for a device credential or a
    static token: deleting a team needs one (M9-SPEC §7.7)."""

    team: str
    member: str
    delegate: str | None = None
    credential: str | None = None
    email: str | None = None


@dataclass(frozen=True)
class _TeamStats:
    """One team's directory stats as computed at ``at`` (M2-SPEC §7.3), with each member's
    count of waiting inbox messages (M7-SPEC §1), cached with them."""

    at: datetime
    members: dict[str, dict[str, Any]]
    complete: bool
    waiting: dict[str, int]


def new_request_id() -> str:
    return "rq_" + secrets.token_hex(16)


def new_message_id() -> str:
    return "msg_" + secrets.token_hex(16)


def envelope_json(env: Envelope) -> dict[str, Any]:
    return {
        "id": env.id,
        "seq": env.seq,
        "team": env.team,
        "stream": env.stream,
        "type": env.type,
        "from": env.sender,
        "to": env.to,
        "request_id": env.request_id,
        "broadcast": env.broadcast,
        "time": format_time(env.time),
        "expire_at": format_time(env.expire_at),
        "data": env.data,
    }


def next_deadline(doc: RequestDoc) -> datetime | None:
    """The earliest deadline that can still fire for any recipient, or None (§4)."""
    candidates = []
    for state in doc.recipients.values():
        if state.status == "pending":
            candidates.append(doc.ack_deadline)
        elif state.status == "acked":
            candidates.append(doc.answer_deadline)
    candidates = [d for d in candidates if d < doc.expire_at]
    return min(candidates) if candidates else None


def parse_body[M: BaseModel](model: type[M], raw: Any) -> M:
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "(body)"
        raise ApiError(422, "invalid_body", f"{where}: {first['msg']}") from None


def _parse_since(raw: str) -> datetime:
    """An RFC 3339 time with a zone (``Z`` or an offset), as an aware UTC datetime.
    Fractions beyond microseconds are dropped (truncated, never rounded up)."""
    match = RFC3339.match(raw) if len(raw) <= MAX_SINCE_LENGTH else None
    if match is None:
        raise ApiError(400, "invalid_query", "since must be an RFC 3339 time with a zone")
    date, clock, fraction, zone = match.groups()
    text = f"{date}T{clock}"
    if fraction:
        text += "." + fraction[:6].ljust(6, "0")
    text += "+00:00" if zone in ("Z", "z") else zone
    try:
        return datetime.fromisoformat(text).astimezone(UTC)
    except ValueError:
        raise ApiError(400, "invalid_query", "since must be an RFC 3339 time with a zone") from None


def _parse_int(raw: str | None, name: str, low: int, high: int | None) -> int | None:
    if raw is None:
        return None
    # ASCII digits only: str.isdigit() also admits "²" and other digits int() refuses.
    if not (raw.isascii() and raw.isdigit()) or len(raw) > 12:
        raise ApiError(400, "invalid_query", f"{name} must be an integer")
    value = int(raw)
    if value < low or (high is not None and value > high):
        bound = f"{low}..{high}" if high is not None else f">= {low}"
        raise ApiError(400, "invalid_query", f"{name} must be {bound}")
    return value


class RelayService:
    def __init__(
        self,
        config: TeamConfig,
        store: Store,
        manifests: ManifestValidator,
        clock: Clock = utc_now,
        poll_interval: float = 1.0,
    ) -> None:
        self.config = config
        self.store = store
        self.manifests = manifests
        self._clock = clock
        self._poll_interval = poll_interval
        self._retention = timedelta(days=config.audit_retention_days)
        # In-process only (§11.7): concurrent long-polls per (team, member, stream). This is
        # protective, not delivery state; a lost count only ever lasts one process.
        self._polls: dict[tuple[str, str, str], int] = {}
        # In-process only (M2-SPEC §7.3): the directory's stats per team, for
        # STATS_CACHE_TTL, the STATS_CACHE_SIZE most recently used teams.
        self._stats_cache: OrderedDict[str, _TeamStats] = OrderedDict()
        # M6-SPEC §1: membership comes from the roster in the store, cached per team.
        self.roster = Roster(config, store, self.now)
        # M5-SPEC §3: device credentials, cached for at most 60 s.
        self.credentials = Credentials(store, config.team_ids(), self.now)
        # M9-SPEC §1: which teams exist, creating and deleting them.
        self.teams = Teams(config, store, self.roster, self.credentials, self.now)

    # Helpers -------------------------------------------------------------------------------
    def now(self) -> datetime:
        return truncate_ms(self._clock())

    @staticmethod
    def _quota(member: str, name: str, limit: int, now: datetime) -> Quota:
        """The per-member counter ``name`` for the fixed minute that holds ``now``."""
        start = int(now.timestamp()) // QUOTA_WINDOW_SECONDS * QUOTA_WINDOW_SECONDS
        return Quota(
            key=f"{member}.{name}.{start}",
            limit=limit,
            expire_at=datetime.fromtimestamp(start + 2 * QUOTA_WINDOW_SECONDS, UTC),
        )

    def _audit(
        self, team: str, actor: str, action: str, outcome: str, now: datetime, **fields: Any
    ) -> AuditEntry:
        return AuditEntry(
            time=now,
            team=team,
            actor=actor,
            action=action,
            outcome=outcome,
            expire_at=now + self._retention,
            **fields,
        )

    def _delivery_audit(self, env: Envelope, actor: str, action: str, now: datetime) -> AuditEntry:
        digest, length = content_digest(env.data)
        return self._audit(
            env.team,
            actor,
            action,
            "delivered",
            now,
            request_id=env.request_id,
            message_id=env.id,
            envelope_type=env.type,
            to=[env.to],
            content_sha256=digest,
            content_length=length,
        )

    async def audit_refusal(
        self, caller: Caller, action: str, err: ApiError, request_id: str | None = None
    ) -> None:
        # The detail is the error code only: refusal details can echo caller input.
        now = self.now()
        detail = f"{err.status} {err.code}"
        entry = self._audit(
            caller.team,
            caller.member,
            action,
            "refused",
            now,
            request_id=request_id,
            detail=detail,
        )
        limit = self.config.limits.audited_refusals_per_minute
        quota = self._quota(caller.member, "refused", limit, now)
        if not await self.store.append_audit_capped(caller.team, [entry], quota):
            # Over the per-minute cap (§11.7): stdout only, so refusals cannot flood the audit.
            log_event(
                "refusal_not_audited",
                severity="WARNING",
                team=caller.team,
                actor=caller.member,
                action=action,
                detail=detail,
                request_id=request_id if request_id and REQUEST_ID_RE.match(request_id) else None,
            )

    async def _guarded(
        self,
        caller: Caller,
        action: str,
        request_id: str | None,
        work: Callable[[], Awaitable[Any]],
    ) -> Any:
        """Run a mutation; file an audit entry for every refusal (§7)."""
        try:
            return await work()
        except ApiError as err:
            if 400 <= err.status < 500:
                await self.audit_refusal(caller, action, err, request_id)
            raise

    async def _mutate[T](
        self,
        team: str,
        request_id: str,
        now: datetime,
        fn: Callable[[RequestDoc | None], Mutation[T]],
    ) -> T:
        """:meth:`Store.mutate_request`, stamping ``updated_at = now`` on every request the
        function writes (M2-SPEC §3.5: set on every change). The store raises it to the
        stored value plus 1 ms when ``now`` is not later (§7.1), inside the transaction."""

        def stamped(doc: RequestDoc | None) -> Mutation[T]:
            mutation = fn(doc)
            if mutation.request is not None:
                mutation.request.updated_at = now
            return mutation

        return await self.store.mutate_request(team, request_id, stamped)

    async def _members(self, team: str) -> tuple[str, ...]:
        return (await self.roster.snapshot(team)).members()

    async def _teammates(self, caller: Caller) -> list[str]:
        return [m for m in await self._members(caller.team) if m != caller.member]

    @staticmethod
    def _recipient(doc: RequestDoc | None, caller: Caller) -> tuple[RequestDoc, RecipientState]:
        # 404, not 403, for a non-recipient: request ids are not probeable (§3.8).
        if doc is None or caller.member not in doc.recipients:
            raise not_found()
        return doc, doc.recipients[caller.member]

    # §3.2 ----------------------------------------------------------------------------------
    async def me(self, caller: Caller) -> dict[str, Any]:
        roster = await self.roster.snapshot(caller.team)
        return {
            "team": caller.team,
            # M9-SPEC §1: the team's display name (the id for a file team without one).
            "name": await self.teams.name(caller.team),
            "member": caller.member,
            "teammates": [m for m in roster.members() if m != caller.member],
            # M6-SPEC §4: the console shows owners the Members panel.
            "role": roster.role(caller.member),
        }

    # §3.3 ----------------------------------------------------------------------------------
    async def publish_manifest(self, caller: Caller, member: str, raw: Any) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            if member != caller.member:
                raise ApiError(403, "forbidden", "You can only publish your own manifest.")
            try:
                names = self.manifests.validate(raw)
            except ManifestError as exc:
                raise ApiError(422, "invalid_manifest", str(exc)) from None
            now = self.now()
            digest, length = content_digest(raw)
            entry = self._audit(
                caller.team,
                caller.member,
                "manifest.publish",
                "published",
                now,
                content_sha256=digest,
                content_length=length,
            )
            await self.store.put_manifest(caller.team, caller.member, raw, now, [entry])
            return {"published_at": format_time(now), "capabilities": names}

        return await self._guarded(caller, "manifest.publish", None, work)

    # §3.4, M2 §3.1, §3.6 --------------------------------------------------------------------
    async def _count_read(self, caller: Caller, endpoint: str) -> None:
        """M2-SPEC §7.3: one against the member's read budget for this minute, shared by
        ``/activity`` and ``/directory`` and counted in the store like the other limits, so
        it holds across instances. Over it: ``429 rate_limited``. A read is not a mutation,
        so a refused one goes to stdout only, never to the audit log."""
        limit = self.config.limits.reads_per_minute
        quota = self._quota(caller.member, "reads", limit, self.now())
        if await self.store.count_quota(caller.team, quota):
            return
        log_event(
            "read_refused",
            severity="WARNING",
            team=caller.team,
            member=caller.member,
            endpoint=endpoint,
            **({"delegate": caller.delegate} if caller.delegate else {}),
        )
        raise ApiError(
            429,
            "rate_limited",
            f"At most {limit} reads of the activity feed, the directory and the inbox summary "
            "a minute; "
            "try again shortly.",
        )

    async def directory(self, caller: Caller) -> dict[str, Any]:
        await self._count_read(caller, "directory")
        teammates = await self._teammates(caller)
        docs = await self.store.get_members(caller.team, teammates)
        stats = await self._team_stats(caller.team)
        members = []
        for m in teammates:
            doc = docs.get(m)
            inbox = doc.presence.get("inbox") if doc else None
            replies = doc.presence.get("replies") if doc else None
            seen = [t for t in (doc.last_seen if doc else None, inbox, replies) if t is not None]
            members.append(
                {
                    "member": m,
                    # Kept for M1 clients: the later of the two sessions (M2-SPEC §3.1).
                    "last_seen": format_time(max(seen)) if seen else None,
                    "manifest": doc.manifest if doc else None,
                    "published_at": format_time(doc.published_at) if doc else None,
                    "sessions": {
                        "working": {"last_seen": format_time(replies)},
                        "answering": {"last_seen": format_time(inbox)},
                    },
                    # A member added since the cached stats were computed has none yet.
                    "stats": dict(stats.members.get(m) or EMPTY_STATS),
                    # M7-SPEC §1: unexpired messages past their inbox cursor, at most 50.
                    "inbox_waiting": stats.waiting.get(m, 0),
                }
            )
        # False when the 24-hour window held more requests than one stats read covers
        # (STATS_READ_CAP): the counts then cover the most recently updated ones only.
        return {"members": members, "stats_complete": stats.complete}

    async def _team_stats(self, team: str) -> _TeamStats:
        """The team's stats, from the cache while they are younger than STATS_CACHE_TTL by
        the service clock (M2-SPEC §7.3), else computed now and cached. A clock that went
        backwards past the cached time makes the entry stale, never fresher. Presence and
        manifests are never cached. Two concurrent misses may both compute; the later one
        is kept."""
        now = self.now()
        cached = self._stats_cache.get(team)
        if cached is not None and timedelta(0) <= now - cached.at < STATS_CACHE_TTL:
            return cached
        roster = list(await self._members(team))
        members, complete = await self._stats(team, roster, now)
        waiting: dict[str, int] = {}
        for m in roster:
            messages, _ = await self._inbox_waiting(team, m, now)
            waiting[m] = len(messages)
        fresh = _TeamStats(at=now, members=members, complete=complete, waiting=waiting)
        self._stats_cache[team] = fresh
        self._stats_cache.move_to_end(team)
        while len(self._stats_cache) > STATS_CACHE_SIZE:
            self._stats_cache.popitem(last=False)
        return fresh

    async def _inbox_waiting(
        self, team: str, member: str, now: datetime
    ) -> tuple[list[Envelope], bool]:
        """M7-SPEC §1: the unexpired messages after the member's inbox cursor, at most
        INBOX_SUMMARY_CAP, oldest first, and whether the stream holds later ones beyond that
        read. A peek: it never moves the cursor, stamps nothing and writes no presence."""
        page = await self.store.read_stream(
            team, member, "inbox", None, INBOX_SUMMARY_CAP, now, advance=False
        )
        messages = page.messages
        more = len(messages) >= INBOX_SUMMARY_CAP and messages[-1].seq < page.head
        return messages, more

    async def inbox_summary(self, caller: Caller) -> dict[str, Any]:
        """M7-SPEC §1: what waits in the caller's inbox for their answering session, and when
        that session last polled. Counts against the read budget; never writes presence and
        never moves a cursor, so any session (or a delegate) may ask."""
        await self._count_read(caller, "inbox_summary")
        now = self.now()
        messages, more = await self._inbox_waiting(caller.team, caller.member, now)
        docs = await self.store.get_members(caller.team, [caller.member])
        doc = docs.get(caller.member)
        answering = doc.presence.get("inbox") if doc else None
        senders = list(dict.fromkeys(env.sender for env in messages))[:INBOX_SUMMARY_SENDERS]
        return {
            "pending": len(messages),
            "more": more,
            "oldest_at": format_time(messages[0].time) if messages else None,
            "from": senders,
            "answering": {"last_seen": format_time(answering)},
        }

    async def _stats(
        self, team: str, members: list[str], now: datetime
    ) -> tuple[dict[str, dict[str, Any]], bool]:
        """M2-SPEC §3.6, per member, over the last 24 hours: ``asked`` (requests created),
        ``answered`` (replies given), ``open`` (requests where they are a recipient still
        ``pending`` or ``acked`` with that status's deadline in the future, §7.2) and
        ``median_answer_seconds`` (from a request's creation to their reply). One read of the
        most recently updated requests, at most STATS_READ_CAP; expired requests are left
        out, as everywhere else."""
        start = now - STATS_WINDOW
        docs = await self.store.requests_updated_after(team, start, STATS_READ_CAP, descending=True)
        asked = dict.fromkeys(members, 0)
        answered = dict.fromkeys(members, 0)
        open_ = dict.fromkeys(members, 0)
        durations: dict[str, list[float]] = {m: [] for m in members}
        for doc in docs:
            if now >= doc.expire_at:
                continue
            if doc.asker in asked and doc.created_at >= start:
                asked[doc.asker] += 1
            for m, state in doc.recipients.items():
                if m not in answered:
                    continue
                if state.answered_at is not None and state.answered_at >= start:
                    answered[m] += 1
                    durations[m].append((state.answered_at - doc.created_at).total_seconds())
                if still_open(doc, state, now):
                    open_[m] += 1
        stats = {
            m: {
                "asked": asked[m],
                "answered": answered[m],
                "open": open_[m],
                "median_answer_seconds": (
                    round(statistics.median(durations[m]), 3) if durations[m] else None
                ),
            }
            for m in members
        }
        return stats, len(docs) < STATS_READ_CAP

    # §3.5 ----------------------------------------------------------------------------------
    async def create_request(self, caller: Caller, raw: Any) -> tuple[int, dict[str, Any]]:
        return await self._guarded(
            caller, "request.create", None, lambda: self._create_request(caller, raw)
        )

    def _check_timeouts(self, body: CreateRequestBody) -> None:
        lim = self.config.limits
        checks = [
            (
                "ack_timeout_seconds",
                body.ack_timeout_seconds,
                lim.min_ack_timeout_seconds,
                MAX_ACK_TIMEOUT,
            ),
            (
                "answer_timeout_seconds",
                body.answer_timeout_seconds,
                lim.min_answer_timeout_seconds,
                MAX_ANSWER_TIMEOUT,
            ),
            ("ttl_seconds", body.ttl_seconds, body.answer_timeout_seconds, MAX_TTL),
        ]
        for name, value, low, high in checks:
            if not low <= value <= high:
                raise ApiError(422, "invalid_body", f"{name}: must be within {low}..{high}")
        if body.ack_timeout_seconds > body.answer_timeout_seconds:
            raise ApiError(
                422,
                "invalid_timeouts",
                "ack_timeout_seconds must not be greater than answer_timeout_seconds.",
            )

    def _replay(self, record: IdempotencyRecord, body_hash: str) -> tuple[int, dict[str, Any]]:
        if record.body_hash != body_hash:
            raise ApiError(
                409, "idempotency_conflict", "This idempotency key was used for another body."
            )
        return 200, {
            "request_id": record.request_id,
            "recipients": list(record.recipients),
            "created": False,
            "ack_deadline": format_time(record.ack_deadline),
            "answer_deadline": format_time(record.answer_deadline),
            "expire_at": format_time(record.expire_at),
        }

    async def _resolve_recipients(
        self, caller: Caller, body: CreateRequestBody
    ) -> tuple[list[str], bool]:
        members = set(await self._members(caller.team))
        if body.to == "*":
            if body.kind == "capability":
                raise ApiError(
                    400, "broadcast_capability", "Capabilities can only be invoked on one member."
                )
            recipients = [m for m in sorted(members) if m != caller.member]
            if not recipients:
                raise ApiError(400, "bad_recipients", "You have no teammates to broadcast to.")
            return recipients, True
        to = list(body.to)
        if not to:
            raise ApiError(400, "bad_recipients", "'to' is empty.")
        if len(set(to)) != len(to):
            raise ApiError(400, "bad_recipients", "'to' names a member twice.")
        if caller.member in to:
            raise ApiError(400, "bad_recipients", "You cannot send a request to yourself.")
        if any(m not in members for m in to):
            raise ApiError(400, "bad_recipients", "'to' names someone who is not in your team.")
        if body.kind == "capability" and len(to) != 1:
            raise ApiError(400, "bad_recipients", "A capability call needs exactly one recipient.")
        return to, False

    async def _resolve_capability(
        self, caller: Caller, recipient: str, body: CreateRequestBody
    ) -> dict[str, Any]:
        assert body.capability is not None
        docs = await self.store.get_members(caller.team, [recipient])
        doc = docs.get(recipient)
        cap = find_capability(doc.manifest if doc else None, body.capability.name)
        if cap is None:
            raise ApiError(
                404,
                "unknown_capability",
                f"{recipient} has not published a capability named {body.capability.name}.",
            )
        try:
            params = check_params(cap, body.capability.params)
        except ParamsError as exc:
            raise ApiError(422, "invalid_params", str(exc)) from None
        return {"name": cap["name"], "params": params, "environment": cap["environment"]}

    async def _create_request(self, caller: Caller, raw: Any) -> tuple[int, dict[str, Any]]:
        body = parse_body(CreateRequestBody, raw)
        if caller.delegate is not None and body.kind != "question":
            # M11-SPEC §4: the console asks questions for its viewer, never a capability call.
            raise ApiError(403, "forbidden", "A delegate may only ask questions.")
        self._check_timeouts(body)
        # The hash covers the validated body with the relay's defaults for the timeouts,
        # but not the capability defaults: those depend on a manifest that may change
        # between a request and its retry.
        canonical = canonical_json(body.model_dump(mode="json", exclude={"idempotency_key"}))
        body_hash = sha256_hex(canonical)
        key_id = sha256_hex(f"{caller.team}|{caller.member}|{body.idempotency_key}")

        now = self.now()
        existing = await self.store.get_idempotency(caller.team, key_id, now)
        if existing is not None:
            return await self._replay_audited(caller, existing, body_hash, now)

        recipients, broadcast = await self._resolve_recipients(caller, body)
        capability = None
        if body.kind == "capability":
            capability = await self._resolve_capability(caller, recipients[0], body)

        request_id = new_request_id()
        ack_deadline = now + timedelta(seconds=body.ack_timeout_seconds)
        answer_deadline = now + timedelta(seconds=body.answer_timeout_seconds)
        expire_at = now + timedelta(seconds=body.ttl_seconds)
        doc = RequestDoc(
            request_id=request_id,
            team=caller.team,
            kind=body.kind,
            asker=caller.member,
            broadcast=broadcast,
            question=body.question,
            capability=capability,
            created_at=now,
            ack_deadline=ack_deadline,
            answer_deadline=answer_deadline,
            expire_at=expire_at,
            next_deadline=None,
            recipients={m: RecipientState() for m in recipients},
            updated_at=now,
        )
        doc.next_deadline = next_deadline(doc)

        deadlines = {
            "ack_deadline": format_time(ack_deadline),
            "answer_deadline": format_time(answer_deadline),
        }
        if capability is None:
            env_type = "question"
            data: dict[str, Any] = {"question": body.question, **deadlines}
        else:
            env_type = "capability_call"
            data = {
                "capability": capability["name"],
                "params": capability["params"],
                "environment": capability["environment"],
                **deadlines,
            }
        envelopes = [
            Envelope(
                id=new_message_id(),
                team=caller.team,
                stream="inbox",
                type=env_type,
                sender=caller.member,
                to=m,
                request_id=request_id,
                broadcast=broadcast,
                time=now,
                expire_at=expire_at,
                data=dict(data),
            )
            for m in recipients
        ]
        audit = [
            self._audit(
                caller.team,
                caller.member,
                "request.create",
                "created",
                now,
                request_id=request_id,
                to=list(recipients),
                content_sha256=body_hash,
                content_length=len(canonical.encode("utf-8")),
                detail="via delegate" if caller.delegate else None,
            )
        ]
        audit += [
            self._delivery_audit(env, caller.member, "envelope.deliver", now) for env in envelopes
        ]
        record = IdempotencyRecord(
            request_id=request_id,
            body_hash=body_hash,
            recipients=list(recipients),
            ack_deadline=ack_deadline,
            answer_deadline=answer_deadline,
            expire_at=expire_at,
        )
        limits = self.config.limits
        quotas = [self._quota(caller.member, "requests", limits.requests_per_minute, now)]
        if broadcast:
            quotas.append(
                self._quota(caller.member, "broadcasts", limits.broadcasts_per_minute, now)
            )
        try:
            outcome = await self.store.create_request(
                caller.team, key_id, record, doc, envelopes, audit, now, quotas
            )
        except QuotaExceeded as exc:
            what = "requests" if exc.quota.key == quotas[0].key else "broadcasts"
            raise ApiError(
                429,
                "rate_limited",
                f"At most {exc.quota.limit} {what} a minute; try again shortly.",
            ) from None
        if not outcome.created:  # a concurrent call with the same key won the race
            return await self._replay_audited(caller, outcome.record, body_hash, now)
        return 201, {
            "request_id": request_id,
            "recipients": list(recipients),
            "created": True,
            "ack_deadline": format_time(ack_deadline),
            "answer_deadline": format_time(answer_deadline),
            "expire_at": format_time(expire_at),
        }

    async def _replay_audited(
        self, caller: Caller, record: IdempotencyRecord, body_hash: str, now: datetime
    ) -> tuple[int, dict[str, Any]]:
        status, payload = self._replay(record, body_hash)  # raises 409 on a different body
        entry = self._audit(
            caller.team,
            caller.member,
            "request.create",
            "replayed",
            now,
            request_id=record.request_id,
            to=list(record.recipients),
            content_sha256=body_hash,
        )
        await self.store.append_audit([entry])
        return status, payload

    # §3.6, §3.7 ----------------------------------------------------------------------------
    async def read_stream(
        self,
        caller: Caller,
        stream: str,
        after_raw: str | None,
        wait_raw: str | None,
        limit_raw: str | None,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> dict[str, Any]:
        if stream not in STREAMS:
            raise not_found()
        after = _parse_int(after_raw, "after", 0, None)
        wait = _parse_int(wait_raw, "wait", 0, MAX_WAIT_SECONDS) or 0
        limit = _parse_int(limit_raw, "limit", 1, 100) or 50

        if wait == 0:
            page = await self._read_once(caller, stream, after, limit, 0, is_disconnected)
        else:
            key = (caller.team, caller.member, stream)
            if self._polls.get(key, 0) >= self.config.limits.concurrent_polls:
                log_event(
                    "poll_refused",
                    severity="WARNING",
                    team=caller.team,
                    member=caller.member,
                    stream=stream,
                )
                raise ApiError(
                    429,
                    "too_many_polls",
                    f"At most {self.config.limits.concurrent_polls} long-polls at once "
                    "on one stream.",
                )
            self._polls[key] = self._polls.get(key, 0) + 1
            try:
                page = await self._read_once(caller, stream, after, limit, wait, is_disconnected)
            finally:
                self._polls[key] -= 1
                if self._polls[key] <= 0:
                    del self._polls[key]
        return {
            "messages": [envelope_json(env) for env in page.messages],
            "cursor": page.cursor,
            "head": page.head,
        }

    async def _read_once(
        self,
        caller: Caller,
        stream: str,
        after: int | None,
        limit: int,
        wait: int,
        is_disconnected: Callable[[], Awaitable[bool]],
    ) -> StreamPage:
        # Presence per stream (M2-SPEC §3.1): inbox is the answering session, replies the
        # working session.
        await self.store.touch_presence(
            caller.team, caller.member, stream, self.now(), PRESENCE_INTERVAL
        )
        started = time.monotonic()
        while True:
            if stream == "replies":
                await self.sweep_asker(caller.team, caller.member)
            page = await self.store.read_stream(
                caller.team, caller.member, stream, after, limit, self.now()
            )
            remaining = wait - (time.monotonic() - started)
            if page.messages or remaining <= 0:
                return page
            await asyncio.sleep(min(self._poll_interval, remaining))
            if await is_disconnected():
                return page

    async def set_cursor(self, caller: Caller, stream: str, raw: Any) -> dict[str, Any]:
        # Transport bookkeeping: not audited (§3.7).
        if stream not in STREAMS:
            raise not_found()
        body = parse_body(CursorBody, raw)
        try:
            cursor = await self.store.set_cursor(
                caller.team, caller.member, stream, body.acked_seq, self.now()
            )
        except BeyondHead:
            raise ApiError(400, "beyond_head", "acked_seq is beyond the stream head.") from None
        return {"cursor": cursor}

    # §3.8 ----------------------------------------------------------------------------------
    async def ack(self, caller: Caller, request_id: str) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            if not REQUEST_ID_RE.match(request_id):
                raise not_found()
            now = self.now()

            def fn(doc: RequestDoc | None) -> Mutation[str]:
                doc, state = self._recipient(doc, caller)
                if now >= doc.expire_at:
                    raise ApiError(410, "expired", "The request has expired.")
                if state.status in ("pending", "no_response"):
                    before = state.status
                    state.status = "acked"
                    state.acked_at = now
                    doc.next_deadline = next_deadline(doc)
                    entry = self._audit(
                        caller.team,
                        caller.member,
                        "request.ack",
                        "acked",
                        now,
                        request_id=request_id,
                        detail=f"from {before}",
                    )
                    return Mutation(result="acked", request=doc, audit=[entry])
                entry = self._audit(
                    caller.team,
                    caller.member,
                    "request.ack",
                    "unchanged",
                    now,
                    request_id=request_id,
                    detail=f"already {state.status}",
                )
                return Mutation(result=state.status, audit=[entry])

            status = await self._mutate(caller.team, request_id, now, fn)
            return {"status": status}

        return await self._guarded(caller, "request.ack", request_id, work)

    # §3.9 ----------------------------------------------------------------------------------
    async def reply(self, caller: Caller, request_id: str, raw: Any) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            if not REQUEST_ID_RE.match(request_id):
                raise not_found()
            body = parse_body(ReplyBody, raw)
            now = self.now()
            content = {"text": body.text, "data": body.data}
            digest, length = content_digest(content)

            def fn(doc: RequestDoc | None) -> Mutation[str]:
                doc, state = self._recipient(doc, caller)
                if now >= doc.expire_at:
                    raise ApiError(410, "expired", "The request has expired.")
                if state.status == "answered":
                    if state.reply_key == body.idempotency_key:
                        entry = self._audit(
                            caller.team,
                            caller.member,
                            "request.reply",
                            "replayed",
                            now,
                            request_id=request_id,
                            message_id=state.reply_message_id,
                            content_sha256=digest,
                            content_length=length,
                        )
                        return Mutation(result=state.reply_message_id or "", audit=[entry])
                    raise ApiError(409, "already_answered", "You have already answered this.")
                before = state.status
                message_id = new_message_id()
                state.status = "answered"
                state.answered_at = now
                if state.acked_at is None:
                    state.acked_at = now  # a reply implies an ack
                state.reply_key = body.idempotency_key
                state.reply_message_id = message_id
                state.answer_preview = body.text[:ANSWER_PREVIEW_CHARS]  # code points
                # M11-SPEC §4: the full text, below the request, for as long as it lives.
                answer = AnswerEntry(member=caller.member, text=body.text, expire_at=doc.expire_at)
                doc.next_deadline = next_deadline(doc)
                env = Envelope(
                    id=message_id,
                    team=caller.team,
                    stream="replies",
                    type="answer",
                    sender=caller.member,
                    to=doc.asker,
                    request_id=request_id,
                    broadcast=doc.broadcast,
                    time=now,
                    expire_at=doc.expire_at,
                    data=content,
                )
                audit = [
                    self._audit(
                        caller.team,
                        caller.member,
                        "request.reply",
                        "answered",
                        now,
                        request_id=request_id,
                        message_id=message_id,
                        envelope_type="answer",
                        to=[doc.asker],
                        content_sha256=digest,
                        content_length=length,
                        detail=f"from {before}",
                    ),
                    self._delivery_audit(env, caller.member, "envelope.deliver", now),
                ]
                return Mutation(
                    result=message_id,
                    request=doc,
                    envelopes=[env],
                    audit=audit,
                    answers=[answer],
                )

            message_id = await self._mutate(caller.team, request_id, now, fn)
            return {"status": "answered", "message_id": message_id}

        return await self._guarded(caller, "request.reply", request_id, work)

    # §3.10 ---------------------------------------------------------------------------------
    async def progress(self, caller: Caller, request_id: str, raw: Any) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            if not REQUEST_ID_RE.match(request_id):
                raise not_found()
            body = parse_body(ProgressBody, raw)
            now = self.now()
            digest, length = content_digest({"text": body.text, "pct": body.pct})

            def fn(doc: RequestDoc | None) -> Mutation[int]:
                doc, state = self._recipient(doc, caller)
                if now >= doc.expire_at:
                    raise ApiError(410, "expired", "The request has expired.")
                if state.progress_count >= MAX_PROGRESS_PER_RECIPIENT:
                    raise ApiError(429, "too_much_progress", "At most 200 progress events.")
                doc.progress_head += 1
                state.progress_count += 1
                if body.pct is not None:
                    state.last_progress_pct = body.pct
                entry = ProgressEntry(
                    seq=doc.progress_head,
                    member=caller.member,
                    text=body.text,
                    pct=body.pct,
                    time=now,
                    expire_at=doc.expire_at,
                )
                audit = self._audit(
                    caller.team,
                    caller.member,
                    "request.progress",
                    "recorded",
                    now,
                    request_id=request_id,
                    content_sha256=digest,
                    content_length=length,
                )
                # Progress never becomes an envelope: nothing is written to any stream.
                return Mutation(result=entry.seq, request=doc, progress=[entry], audit=[audit])

            seq = await self._mutate(caller.team, request_id, now, fn)
            return {"seq": seq}

        return await self._guarded(caller, "request.progress", request_id, work)

    # M2 §3.3 -------------------------------------------------------------------------------
    async def tool_event(self, caller: Caller, request_id: str, raw: Any) -> dict[str, Any]:
        """Record one tool use of the recipient's answering session: on the recipient's
        entry and in the progress list (``kind="tool"``). Like progress, it never becomes
        an envelope, it is audited, and it is capped per recipient."""

        async def work() -> dict[str, Any]:
            if not REQUEST_ID_RE.match(request_id):
                raise not_found()
            body = parse_body(ToolEventBody, raw)
            now = self.now()
            digest, length = content_digest(
                {"tool": body.tool, "status": body.status, "duration_ms": body.duration_ms}
            )

            def fn(doc: RequestDoc | None) -> Mutation[int]:
                doc, state = self._recipient(doc, caller)
                if now >= doc.expire_at:
                    raise ApiError(410, "expired", "The request has expired.")
                if len(state.tools) >= MAX_TOOL_EVENTS_PER_RECIPIENT:
                    raise ApiError(
                        429,
                        "too_many_tool_events",
                        f"At most {MAX_TOOL_EVENTS_PER_RECIPIENT} tool events.",
                    )
                doc.progress_head += 1
                state.tools.append(
                    ToolEvent(
                        tool=body.tool, status=body.status, at=now, duration_ms=body.duration_ms
                    )
                )
                entry = ProgressEntry(
                    seq=doc.progress_head,
                    member=caller.member,
                    kind="tool",
                    text=None,
                    pct=None,
                    tool=body.tool,
                    status=body.status,
                    duration_ms=body.duration_ms,
                    time=now,
                    expire_at=doc.expire_at,
                )
                audit = self._audit(
                    caller.team,
                    caller.member,
                    "request.event",
                    "recorded",
                    now,
                    request_id=request_id,
                    content_sha256=digest,
                    content_length=length,
                )
                # Never an envelope: nothing is written to any stream, nothing is pushed.
                return Mutation(result=entry.seq, request=doc, progress=[entry], audit=[audit])

            seq = await self._mutate(caller.team, request_id, now, fn)
            return {"seq": seq}

        return await self._guarded(caller, "request.event", request_id, work)

    # §3.11 ---------------------------------------------------------------------------------
    async def get_request(self, caller: Caller, request_id: str) -> dict[str, Any]:
        if not REQUEST_ID_RE.match(request_id):
            raise not_found()
        doc = await self.store.get_request(caller.team, request_id)
        if doc is None or (caller.member != doc.asker and caller.member not in doc.recipients):
            raise not_found()
        now = self.now()
        if doc.next_deadline is not None and doc.next_deadline <= now:
            await self._mutate(caller.team, request_id, now, self._sweep_fn(now))
            doc = await self.store.get_request(caller.team, request_id)
            if doc is None:
                raise not_found()
        if now >= doc.expire_at:
            raise not_found()  # reads treat expired documents as gone (TTL is lazy)

        is_asker = caller.member == doc.asker
        visible = {m: s for m, s in doc.recipients.items() if is_asker or m == caller.member}
        # M11-SPEC §4: the full answers, to the asker only (a delegate reads them only for the
        # asker it acts for: the caller is the member it names).
        answers: dict[str, str] = {}
        if is_asker and any(s.status == "answered" for s in visible.values()):
            answers = await self.store.list_answers(caller.team, request_id)
        progress = [
            p
            for p in await self.store.list_progress(caller.team, request_id)
            if is_asker or p.member == caller.member
        ]
        return {
            "request_id": doc.request_id,
            "kind": doc.kind,
            "asker": doc.asker,
            "broadcast": doc.broadcast,
            "question": doc.question,
            "capability": doc.capability,
            "created_at": format_time(doc.created_at),
            "ack_deadline": format_time(doc.ack_deadline),
            "answer_deadline": format_time(doc.answer_deadline),
            "expire_at": format_time(doc.expire_at),
            "recipients": {
                m: {
                    "status": s.status,
                    "acked_at": format_time(s.acked_at),
                    "answered_at": format_time(s.answered_at),
                    "answer_preview": s.answer_preview,
                    "answer": answers.get(m) if is_asker else None,
                }
                for m, s in visible.items()
            },
            # One shape for both kinds (M2-SPEC §3.3): a progress event carries text and
            # pct, a tool event tool, status and duration_ms; the rest are null.
            "progress": [
                {
                    "seq": p.seq,
                    "member": p.member,
                    "kind": p.kind,
                    "text": p.text,
                    "pct": p.pct,
                    "tool": p.tool,
                    "status": p.status,
                    "duration_ms": p.duration_ms,
                    "time": format_time(p.time),
                }
                for p in progress
            ],
        }

    # M2 §3.5 -------------------------------------------------------------------------------
    async def activity(
        self, caller: Caller, since_raw: str | None, limit_raw: str | None
    ) -> dict[str, Any]:
        """The team's requests changed after ``since``, ascending by ``updated_at``.

        Metadata is visible to every member of the team; the question, the capability
        params and the answer previews only to participants. A recipient sees their own
        answer preview and the asker sees every one (as in §3.11, where a recipient sees
        only their own entry); every other preview is null.

        ``next_since`` is the ``updated_at`` of the last request read, expired or not (an
        expired one is not returned but is passed, so a page of expired requests cannot
        stall the feed). A page never splits a group of requests with the same
        ``updated_at``, so ``updated_at > next_since`` never skips one: a page that would
        is cut before the group, and a page that is one whole group returns all of it
        (up to ACTIVITY_MAX_GROUP, which can exceed ``limit``).
        """
        await self._count_read(caller, "activity")
        now = self.now()
        limit = _parse_int(limit_raw, "limit", 1, ACTIVITY_MAX_LIMIT) or ACTIVITY_DEFAULT_LIMIT
        since = _parse_since(since_raw) if since_raw is not None else now - ACTIVITY_WINDOW
        docs = await self.store.requests_updated_after(caller.team, since, limit + 1)
        page = docs[:limit]
        if len(docs) > limit and docs[limit].updated_at == page[-1].updated_at:
            boundary = page[-1].updated_at
            before = [d for d in page if d.updated_at != boundary]
            if before:
                page = before
            else:
                assert boundary is not None
                page = await self.store.requests_updated_at(
                    caller.team, boundary, ACTIVITY_MAX_GROUP
                )
        next_since = page[-1].updated_at if page else since
        return {
            "requests": [self._activity_entry(caller, doc) for doc in page if now < doc.expire_at],
            "next_since": format_time(next_since),
            "server_time": format_time(now),
        }

    @staticmethod
    def _activity_entry(caller: Caller, doc: RequestDoc) -> dict[str, Any]:
        is_asker = caller.member == doc.asker
        participant = is_asker or caller.member in doc.recipients
        capability = None
        if doc.capability is not None:
            capability = {
                "name": doc.capability["name"],
                "environment": doc.capability["environment"],
                "params": doc.capability["params"] if participant else None,
            }
        return {
            "request_id": doc.request_id,
            "kind": doc.kind,
            "asker": doc.asker,
            "broadcast": doc.broadcast,
            "created_at": format_time(doc.created_at),
            "updated_at": format_time(doc.updated_at),
            "ack_deadline": format_time(doc.ack_deadline),
            "answer_deadline": format_time(doc.answer_deadline),
            "expire_at": format_time(doc.expire_at),
            "capability": capability,
            "question": doc.question if participant else None,
            "recipients": {
                m: {
                    "status": s.status,
                    "delivered_at": format_time(s.delivered_at),
                    "acked_at": format_time(s.acked_at),
                    "answered_at": format_time(s.answered_at),
                    "answer_delivered_at": format_time(s.answer_delivered_at),
                    "tools": [
                        {
                            "tool": t.tool,
                            "status": t.status,
                            "at": format_time(t.at),
                            "duration_ms": t.duration_ms,
                        }
                        for t in s.tools
                    ],
                    "progress_count": s.progress_count,
                    "last_progress_pct": s.last_progress_pct,
                    "answer_preview": (
                        s.answer_preview if is_asker or m == caller.member else None
                    ),
                }
                for m, s in doc.recipients.items()
            },
            "participant": participant,
        }

    # §4 ------------------------------------------------------------------------------------
    def _sweep_fn(self, now: datetime) -> Callable[[RequestDoc | None], Mutation[int]]:
        def fn(doc: RequestDoc | None) -> Mutation[int]:
            if doc is None:
                return Mutation(result=0)
            if now >= doc.expire_at:
                if doc.next_deadline is None:
                    return Mutation(result=0)
                doc.next_deadline = None
                return Mutation(result=0, request=doc)
            envelopes: list[Envelope] = []
            audit: list[AuditEntry] = []
            for member, state in doc.recipients.items():
                if state.status == "pending" and now >= doc.ack_deadline:
                    state.status = "no_response"
                    kind, detail = "no_response", f"No response yet from {member}."
                elif state.status == "acked" and now >= doc.answer_deadline:
                    state.status = "timed_out"
                    kind, detail = "timed_out", f"{member} acknowledged but has not answered yet."
                else:
                    continue
                env = Envelope(
                    id=new_message_id(),
                    team=doc.team,
                    stream="replies",
                    type=kind,
                    sender=RELAY,
                    to=doc.asker,
                    request_id=doc.request_id,
                    broadcast=doc.broadcast,
                    time=now,
                    expire_at=doc.expire_at,
                    data={"member": member, "detail": detail},
                )
                envelopes.append(env)
                audit.append(self._delivery_audit(env, RELAY, "deadline.notice", now))
            recomputed = next_deadline(doc)
            if not envelopes and recomputed == doc.next_deadline:
                return Mutation(result=0)
            doc.next_deadline = recomputed
            return Mutation(result=len(envelopes), request=doc, envelopes=envelopes, audit=audit)

        return fn

    async def sweep_asker(self, team: str, asker: str) -> int:
        """Fire every due deadline on the asker's requests; return the notices written."""
        now = self.now()
        written = 0
        for request_id in await self.store.due_requests(team, asker, now, SWEEP_BATCH):
            written += await self._mutate(team, request_id, now, self._sweep_fn(now))
        return written

    # M6 §2: the roster -----------------------------------------------------------------
    async def roster_list(self, caller: Caller) -> dict[str, Any]:
        """Every member; an owner sees every email, anyone else only their own (others'
        ``emails`` are null). An owner also sees the open invitations (``status:
        "invited"``, M9-SPEC §7.2), by member id among the members. Validated against
        ``roster_version`` on every call, so a console never shows a roster older than the
        last change it made."""
        roster = await self.roster.snapshot(caller.team, fresh=True)
        is_owner = roster.role(caller.member) == OWNER
        entries = dict(roster.entries)
        if is_owner:
            entries.update(roster.invited)
        return {
            "members": [
                entry_json(entries[m], show_emails=is_owner or m == caller.member)
                for m in sorted(entries)
            ],
            "roster_version": roster.version,
        }

    def _roster_quota(self, caller: Caller, now: datetime) -> Quota:
        start = int(now.timestamp()) // ROSTER_QUOTA_WINDOW_SECONDS * ROSTER_QUOTA_WINDOW_SECONDS
        return Quota(
            key=f"{caller.member}.roster.{start}",
            limit=self.config.limits.roster_mutations_per_hour,
            expire_at=datetime.fromtimestamp(start + 2 * ROSTER_QUOTA_WINDOW_SECONDS, UTC),
        )

    async def _change_roster(self, caller: Caller, fn: Any, now: datetime) -> Any:
        try:
            outcome = await self.store.mutate_roster(
                caller.team, fn, now, [self._roster_quota(caller, now)]
            )
        except TeamGone:
            raise not_found() from None  # M9-SPEC §1: deleted meanwhile
        except QuotaExceeded as exc:
            raise ApiError(
                429,
                "rate_limited",
                f"At most {exc.quota.limit} changes to the members an hour; try again later.",
            ) from None
        self.roster.invalidate(caller.team)
        if outcome.revoked:
            self.credentials.forget(outcome.revoked)
        return outcome.result

    async def roster_add(self, caller: Caller, raw: Any) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            body = parse_add(raw, self.config)
            now = self.now()
            fn = plan_add(
                caller.team,
                caller.member,
                body,
                now,
                self._retention,
                caller.delegate,
                self.config.limits.members_per_team,
            )
            entry = await self._change_roster(caller, fn, now)
            return entry_json(entry, show_emails=True)

        return await self._guarded(caller, "roster.add", None, work)

    async def roster_update(self, caller: Caller, member: str, raw: Any) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            body = parse_update(raw, self.config)
            now = self.now()
            fn = plan_update(
                caller.team, caller.member, member, body, now, self._retention, caller.delegate
            )
            entry = await self._change_roster(caller, fn, now)
            return entry_json(entry, show_emails=True)

        return await self._guarded(caller, "roster.update", None, work)

    async def roster_remove(self, caller: Caller, member: str) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            now = self.now()
            fn = plan_remove(
                caller.team,
                caller.member,
                member,
                seed.seed_ids if (seed := self.config.teams.get(caller.team)) else frozenset(),
                now,
                self._retention,
                caller.delegate,
            )
            entry = await self._change_roster(caller, fn, now)
            self.credentials.forget_member(caller.team, entry.member)
            return {"removed": entry.member}

        return await self._guarded(caller, "roster.remove", None, work)

    # M10 §1: the team's boundaries -------------------------------------------------------
    async def boundaries_get(self, caller: Caller) -> dict[str, Any]:
        """Any member (or a delegate reading for one): the team's boundaries, or version 0
        and nulls when never set. One against the member's per-minute budget for them, in
        the store; over it ``429 rate_limited`` (a read: stdout only, never the audit)."""
        limit = self.config.limits.reads_per_minute
        quota = self._quota(caller.member, "boundary_reads", limit, self.now())
        if not await self.store.count_quota(caller.team, quota):
            log_event(
                "read_refused",
                severity="WARNING",
                team=caller.team,
                member=caller.member,
                endpoint="boundaries",
                **({"delegate": caller.delegate} if caller.delegate else {}),
            )
            raise ApiError(
                429, "rate_limited", f"At most {limit} reads of the boundaries a minute."
            )
        return boundaries_json(caller.team, await self.store.get_boundaries(caller.team))

    async def boundaries_set(self, caller: Caller, raw: Any) -> dict[str, Any]:
        """An owner replaces the team's boundaries (M10-SPEC §1). The owner rule is checked
        before the body (a non-owner gets 403 whatever they send) and again, with the
        version, in the writing transaction; the audit holds the new version, never the
        text. Counted against the owner's hourly budget for owner writes."""

        def not_owner() -> ApiError:
            return ApiError(403, "forbidden", "Only an owner can change the team's boundaries.")

        async def work() -> dict[str, Any]:
            snapshot = await self.roster.snapshot(caller.team, fresh=True)
            if snapshot.role(caller.member) != OWNER:
                raise not_owner()
            version, topic = parse_set_body(raw)
            now = self.now()
            detail = f"version {version + 1}" + ("; via delegate" if caller.delegate else "")
            audit = self._audit(
                caller.team, caller.member, "boundaries_set", "set", now, detail=detail
            )

            def fn(
                current: TeamBoundaries | None, actor: RosterEntry | None
            ) -> BoundariesChange[TeamBoundaries]:
                if actor is None or not actor.active or actor.role != OWNER:
                    raise not_owner()
                stored = current.version if current is not None else 0
                if version != stored:
                    raise ApiError(
                        409,
                        "version_conflict",
                        f"The boundaries changed since you read them (now version {stored}); "
                        "reload and try again.",
                    )
                new = TeamBoundaries(
                    version=version + 1, topic=topic, updated_at=now, updated_by=caller.member
                )
                return BoundariesChange(result=new, boundaries=new, audit=[audit])

            start = (
                int(now.timestamp()) // ROSTER_QUOTA_WINDOW_SECONDS * ROSTER_QUOTA_WINDOW_SECONDS
            )
            quota = Quota(
                key=f"{caller.member}.boundaries.{start}",
                limit=self.config.limits.roster_mutations_per_hour,
                expire_at=datetime.fromtimestamp(start + 2 * ROSTER_QUOTA_WINDOW_SECONDS, UTC),
            )
            try:
                stored = await self.store.set_boundaries(caller.team, caller.member, fn, [quota])
            except TeamGone:
                raise not_found() from None  # M9-SPEC §1: deleted meanwhile
            except QuotaExceeded as exc:
                raise ApiError(
                    429,
                    "rate_limited",
                    f"At most {exc.quota.limit} changes to the boundaries an hour; "
                    "try again later.",
                ) from None
            log_event(
                "boundaries_set",
                team=caller.team,
                member=caller.member,
                version=stored.version,
                via_delegate=bool(caller.delegate),
            )
            return boundaries_json(caller.team, stored)

        return await self._guarded(caller, "boundaries_set", None, work)

    # M11 §2-§4: a member's own state ---------------------------------------------------
    async def _count_own_read(self, caller: Caller, name: str, endpoint: str) -> None:
        """One against the member's per-minute budget ``name`` for one kind of read
        (``reads_per_minute`` each), in the store; over it ``429 rate_limited``. A read: a
        refusal goes to stdout only, never the audit."""
        limit = self.config.limits.reads_per_minute
        quota = self._quota(caller.member, name, limit, self.now())
        if await self.store.count_quota(caller.team, quota):
            return
        log_event(
            "read_refused",
            severity="WARNING",
            team=caller.team,
            member=caller.member,
            endpoint=endpoint,
            **({"delegate": caller.delegate} if caller.delegate else {}),
        )
        raise ApiError(429, "rate_limited", f"At most {limit} of these reads a minute.")

    async def acceptance_get(self, caller: Caller) -> dict[str, Any]:
        """M11-SPEC §2: the boundaries version the caller accepted (0: never)."""
        await self._count_own_read(caller, "acceptance_reads", "acceptance")
        found = await self.store.get_acceptances(caller.team, [caller.member])
        return acceptance_json(found.get(caller.member))

    async def acceptance_set(self, caller: Caller, raw: Any) -> dict[str, Any]:
        """M11-SPEC §2: the caller accepts the team's current boundaries version, for
        themselves only (the caller is the member; a ``member-self`` delegate's caller is its
        viewer). The version must be the current one (``409 version_conflict``); never set:
        ``409 not_set``. Accepting the version already accepted changes nothing. Counted
        against the member's hourly write budget; audited with the version only."""

        async def work() -> dict[str, Any]:
            version = parse_accept_body(raw)
            now = self.now()
            detail = f"version {version}" + ("; via delegate" if caller.delegate else "")
            audit = self._audit(
                caller.team, caller.member, "boundaries_accepted", "accepted", now, detail=detail
            )

            def fn(
                current: TeamBoundaries | None,
                accepted: Acceptance | None,
                entry: RosterEntry | None,
            ) -> AcceptanceChange[Acceptance]:
                if entry is None or not entry.active:
                    raise not_found()  # removed meanwhile
                if current is None:
                    raise ApiError(409, "not_set", "This team's boundaries have not been set yet.")
                if version != current.version:
                    raise ApiError(
                        409,
                        "version_conflict",
                        f"The boundaries are now version {current.version}; "
                        "reload and accept what is shown.",
                    )
                if accepted is not None and accepted.version == version:
                    return AcceptanceChange(result=accepted)
                new = Acceptance(version=version, accepted_at=now)
                return AcceptanceChange(result=new, acceptance=new, audit=[audit])

            start = (
                int(now.timestamp()) // ROSTER_QUOTA_WINDOW_SECONDS * ROSTER_QUOTA_WINDOW_SECONDS
            )
            quota = Quota(
                key=f"{caller.member}.acceptance.{start}",
                limit=self.config.limits.roster_mutations_per_hour,
                expire_at=datetime.fromtimestamp(start + 2 * ROSTER_QUOTA_WINDOW_SECONDS, UTC),
            )
            try:
                stored = await self.store.set_acceptance(caller.team, caller.member, fn, [quota])
            except TeamGone:
                raise not_found() from None  # M9-SPEC §1: deleted meanwhile
            except QuotaExceeded as exc:
                raise ApiError(
                    429,
                    "rate_limited",
                    f"At most {exc.quota.limit} acceptances an hour; try again later.",
                ) from None
            log_event(
                "boundaries_accepted",
                team=caller.team,
                member=caller.member,
                version=stored.version,
                via_delegate=bool(caller.delegate),
            )
            return acceptance_json(stored)

        return await self._guarded(caller, "boundaries_accepted", None, work)

    async def status_set(self, caller: Caller, raw: Any) -> dict[str, Any]:
        """M11-SPEC §3: the caller's background answerer reports; the relay adds ``seen_at``
        (its own clock). At most one write per member per STATUS_MIN_INTERVAL (``429``).
        Never a delegate's (the app refuses it). Not audited: like a cursor move, it is the
        transport's bookkeeping, and it holds a count, booleans and times only. The answer is
        the status as stored, with the caller's own ``folder_count``."""
        status = parse_status_body(raw)
        now = self.now()

        def fn(
            current: MemberStatus | None, entry: RosterEntry | None
        ) -> StatusChange[dict[str, Any] | None]:
            if entry is None or not entry.active:
                raise not_found()  # removed meanwhile
            if current is not None and now < current.seen_at + STATUS_MIN_INTERVAL:
                return StatusChange(result=None)
            return StatusChange(result=status, status=MemberStatus(status=status, seen_at=now))

        try:
            written = await self.store.set_member_status(caller.team, caller.member, fn)
        except TeamGone:
            raise not_found() from None
        if written is None:
            log_event(
                "status_rate_limited", severity="WARNING", team=caller.team, member=caller.member
            )
            raise ApiError(
                429, "rate_limited", "At most one status every 20 seconds; try again shortly."
            )
        return {**status_json(written, now), "folder_count": stored_folder_count(written)}

    async def members_status(self, caller: Caller) -> dict[str, Any]:
        """M11-SPEC §3: every active member's last status (null when none), whether they are
        answering (a status within ANSWERING_WINDOW), the boundaries version they accepted,
        and the team's current version. Each entry's ``folder_count`` (how many folders the
        member chose; never their names, 13 Nov 2026) goes to an owner for every member and to
        anyone else for their own entry only: null for the others, and when the member has no
        status or an older plugin's status without a count."""
        await self._count_own_read(caller, "status_reads", "members_status")
        snapshot = await self.roster.snapshot(caller.team, fresh=True)
        owner = snapshot.role(caller.member) == OWNER
        members = list(snapshot.members())
        statuses = await self.store.get_member_statuses(caller.team, members)
        accepted = await self.store.get_acceptances(caller.team, members)
        current = await self.store.get_boundaries(caller.team)
        now = self.now()
        listed = []
        for member in members:
            stored = statuses.get(member)
            acceptance = accepted.get(member)
            count = None
            if stored is not None and (owner or member == caller.member):
                count = stored_folder_count(stored.status)
            listed.append(
                {
                    "member": member,
                    "status": status_json(stored.status, stored.seen_at) if stored else None,
                    "answering": stored is not None and now - stored.seen_at <= ANSWERING_WINDOW,
                    "accepted_version": acceptance.version if acceptance else 0,
                    "folder_count": count,
                }
            )
        return {
            "members": listed,
            "boundaries_version": current.version if current is not None else 0,
        }

    async def my_requests(self, caller: Caller, limit_raw: str | None) -> dict[str, Any]:
        """M11-SPEC §4: the caller's own unexpired questions, newest first, with the first
        QUESTION_PREVIEW_CHARS code points of each; ``to`` is ``"*"`` for a broadcast."""
        limit = _parse_int(limit_raw, "limit", 1, MY_REQUESTS_MAX)
        await self._count_own_read(caller, "request_list_reads", "my_requests")
        now = self.now()
        docs = await self.store.recent_questions(
            caller.team, caller.member, now, limit or MY_REQUESTS_DEFAULT
        )
        return {
            "requests": [
                {
                    "id": doc.request_id,
                    "to": "*" if doc.broadcast else list(doc.recipients),
                    "created_at": format_time(doc.created_at),
                    "question_preview": (doc.question or "")[:QUESTION_PREVIEW_CHARS],
                }
                for doc in docs
            ]
        }

    # M5 §3: device credentials ---------------------------------------------------------
    async def credentials_list(self, caller: Caller) -> dict[str, Any]:
        """The caller's own live devices, most recently used first."""
        now = self.now()
        records = [
            r for r in await self.store.list_credentials(caller.team, caller.member) if r.live(now)
        ]
        records.sort(key=lambda r: (r.last_used_at, r.key), reverse=True)
        return {
            "credentials": [
                {
                    "id": public_id(r.key),
                    "device": r.device,
                    "created_at": format_time(r.created_at),
                    "last_used_at": format_time(r.last_used_at),
                    "expires_at": format_time(r.expire_at),
                    "current": r.key == caller.credential,
                }
                for r in records[:MAX_LISTED_CREDENTIALS]
            ]
        }

    async def credential_revoke(self, caller: Caller, which: str) -> dict[str, Any]:
        """``self``: the credential the call came with (logout); otherwise one of the
        caller's own live credentials by its public id. Anything else: 404."""

        async def work() -> dict[str, Any]:
            now = self.now()
            if which == "self":
                if caller.credential is None:
                    raise ApiError(
                        400, "not_a_credential", "This call was not made with a device credential."
                    )
                key = caller.credential
            else:
                if PUBLIC_ID_RE.fullmatch(which) is None:
                    raise not_found()
                matches = [
                    r.key
                    for r in await self.store.list_credentials(caller.team, caller.member)
                    if public_id(r.key) == which and r.live(now)
                ]
                if len(matches) != 1:
                    raise not_found()
                key = matches[0]
            entry = self._audit(
                caller.team,
                caller.member,
                "credential.revoke",
                "revoked",
                now,
                member=caller.member,
                detail=f"credential {public_id(key)}" + ("; logout" if which == "self" else ""),
            )
            revoked = await self.store.revoke_credential(
                caller.team, key, caller.member, now, [entry]
            )
            if revoked is None:
                raise not_found()
            self.credentials.forget([key])
            return {"revoked": public_id(key)}

        return await self._guarded(caller, "credential.revoke", None, work)
