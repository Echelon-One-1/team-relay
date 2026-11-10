"""Teams anyone can create (M9-SPEC §1, §2, §4).

- The team file's teams are **seed teams**: always active, never deleted through the API
  (``409 seed_team``), resolved from the file as before. Every other team is a record in the
  store that the API created; it is a team while its record says ``active``.
- :meth:`Teams.active` answers "is this a team now" for a request: a seed team without a
  read, any other team with one fresh read of its record on every call, so a deleted team is
  refused on every instance at once (M9-SPEC §1).
- :meth:`Teams.create` checks the id (shape, reserved words, the file's ids), the name and
  the owner's member id, then creates the team in one store transaction that also enforces
  that the id is free (two concurrent creations: one wins, the other gets ``409``), the
  per-account limit of teams created and not deleted, and the per-account-per-day and
  per-IP-per-hour creation counters.
- :meth:`Teams.delete` marks the team deleted in one transaction (from then on no
  credential of it authenticates, no roster change or login for it writes, and its creator's
  slot is free), then removes its documents in bounded batches; a later call resumes. The
  id stays reserved for TEAM_ID_RESERVATION; before an id that was deleted is created again,
  whatever is still under it is removed (anything a request racing the deletion wrote).
- Corrections after the M9 security review (M9-SPEC §7): a file team never adopts a created
  team (:meth:`Teams.ensure_seed_records`, and the roster's seeding, refuse to start); a team
  is created only over an id with nothing stored under it; a taken, reserved or recently
  deleted id is one answer, ``409 team_id_unavailable``; a name equal to a file team's is
  refused (``409 team_name_unavailable``); every attempt counts against a per-account quota
  (:meth:`Teams.count_attempt`); the per-account limits key on the Google ``sub`` as well as
  the email; a delegate's creations count against the client address the console reports and
  against a per-delegate cap; invitations are listed and answered here
  (:meth:`Teams.invitations`, :meth:`Teams.answer_invitation`); an owner may delete a team
  they own; every admin audit entry says ``via`` and refused admin actions are recorded.
- Emails never appear in a log line or an audit entry: only their SHA-256.
"""

from __future__ import annotations

import asyncio
import re
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any

from .clock import format_time
from .config import (
    CREATED_TEAM_RE,
    MEMBER_RE,
    TEAM_RE,
    TeamConfig,
    normalise_team_name,
)
from .credentials import Credentials
from .errors import ApiError, not_found
from .jsonutil import sha256_hex
from .log import log_event
from .roster import OWNER, Roster, SeedConflict, email_hash, plan_answer
from .store import (
    TEAM_ACTIVE,
    TEAM_DELETED,
    AccountRecord,
    AdminAuditEntry,
    AuditEntry,
    Quota,
    QuotaExceeded,
    RosterEntry,
    Store,
    TeamCreation,
    TeamDeletion,
    TeamGone,
    TeamRecord,
    sub_account_key,
)

# M9-SPEC §1: never a team id, besides every id in the team file.
RESERVED_TEAM_IDS = frozenset(
    {
        "admin",
        "api",
        "login",
        "v1",
        "health",
        "static",
        "www",
        "team",
        "teams",
        "relay",
        "console",
        "demo",
        "test",
    }
)
TEAM_ID_RESERVATION = timedelta(days=31)
# One delete (or resume) removes at most this many documents; a later call goes on.
PURGE_BUDGET = 2000
ADMIN_LIST_DEFAULT = 200
ADMIN_LIST_MAX = 1000
# The relay-wide admin audit keeps entries this long.
ADMIN_AUDIT_RETENTION = timedelta(days=400)
NAME_CACHE_SIZE = 4096
ACTIVITY_CONCURRENCY = 16
DAY_SECONDS = 86400
HOUR_SECONDS = 3600
MINUTE_SECONDS = 60
CREATOR_ACTOR = "relay"
# M9-SPEC §7.5: how an admin audit entry's actor reached the relay.
VIA_DIRECT = "direct"
VIA_DELEGATE = "delegate"
# The admin audit's "team" for an action on no one team (the listing).
ALL_TEAMS = "*"
ROSTER_QUOTA_WINDOW = 3600


def valid_team_id(team: str) -> bool:
    """Whether ``team`` has the shape of a team id at all (the file's or a created one), so
    it is safe to look up; nothing else ever reaches the store."""
    return TEAM_RE.fullmatch(team) is not None or CREATED_TEAM_RE.fullmatch(team) is not None


def domain_not_allowed() -> ApiError:
    """M10-SPEC §7.2: an email outside RELAY_ALLOWED_DOMAINS."""
    return ApiError(
        403,
        "domain_not_allowed",
        "This relay accepts Google accounts of its own organisation's domains only.",
    )


def suggest_member_id(email: str) -> str:
    """A member id from an email's local part: lower case, anything outside ``[a-z0-9_]``
    becomes ``_``, starting with a letter, 2 to 32 characters."""
    local = email.split("@", 1)[0].lower()
    text = re.sub(r"[^a-z0-9_]+", "_", local).strip("_")
    if not text or not text[0].isalpha():
        text = "m_" + text if text else "member"
    text = text[:32].rstrip("_")
    if len(text) < 2:
        text = (text + "_member")[:32]
    return text if MEMBER_RE.fullmatch(text) else "member"


def suggest_team_id(name: str) -> str:
    """A team id from a display name: lower-case ASCII letters and digits, anything else
    becomes ``-``, starting with a letter, 3 to 32 characters."""
    text = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not text or not text[0].isalpha():
        text = ("team-" + text).rstrip("-")
    text = text[:32].rstrip("-")
    if len(text) < 3:
        text = ("team-" + text).rstrip("-")[:32]
    return text if CREATED_TEAM_RE.fullmatch(text) else "team"


@dataclass(frozen=True)
class NewTeam:
    id: str
    name: str
    owner: str


def parse_new_team(raw: Any) -> NewTeam:
    """``{id, name, owner_member_id}`` (M9-SPEC §2), nothing else. ``id`` may be omitted:
    it is then suggested from the name."""
    if not isinstance(raw, dict):
        raise ApiError(422, "invalid_body", "(body): must be an object")
    extra = set(raw) - {"id", "name", "owner_member_id"}
    if extra:
        raise ApiError(422, "invalid_body", f"{sorted(extra)[0]}: extra field not permitted")
    name = normalise_team_name(raw.get("name"))
    if name is None:
        raise ApiError(422, "invalid_body", "name: 1 to 60 characters, no control characters")
    team = raw.get("id")
    if team is None:
        team = suggest_team_id(name)
    if not isinstance(team, str) or CREATED_TEAM_RE.fullmatch(team) is None:
        raise ApiError(
            422,
            "invalid_body",
            "id: 3 to 32 characters: lower-case letters, digits and '-', starting with a letter",
        )
    owner = raw.get("owner_member_id")
    if not isinstance(owner, str) or MEMBER_RE.fullmatch(owner) is None:
        raise ApiError(
            422,
            "invalid_body",
            "owner_member_id: 2 to 32 characters: lower-case letters, digits and '_', "
            "starting with a letter",
        )
    return NewTeam(id=team, name=name, owner=owner)


@dataclass(frozen=True)
class Membership:
    team: str
    member: str


def team_json(record: TeamRecord) -> dict[str, Any]:
    return {
        "team": record.id,
        "name": record.name,
        "status": record.status,
        "created_at": format_time(record.created_at),
    }


class Teams:
    def __init__(
        self,
        config: TeamConfig,
        store: Store,
        roster: Roster,
        credentials: Credentials,
        now: Callable[[], datetime],
    ) -> None:
        self._config = config
        self._store = store
        self._roster = roster
        self._credentials = credentials
        self._now = now
        self._retention = timedelta(days=config.audit_retention_days)
        # Names never change once a team exists; a bounded cache saves a read for /me.
        self._names: OrderedDict[str, str] = OrderedDict()
        self._seeded_records: set[str] = set()
        self._seed_lock = asyncio.Lock()

    # Which teams exist ----------------------------------------------------------------------
    def is_seed(self, team: str) -> bool:
        return team in self._config.teams

    def _remember_name(self, team: str, name: str) -> None:
        self._names[team] = name
        self._names.move_to_end(team)
        while len(self._names) > NAME_CACHE_SIZE:
            self._names.popitem(last=False)

    async def ensure_seed_records(self) -> None:
        """Give every team of the file its record (once per process). A file team whose id
        is a team the API created, active or deleted, raises :class:`SeedConflict`: the
        relay does not start (M9-SPEC §7.1)."""
        async with self._seed_lock:
            for team in self._config.team_ids():
                if team in self._seeded_records:
                    continue
                spec = self._config.teams[team]
                await self._roster.ensure_seeded(team)  # so the counts are the seeded roster's
                record = await self._store.ensure_seed_team(team, spec.display_name, self._now())
                if not record.seed:
                    log_event("seed_team_conflict", severity="ERROR", team=team)
                    raise SeedConflict(team)
                self._seeded_records.add(team)

    async def active(self, team: str) -> TeamRecord | None:
        """The team's record while it is a team now, else None. A seed team is active
        without a read; any other team is read fresh, every call."""
        spec = self._config.teams.get(team)
        if spec is not None:
            return TeamRecord(id=team, name=spec.display_name)
        if not valid_team_id(team):
            return None
        record = (await self._store.get_teams([team])).get(team)
        # A seed record the file no longer lists is not a team (as before M9).
        if record is None or record.seed or record.status != TEAM_ACTIVE:
            return None
        self._remember_name(team, record.name)
        return record

    async def name(self, team: str) -> str:
        spec = self._config.teams.get(team)
        if spec is not None:
            return spec.display_name
        cached = self._names.get(team)
        if cached is not None:
            return cached
        record = await self.active(team)
        return record.name if record is not None else team

    async def indexed_teams(self, email: str) -> list[str]:
        """The active teams the API created whose roster the account index says holds
        ``email``, by id."""
        account = await self._store.get_account(email_hash(email))
        if account is None or not account.memberships:
            return []
        candidates = sorted(t for t in account.memberships if t not in self._config.teams)
        records = await self._store.get_teams(candidates)
        found = []
        for team in candidates:
            record = records.get(team)
            if record is not None and not record.seed and record.status == TEAM_ACTIVE:
                self._remember_name(team, record.name)
                found.append(team)
        return found

    async def memberships(self, email: str, *, fresh: bool = False) -> list[Membership]:
        """Every team whose roster holds ``email``, with the member it is: the file's teams
        first (in the file's order), then the created ones by id. The roster decides; the
        index only says where to look."""
        found: list[Membership] = []
        for team in self._config.team_ids():
            member = (await self._roster.snapshot(team, fresh=fresh)).member_for_email(email)
            if member is not None:
                found.append(Membership(team, member))
        for team in await self.indexed_teams(email):
            member = (await self._roster.snapshot(team, fresh=fresh)).member_for_email(email)
            if member is not None:
                found.append(Membership(team, member))
        return found

    async def account(self, email: str) -> AccountRecord | None:
        return await self._store.get_account(email_hash(email))

    async def invitations(
        self, email: str, sub: str | None, *, only: str | None = None
    ) -> list[dict[str, Any]]:
        """The open invitations ``email`` holds (M9-SPEC §7.2), the file's teams first, then
        the created ones by id: ``[{team, name, member, role, invited_by_member}]``, read
        fresh. One bound to another Google account is left out when ``sub`` is known;
        ``only`` limits them to one team."""
        teams = [*self._config.team_ids(), *await self.indexed_teams(email)]
        rows = []
        for team in teams:
            if only is not None and team != only:
                continue
            entry = (await self._roster.snapshot(team, fresh=True)).invitation_for_email(email)
            if entry is None:
                continue
            bound = entry.subs.get(email)
            if sub is not None and bound is not None and bound != sub:
                continue
            rows.append(
                {
                    "team": team,
                    "name": await self.name(team),
                    "member": entry.member,
                    "role": entry.role,
                    "invited_by_member": entry.added_by,
                }
            )
        return rows

    async def answer_invitation(
        self, team: str, *, email: str, sub: str | None, accept: bool, via: str | None
    ) -> dict[str, Any]:
        """Accept or decline the invitation ``email`` holds in ``team`` (M9-SPEC §7.2), in
        one roster transaction. No such invitation, or no such team: ``404``. Counted against
        the account's roster changes per hour. Accepting with an email outside
        RELAY_ALLOWED_DOMAINS: ``403 domain_not_allowed`` (M10-SPEC §7.2)."""
        if accept and not self._config.email_allowed(email):
            raise domain_not_allowed()
        if await self.active(team) is None:
            raise not_found()
        now = self._now()
        start = int(now.timestamp()) // ROSTER_QUOTA_WINDOW * ROSTER_QUOTA_WINDOW
        quota = Quota(
            key=f"invitation.{email_hash(email)[:32]}.{start}",
            limit=self._config.limits.roster_mutations_per_hour,
            expire_at=datetime.fromtimestamp(start + 2 * ROSTER_QUOTA_WINDOW, UTC),
        )
        fn = plan_answer(team, email, sub, accept, now, self._retention, via)
        try:
            outcome = await self._store.mutate_roster(team, fn, now, [quota])
        except TeamGone:
            raise not_found() from None
        except QuotaExceeded as exc:
            raise ApiError(
                429,
                "rate_limited",
                f"At most {exc.quota.limit} answers to invitations an hour; try again later.",
            ) from None
        self._roster.invalidate(team)
        entry: RosterEntry = outcome.result
        log_event(
            "invitation_accepted" if accept else "invitation_declined",
            team=team,
            member=entry.member,
            via_delegate=bool(via),
        )
        if not accept:
            return {"team": team, "member": entry.member, "status": "declined"}
        return {
            "team": team,
            "name": await self.name(team),
            "member": entry.member,
            "role": entry.role,
            "status": entry.status,
        }

    async def my_teams(
        self, email: str, sub: str | None, *, only: str | None = None
    ) -> dict[str, Any]:
        """``GET /v1/me/teams`` (M9-SPEC §2): the account's teams, ``[{team, name, member,
        role}]``, validated against each roster's version, and its open invitations
        (M9-SPEC §7.2), which grant nothing until accepted. A team where the email is bound
        to another Google account (M6-SPEC §7.2) is left out when ``sub`` is known;
        ``only`` limits the lists to one team (a per-team delegate's)."""
        rows = []
        for found in await self.memberships(email, fresh=True):
            if only is not None and found.team != only:
                continue
            snapshot = await self._roster.snapshot(found.team)
            bound = snapshot.sub_for(found.member, email)
            if sub is not None and bound is not None and bound != sub:
                continue
            rows.append(
                {
                    "team": found.team,
                    "name": await self.name(found.team),
                    "member": found.member,
                    "role": snapshot.role(found.member),
                }
            )
        account = await self.account(email)
        return {
            "teams": rows,
            "invitations": await self.invitations(email, sub, only=only),
            "admin": self._config.is_admin(email),
            "teams_created": len(account.created) if account is not None else 0,
            "max_teams_created": self._config.limits.teams_per_account,
            "suggested_member": suggest_member_id(email),
        }

    # Creating -------------------------------------------------------------------------------
    def _hour(self, now: datetime) -> int:
        return int(now.timestamp()) // HOUR_SECONDS * HOUR_SECONDS

    async def count_attempt(self, email: str, sub: str | None) -> None:
        """M9-SPEC §7.4: one attempt to create a team, refused or not, against the account's
        hourly quota, by its email and (when known) by its Google ``sub``. Over it:
        ``429 rate_limited``. Counted before the body is read, so no refusal is free."""
        now = self._now()
        hour = self._hour(now)
        limit = self._config.limits.team_create_attempts_per_account_per_hour
        expire_at = datetime.fromtimestamp(hour + 2 * HOUR_SECONDS, UTC)
        keys = [f"team_attempt.account.{email_hash(email)[:32]}.{hour}"]
        if sub is not None:
            keys.append(f"team_attempt.sub.{sub_account_key(sub)[:32]}.{hour}")
        for key in keys:
            if not await self._store.count_login_quota(Quota(key, limit, expire_at)):
                log_event("team_create_rate_limited", severity="WARNING", quota="attempts")
                raise ApiError(
                    429,
                    "rate_limited",
                    f"At most {limit} attempts to create a team an hour; try again later.",
                )

    def _quotas(
        self,
        email: str,
        sub: str | None,
        ip: str | None,
        console_ip: str | None,
        delegate: str | None,
        now: datetime,
    ) -> list[Quota]:
        limits = self._config.limits
        day = int(now.timestamp()) // DAY_SECONDS * DAY_SECONDS
        day_expiry = datetime.fromtimestamp(day + 2 * DAY_SECONDS, UTC)
        hour = self._hour(now)
        hour_expiry = datetime.fromtimestamp(hour + 2 * HOUR_SECONDS, UTC)
        per_day = limits.team_creations_per_account_per_day
        account = email_hash(email)[:32]
        quotas = [Quota(f"team_create.account.{account}.{day}", per_day, day_expiry)]
        if sub is not None:  # M9-SPEC §7.6: the Google account as well as its email
            by_sub = sub_account_key(sub)[:32]
            quotas.append(Quota(f"team_create.sub.{by_sub}.{day}", per_day, day_expiry))
        per_ip = limits.team_creations_per_ip_per_hour
        if ip is not None:
            quotas.append(Quota(f"team_create.ip.{ip}.{hour}", per_ip, hour_expiry))
        if console_ip is not None:  # §7.6: the address the console saw, salted and hashed
            seen = console_ip[:32]
            quotas.append(Quota(f"team_create.ip.console.{seen}.{hour}", per_ip, hour_expiry))
        if delegate is not None:  # §7.6: every creation through one delegate
            quotas.append(
                Quota(
                    f"team_create.delegate.{sha256_hex(delegate)[:32]}.{hour}",
                    limits.team_creations_per_delegate_per_hour,
                    hour_expiry,
                )
            )
        return quotas

    def check_reserved(self, team: str) -> None:
        if team in RESERVED_TEAM_IDS or team in self._config.teams:
            raise _unavailable()

    async def create(
        self,
        *,
        email: str,
        sub: str | None,
        body: NewTeam,
        ip_hash: str | None,
        via: str | None,
        console_ip_hash: str | None = None,
    ) -> dict[str, Any]:
        """Create ``body`` with ``email`` as its first owner (bound to ``sub`` when there is
        one). ``ip_hash`` counts the per-IP limit for a direct call; for a delegate (``via``,
        its principal) ``console_ip_hash`` is the client address the console reports, and the
        delegate's own cap counts too. Raises :class:`ApiError`."""
        if self._config.is_delegate_email(email):
            raise ApiError(422, "invalid_body", "A delegate is not a person and owns no team.")
        if not self._config.email_allowed(email):  # M10-SPEC §7.2
            raise domain_not_allowed()
        if self._config.is_file_team_name(body.name):
            raise ApiError(
                409,
                "team_name_unavailable",
                "That name belongs to another team; choose another.",
            )
        self.check_reserved(body.id)
        now = self._now()
        existing = (await self._store.get_teams([body.id])).get(body.id)
        if existing is not None and existing.status == TEAM_DELETED:
            if existing.reserved_until is not None and now < existing.reserved_until:
                raise _unavailable()
            # Whatever a request racing the deletion wrote after its removal goes first.
            if not await self._store.purge_team(body.id, PURGE_BUDGET):
                raise _unavailable()
        elif existing is None and await self._store.team_has_documents(body.id):
            # M9-SPEC §7.1: nothing at all may be left under an id a team is created at.
            log_event("team_id_not_empty", severity="WARNING", team=body.id)
            raise _unavailable()
        limits = self._config.limits
        creator = email_hash(email)
        sub_key = sub_account_key(sub) if sub is not None else None
        record = TeamRecord(
            id=body.id,
            name=body.name,
            status=TEAM_ACTIVE,
            seed=False,
            created_at=now,
            created_by_member=body.owner,
            created_by_email_sha256=creator,
            created_by_sub_sha256=sub_key,
            roster_version=1,
            members=1,
            owners=1,
        )
        owner = RosterEntry(
            member=body.owner,
            emails=[email],
            role=OWNER,
            added_by=CREATOR_ACTOR,
            added_at=now,
            updated_at=now,
            subs={email: sub} if sub is not None else {},
        )
        detail = "via delegate" if via else None
        audit = AuditEntry(
            time=now,
            team=body.id,
            actor=body.owner,
            action="team.create",
            outcome="created",
            expire_at=now + self._retention,
            member=body.owner,
            email_sha256=[creator],
            detail=detail,
        )
        admin_audit = AdminAuditEntry(
            time=now,
            actor_email_sha256=creator,
            action="team.create",
            team=body.id,
            outcome="created",
            expire_at=now + ADMIN_AUDIT_RETENTION,
            detail=detail,
            via=VIA_DELEGATE if via else VIA_DIRECT,
        )

        def fn(
            current: TeamRecord | None,
            account: AccountRecord | None,
            by_sub: AccountRecord | None,
        ) -> TeamCreation[TeamRecord]:
            if current is not None:
                if current.status != TEAM_DELETED:
                    raise _unavailable()
                if current.reserved_until is None or now < current.reserved_until:
                    raise _unavailable()
                if not current.purge_complete:
                    raise _unavailable()
            # M9-SPEC §7.6: the Google account's teams as well as its email's.
            created = max(
                len(account.created) if account is not None else 0,
                len(by_sub.created) if by_sub is not None else 0,
            )
            if created >= limits.teams_per_account:
                raise ApiError(
                    409,
                    "team_limit",
                    f"An account can have created at most {limits.teams_per_account} teams; "
                    "delete one first.",
                )
            # An id given again continues the deleted team's roster version, so no instance's
            # cached roster of the old team can pass for the new one's.
            final = (
                replace(record, roster_version=current.roster_version + 1) if current else record
            )
            return TeamCreation(
                result=final, team=final, owner=owner, audit=[audit], admin_audit=[admin_audit]
            )

        quotas = self._quotas(email, sub, ip_hash, console_ip_hash, via, now)
        try:
            created = await self._store.create_team(body.id, creator, fn, quotas, sub_key=sub_key)
        except QuotaExceeded as exc:
            key = exc.quota.key
            if ".delegate." in key:
                per = "an hour through the console"
            elif ".ip." in key:
                per = "an hour from this address"
            else:
                per = "a day"
            raise ApiError(
                429,
                "rate_limited",
                f"At most {exc.quota.limit} new teams {per}; try again later.",
            ) from None
        self._roster.invalidate(body.id)
        self._remember_name(body.id, body.name)
        log_event("team_created", team=body.id, member=body.owner, via_delegate=bool(via))
        return {
            **team_json(created),
            "member": body.owner,
            "role": OWNER,
        }

    # Admin ------------------------------------------------------------------------------------
    async def admin_list(self, after: str | None, limit: int) -> dict[str, Any]:
        """Every team, the file's first, then the created ones by id (paged by ``after``):
        ``{id, name, status, seed, created_at, created_by_member, members, owners,
        last_activity_at}`` and, for a deleted team, ``removal`` and ``reserved_until``. No
        email, no content. A deleted team is listed while its id is reserved or its removal
        is pending."""
        await self.ensure_seed_records()
        now = self._now()
        rows: list[dict[str, Any]] = []
        records: list[TeamRecord] = []
        if after is None:
            seeds = await self._store.get_teams(self._config.team_ids())
            for team in self._config.team_ids():
                spec = self._config.teams[team]
                records.append(seeds.get(team) or TeamRecord(id=team, name=spec.display_name))
        page = await self._store.list_teams(after, limit + 1)
        more = len(page) > limit
        page = page[:limit]
        for record in page:
            if (
                record.status == TEAM_DELETED
                and record.purge_complete
                and (record.reserved_until is None or now >= record.reserved_until)
            ):
                continue
            records.append(record)
        # One small query per team, a few at a time.
        gate = asyncio.Semaphore(ACTIVITY_CONCURRENCY)

        async def last_activity(record: TeamRecord) -> datetime | None:
            async with gate:
                return await self._last_activity(record)

        activity = await asyncio.gather(*(last_activity(r) for r in records))
        for record, last in zip(records, activity, strict=True):
            seed = record.id in self._config.teams
            row: dict[str, Any] = {
                "id": record.id,
                "name": self._config.teams[record.id].display_name if seed else record.name,
                "status": TEAM_ACTIVE if seed else record.status,
                "seed": seed,
                "created_at": format_time(record.created_at),
                "created_by_member": record.created_by_member,
                "members": record.members,
                "owners": record.owners,
                "last_activity_at": format_time(last),
            }
            if record.status == TEAM_DELETED and not seed:
                row["removal"] = "complete" if record.purge_complete else "pending"
                row["reserved_until"] = format_time(record.reserved_until)
                row["deleted_at"] = format_time(record.deleted_at)
            rows.append(row)
        return {"teams": rows, "next": page[-1].id if more and page else None}

    async def _last_activity(self, record: TeamRecord) -> datetime | None:
        if record.status == TEAM_DELETED:
            return None
        found = await self._store.requests_updated_after(
            record.id, datetime.fromtimestamp(0, UTC), 1, descending=True
        )
        return found[0].updated_at if found else None

    async def admin_refused(
        self, *, actor_sha256: str, action: str, team: str, err: ApiError, via: str
    ) -> None:
        """M9-SPEC §7.5: a refused admin action in the admin audit (its status and code, never
        the caller's input), at most ``audited_refusals_per_minute`` per actor; beyond that
        stdout only, so refusals cannot flood the audit."""
        now = self._now()
        minute = int(now.timestamp()) // MINUTE_SECONDS * MINUTE_SECONDS
        quota = Quota(
            key=f"admin_refused.{actor_sha256[:32]}.{minute}",
            limit=self._config.limits.audited_refusals_per_minute,
            expire_at=datetime.fromtimestamp(minute + 2 * MINUTE_SECONDS, UTC),
        )
        detail = f"{err.status} {err.code}"
        if await self._store.count_login_quota(quota):
            entry = AdminAuditEntry(
                time=now,
                actor_email_sha256=actor_sha256,
                action=action,
                team=team if valid_team_id(team) else ALL_TEAMS,
                outcome="refused",
                expire_at=now + ADMIN_AUDIT_RETENTION,
                detail=detail,
                via=via,
            )
            await self._store.append_admin_audit([entry])
        else:
            log_event("admin_refusal_not_audited", severity="WARNING", action=action, detail=detail)

    async def count_delegate_delete(self, team: str, delegate: str) -> None:
        """M9-SPEC §7.8: an admin deletion through ``delegate`` counts against its hourly
        cap, unless the team is already deleted (a call that only resumes the removal).
        Over the cap: ``429 rate_limited``."""
        if not valid_team_id(team):
            return
        record = (await self._store.get_teams([team])).get(team)
        if record is None or record.status == TEAM_DELETED or record.seed:
            return  # refused (404, 409) or resumed below: nothing is deleted by this call
        now = self._now()
        hour = self._hour(now)
        limit = self._config.limits.admin_deletes_per_delegate_per_hour
        quota = Quota(
            key=f"admin_delete.delegate.{sha256_hex(delegate)[:32]}.{hour}",
            limit=limit,
            expire_at=datetime.fromtimestamp(hour + 2 * HOUR_SECONDS, UTC),
        )
        if not await self._store.count_login_quota(quota):
            log_event("admin_delete_rate_limited", severity="WARNING", team=team)
            raise ApiError(
                429,
                "rate_limited",
                f"At most {limit} teams deleted an hour through the console; try again later.",
            )

    async def delete(
        self,
        team: str,
        *,
        actor_sha256: str,
        confirm: Any,
        via: str = VIA_DIRECT,
        owner: str | None = None,
    ) -> dict[str, Any]:
        """Mark ``team`` deleted (idempotent) and remove its documents, up to PURGE_BUDGET of
        them; a later call resumes. ``owner`` names the member when an owner of the team
        deletes it (M9-SPEC §7.7), None for an admin. Raises :class:`ApiError`."""
        if not valid_team_id(team):
            raise not_found()
        if not isinstance(confirm, str) or confirm != team:
            raise ApiError(
                422, "confirm_mismatch", "Type the team id in 'confirm' to delete the team."
            )
        if team in self._config.teams:
            raise ApiError(
                409, "seed_team", "This team is listed in the team file; remove it there."
            )
        now = self._now()
        by = f"owner {owner}" if owner is not None else "admin"

        def fn(current: TeamRecord | None) -> TeamDeletion[tuple[str, TeamRecord]]:
            if current is None or current.seed:
                raise not_found()
            if current.status == TEAM_DELETED:
                resumed = AdminAuditEntry(
                    time=now,
                    actor_email_sha256=actor_sha256,
                    action="team.delete",
                    team=team,
                    outcome="resumed",
                    expire_at=now + ADMIN_AUDIT_RETENTION,
                    detail=by,
                    via=via,
                )
                return TeamDeletion(result=("resumed", current), admin_audit=[resumed])
            deleted = replace(
                current,
                status=TEAM_DELETED,
                deleted_at=now,
                deleted_by_email_sha256=actor_sha256,
                reserved_until=now + TEAM_ID_RESERVATION,
                purge_complete=False,
            )
            entry = AdminAuditEntry(
                time=now,
                actor_email_sha256=actor_sha256,
                action="team.delete",
                team=team,
                outcome="deleted",
                expire_at=now + ADMIN_AUDIT_RETENTION,
                detail=f"members {current.members}; {by}",
                via=via,
            )
            return TeamDeletion(result=("deleted", deleted), team=deleted, admin_audit=[entry])

        outcome, record = await self._store.delete_team(team, fn)
        # This instance forgets at once; every other one reads the record on each request.
        self._credentials.forget_team(team)
        self._roster.invalidate(team)
        self._names.pop(team, None)
        log_event("team_deleted", team=team, outcome=outcome, by_owner=owner is not None)
        complete = await self._store.purge_team(team, PURGE_BUDGET)
        if complete:
            log_event("team_removed", team=team)
        return {
            "team": team,
            "status": TEAM_DELETED,
            "removal": "complete" if complete else "pending",
            "deleted_at": format_time(record.deleted_at),
            "reserved_until": format_time(record.reserved_until),
        }


def _unavailable() -> ApiError:
    """M9-SPEC §7.4: taken, reserved, the file's, recently deleted or not empty: one answer,
    so the reply says nothing about which."""
    return ApiError(
        409,
        "team_id_unavailable",
        "That team id is not available; choose another.",
    )
