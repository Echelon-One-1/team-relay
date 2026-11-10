"""The roster (M6-SPEC §1): who is a member of which team, in the store.

- :class:`Roster` resolves an email to a member of one team from a per-team cache that is
  trusted for at most ROSTER_CACHE_TTL by the service clock and then validated by one small
  read of ``roster_version`` (a full reload only when the version moved). A change made
  through this process drops the team's entry at once; a change made by another instance
  lands here within ROSTER_CACHE_TTL. Before a team is first read, the team file's seed is
  upserted into its roster (once per process and team).
- The ``plan_*`` functions are the pure bodies of :meth:`Store.mutate_roster`: they check
  every invariant against the roster the transaction read (at least one owner; an email in
  at most one entry of the team; member ids ``^[a-z][a-z0-9_]{1,31}$`` and unique; at most
  50 members; 1..5 emails an entry, a seed-only token member excepted) and raise an
  :class:`ApiError` to write nothing.
- A removed member's id is **retired** for RETIRED_ID_LIFETIME, longer than any request and
  its messages can live: while retired, it can be given again only to someone holding one of
  the emails it had (the same person coming back). Otherwise a new person under an old id
  would read that id's inbox and requests.
- No identity handover by email (M6-SPEC §7.1): an owner adds an email only to their own
  entry; taking an email off anyone revokes, in the same transaction, every credential
  minted through it.
- Accounts are bound by Google ``sub`` (M6-SPEC §7.2): :func:`plan_bind` records, per roster
  email, the ``sub`` of the first account that signs in with it; a later sign-in with that
  email from another account is refused. Removing the email drops its binding.
- Invitations, not silent membership (M9-SPEC §7.2): an entry an owner adds is ``invited``
  until its person accepts it (:func:`plan_answer`); declining removes it. An invited entry
  grants nothing: :class:`TeamRoster` keeps it apart (``invited``), so every lookup that
  makes someone a member (by email, by id, the members, the roles) sees active entries only.
  Only active owners count as owners. Seed members are active from the start, and every
  entry stored before the status existed reads as active.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any

from .clock import format_time
from .config import (
    MAX_EMAILS_PER_MEMBER,
    MAX_MEMBERS_PER_TEAM,
    MEMBER_RE,
    TeamConfig,
    normalise_email,
)
from .errors import ApiError, ConfigError
from .jsonutil import sha256_hex
from .log import log_event
from .store import (
    MEMBER_ACTIVE,
    MEMBER_INVITED,
    AuditEntry,
    RetiredId,
    RosterChange,
    RosterEntry,
    RosterState,
    Store,
)

OWNER = "owner"
MEMBER = "member"
ROLES = (OWNER, MEMBER)
SEED_ACTOR = "relay"
ROSTER_CACHE_TTL = timedelta(seconds=30)
# Teams are created at run time now (M9-SPEC §1): the per-team cache keeps this many.
ROSTER_CACHE_SIZE = 2048
# A request lives at most 30 days (service.MAX_TTL), its messages and progress with it.
RETIRED_ID_LIFETIME = timedelta(days=31)


class SeedConflict(ConfigError):
    """A team of the file has the id of a team the API created (M9-SPEC §7.1)."""

    def __init__(self, team: str) -> None:
        super().__init__(
            f"team {team!r} in the team file is a team created through the API "
            "(active or deleted); give the file's team another id"
        )
        self.team = team


def email_hash(email: str) -> str:
    """What the audit keeps of an email (M6-SPEC §2): the SHA-256 of its lower-cased form."""
    return sha256_hex(email.lower())


@dataclass(frozen=True)
class TeamRoster:
    """An immutable snapshot of one team's roster. ``entries`` (and everything read through
    them) are the active members only; ``invited`` the invitations (M9-SPEC §7.2)."""

    version: int
    entries: Mapping[str, RosterEntry]
    by_email: Mapping[str, str] = field(default_factory=dict)
    invited: Mapping[str, RosterEntry] = field(default_factory=dict)
    invited_by_email: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def of(cls, state: RosterState) -> TeamRoster:
        active: dict[str, RosterEntry] = {}
        invited: dict[str, RosterEntry] = {}
        by_email: dict[str, str] = {}
        invited_by_email: dict[str, str] = {}
        for member, entry in state.entries.items():
            if entry.active:
                active[member] = entry
                target = by_email
            else:
                invited[member] = entry
                target = invited_by_email
            for email in entry.emails:
                target.setdefault(email, member)
        return cls(
            version=state.version,
            entries=active,
            by_email=by_email,
            invited=invited,
            invited_by_email=invited_by_email,
        )

    def invitation_for_email(self, email: str) -> RosterEntry | None:
        member = self.invited_by_email.get(email)
        return self.invited.get(member) if member is not None else None

    def members(self) -> tuple[str, ...]:
        return tuple(sorted(self.entries))

    def member_for_email(self, email: str) -> str | None:
        return self.by_email.get(email)

    def role(self, member: str) -> str | None:
        entry = self.entries.get(member)
        return entry.role if entry is not None else None

    def sub_for(self, member: str, email: str) -> str | None:
        """The ``sub`` the member's ``email`` is bound to, or None while unbound."""
        entry = self.entries.get(member)
        return entry.subs.get(email) if entry is not None else None


@dataclass
class _Cached:
    roster: TeamRoster
    checked_at: datetime


class Roster:
    def __init__(self, config: TeamConfig, store: Store, now: Callable[[], datetime]) -> None:
        self._config = config
        self._store = store
        self._now = now
        self._cache: OrderedDict[str, _Cached] = OrderedDict()
        self._seeded: set[str] = set()
        self._seed_locks: dict[str, asyncio.Lock] = {}

    # Seeding --------------------------------------------------------------------------------
    async def ensure_seeded(self, team: str) -> None:
        """Upsert the team file's seed into ``team``'s roster, once per process. A team the
        API created (M9-SPEC §1) has no seed.

        First the team's record is made a seed team's, in one transaction that refuses to
        adopt a record the API created (M9-SPEC §7.1): a file team whose id belongs to a
        created team, active or deleted, raises :class:`SeedConflict` and nothing of the
        seed is written (at startup the relay then refuses to start)."""
        if team in self._seeded or team not in self._config.teams:
            return
        lock = self._seed_locks.setdefault(team, asyncio.Lock())
        async with lock:
            if team in self._seeded:
                return
            now = self._now()
            name = self._config.teams[team].display_name
            record = await self._store.ensure_seed_team(team, name, now)
            if not record.seed:
                log_event("seed_team_conflict", severity="ERROR", team=team)
                raise SeedConflict(team)
            outcome = await self._store.mutate_roster(team, plan_seed(self._config, team, now), now)
            created, skipped = outcome.result
            if created or skipped:
                log_event("roster_seeded", team=team, created=created, skipped=skipped)
            self._cache.pop(team, None)
            self._seeded.add(team)

    async def seed_all(self) -> None:
        for team in self._config.team_ids():
            await self.ensure_seeded(team)

    # Reads ----------------------------------------------------------------------------------
    async def snapshot(self, team: str, *, fresh: bool = False) -> TeamRoster:
        """The team's roster: from the cache while it is younger than ROSTER_CACHE_TTL (a
        clock that went back makes it stale), else validated by ``roster_version``. With
        ``fresh``, always validated. Whether ``team`` is a team is the caller's check."""
        await self.ensure_seeded(team)
        now = self._now()
        cached = self._cache.get(team)
        if cached is not None:
            self._cache.move_to_end(team)
            age = now - cached.checked_at
            if not fresh and timedelta(0) <= age < ROSTER_CACHE_TTL:
                return cached.roster
            if await self._store.roster_version(team) == cached.roster.version:
                cached.checked_at = now
                return cached.roster
        roster = TeamRoster.of(await self._store.read_roster(team))
        self._cache[team] = _Cached(roster=roster, checked_at=now)
        self._cache.move_to_end(team)
        while len(self._cache) > ROSTER_CACHE_SIZE:
            self._cache.popitem(last=False)
        return roster

    def invalidate(self, team: str) -> None:
        self._cache.pop(team, None)

    async def member_for_email(self, team: str, email: str) -> str | None:
        """For a team of the file only (a per-team delegate's)."""
        if team not in self._config.teams:
            return None
        return (await self.snapshot(team)).member_for_email(email)

    async def bind(self, team: str, member: str, email: str, sub: str, retention: timedelta) -> str:
        """Bind ``member``'s ``email`` to ``sub`` unless it is bound already, in one roster
        transaction (M6-SPEC §7.2). Returns ``"bound"`` (recorded now), ``"same"`` (already
        bound to ``sub``), ``"other"`` (bound to another account: refuse) or ``"gone"``
        (the member no longer holds the email)."""
        now = self._now()
        outcome = await self._store.mutate_roster(
            team, plan_bind(team, member, email, sub, now, retention), now
        )
        if outcome.result == "bound":
            self._cache.pop(team, None)
            log_event("roster_bound", team=team, member=member)
        return outcome.result


# Pure change functions -------------------------------------------------------------------


def _audit(
    team: str, actor: str, action: str, outcome: str, now: datetime, retention: timedelta, **kw: Any
) -> AuditEntry:
    return AuditEntry(
        time=now,
        team=team,
        actor=actor,
        action=action,
        outcome=outcome,
        expire_at=now + retention,
        **kw,
    )


def plan_seed(
    config: TeamConfig, team: str, now: datetime
) -> Callable[[RosterState], RosterChange[tuple[list[str], list[str]]]]:
    """Create every seed member of ``team`` whose id the roster does not hold (M6-SPEC §1):
    never removes, never changes an existing entry. A seed whose email another entry already
    holds, or that would pass 50 members, is skipped (and reported), never forced in."""
    seeds = config.teams[team].seeds
    limit = config.limits.members_per_team

    def fn(state: RosterState) -> RosterChange[tuple[list[str], list[str]]]:
        taken = {email for entry in state.entries.values() for email in entry.emails}
        count = len(state.entries)
        put: list[RosterEntry] = []
        created: list[str] = []
        skipped: list[str] = []
        for seed in seeds:
            if seed.id in state.entries:
                continue
            if (
                count >= limit
                or any(email in taken for email in seed.emails)
                or _retired_for_others(state, seed.id, seed.emails, now)
            ):
                skipped.append(seed.id)
                continue
            put.append(
                RosterEntry(
                    member=seed.id,
                    emails=list(seed.emails),
                    role=seed.role,
                    added_by=SEED_ACTOR,
                    added_at=now,
                    updated_at=now,
                )
            )
            taken.update(seed.emails)
            count += 1
            created.append(seed.id)
        return RosterChange(result=(created, skipped), put=put)

    return fn


def entry_json(entry: RosterEntry, *, show_emails: bool) -> dict[str, Any]:
    return {
        "member": entry.member,
        "emails": list(entry.emails) if show_emails else None,
        "role": entry.role,
        "added_by": entry.added_by,
        "added_at": format_time(entry.added_at),
        "status": entry.status,
    }


def plan_bind(
    team: str, member: str, email: str, sub: str, now: datetime, retention: timedelta
) -> Callable[[RosterState], RosterChange[str]]:
    """Record ``sub`` on ``member``'s ``email`` when it has none (see :meth:`Roster.bind`)."""

    def fn(state: RosterState) -> RosterChange[str]:
        current = state.entries.get(member)
        # An invitation is not a membership (M9-SPEC §7.2): nothing to bind until accepted.
        if current is None or not current.active or email not in current.emails:
            return RosterChange(result="gone")
        bound = current.subs.get(email)
        if bound is not None:
            return RosterChange(result="same" if bound == sub else "other")
        entry = replace(current, subs={**current.subs, email: sub}, updated_at=now)
        audit = _audit(
            team,
            member,
            "roster.bind",
            "bound",
            now,
            retention,
            member=member,
            email_sha256=[email_hash(email)],
            detail="google account bound",
        )
        return RosterChange(result="bound", put=[entry], audit=[audit])

    return fn


def _require_owner(state: RosterState, actor: str) -> None:
    entry = state.entries.get(actor)
    if entry is None or not entry.active or entry.role != OWNER:
        raise ApiError(403, "forbidden", "Only an owner can change the team's members.")


def _email_holder(state: RosterState, email: str) -> str | None:
    for member, entry in state.entries.items():
        if email in entry.emails:
            return member
    return None


def _owners(entries: Mapping[str, RosterEntry]) -> int:
    """The active owners: an invitation to be an owner is not one yet."""
    return sum(1 for entry in entries.values() if entry.active and entry.role == OWNER)


def _last_owner(entries: Mapping[str, RosterEntry], current: RosterEntry) -> bool:
    return current.active and current.role == OWNER and _owners(entries) <= 1


def _retired_for_others(
    state: RosterState, member: str, emails: Sequence[str], now: datetime
) -> bool:
    """True when ``member`` is a retired id none of ``emails`` ever held."""
    tomb = state.retired.get(member)
    if tomb is None or now >= tomb.expire_at:
        return False
    return not any(email_hash(email) in tomb.email_sha256 for email in emails)


@dataclass(frozen=True)
class AddMember:
    member: str
    email: str
    role: str


@dataclass(frozen=True)
class UpdateMember:
    add_email: str | None
    remove_email: str | None
    role: str | None


def parse_add(raw: Any, config: TeamConfig) -> AddMember:
    """``{member, email, role?}`` (M6-SPEC §2), nothing else."""
    if not isinstance(raw, dict):
        raise ApiError(422, "invalid_body", "(body): must be an object")
    extra = set(raw) - {"member", "email", "role"}
    if extra:
        raise ApiError(422, "invalid_body", f"{sorted(extra)[0]}: extra field not permitted")
    member = raw.get("member")
    if not isinstance(member, str) or MEMBER_RE.fullmatch(member) is None:
        raise ApiError(422, "invalid_body", f"member: must match {MEMBER_RE.pattern}")
    email = _parse_email(raw.get("email"), "email", config)
    role = raw.get("role", MEMBER)
    if role not in ROLES:
        raise ApiError(422, "invalid_body", "role: must be 'owner' or 'member'")
    return AddMember(member=member, email=email, role=role)


def parse_update(raw: Any, config: TeamConfig) -> UpdateMember:
    """``{add_email?, remove_email?, role?}`` (M6-SPEC §2), at least one, nothing else."""
    if not isinstance(raw, dict):
        raise ApiError(422, "invalid_body", "(body): must be an object")
    extra = set(raw) - {"add_email", "remove_email", "role"}
    if extra:
        raise ApiError(422, "invalid_body", f"{sorted(extra)[0]}: extra field not permitted")
    if not raw:
        raise ApiError(422, "invalid_body", "(body): name add_email, remove_email or role")
    add = _parse_email(raw["add_email"], "add_email", config) if "add_email" in raw else None
    remove = None
    if "remove_email" in raw:
        remove = normalise_email(raw["remove_email"])
        if remove is None:
            raise ApiError(422, "invalid_body", "remove_email: must be an email address")
    role = raw.get("role")
    if "role" in raw and role not in ROLES:
        raise ApiError(422, "invalid_body", "role: must be 'owner' or 'member'")
    if add is not None and add == remove:
        raise ApiError(422, "invalid_body", "add_email and remove_email are the same")
    return UpdateMember(add_email=add, remove_email=remove, role=role)


def _parse_email(raw: Any, name: str, config: TeamConfig) -> str:
    email = normalise_email(raw)
    if email is None:
        raise ApiError(422, "invalid_body", f"{name}: must be one Google email address")
    if config.is_delegate_email(email):
        # M3-SPEC §2: a delegate principal is never a member principal.
        raise ApiError(422, "invalid_body", f"{name}: belongs to a delegate, not a person")
    if not config.email_allowed(email):
        # M10-SPEC §7.2: only the relay's own domains (RELAY_ALLOWED_DOMAINS) join a team.
        raise ApiError(
            403, "domain_not_allowed", f"{name}: this relay accepts its own domains' emails only"
        )
    return email


def plan_add(
    team: str,
    actor: str,
    body: AddMember,
    now: datetime,
    retention: timedelta,
    via: str | None,
    max_members: int = MAX_MEMBERS_PER_TEAM,
) -> Callable[[RosterState], RosterChange[RosterEntry]]:
    def fn(state: RosterState) -> RosterChange[RosterEntry]:
        _require_owner(state, actor)
        if body.member in state.entries:
            raise ApiError(409, "member_exists", "That member id is taken.")
        if _email_holder(state, body.email) is not None:
            raise ApiError(409, "email_taken", "That email is already on this team.")
        if len(state.entries) >= max_members:
            raise ApiError(409, "team_full", f"A team has at most {max_members} members.")
        if _retired_for_others(state, body.member, [body.email], now):
            raise ApiError(
                409,
                "member_id_retired",
                "That id belonged to someone else recently; choose another.",
            )
        # M9-SPEC §7.2: invited until they accept; it grants nothing before.
        entry = RosterEntry(
            member=body.member,
            emails=[body.email],
            role=body.role,
            added_by=actor,
            added_at=now,
            updated_at=now,
            status=MEMBER_INVITED,
        )
        audit = _audit(
            team,
            actor,
            "roster.add",
            "invited",
            now,
            retention,
            member=body.member,
            email_sha256=[email_hash(body.email)],
            detail=_detail(f"role {body.role}", via),
        )
        return RosterChange(result=entry, put=[entry], audit=[audit])

    return fn


def plan_update(
    team: str,
    actor: str,
    member: str,
    body: UpdateMember,
    now: datetime,
    retention: timedelta,
    via: str | None,
) -> Callable[[RosterState], RosterChange[RosterEntry]]:
    def fn(state: RosterState) -> RosterChange[RosterEntry]:
        _require_owner(state, actor)
        if body.add_email is not None and member != actor:
            # M6-SPEC §7.1: an email added to someone else's entry would let its holder sign
            # in as them. An owner adds only their own second account.
            raise ApiError(
                403,
                "forbidden",
                "An email can be added only to your own entry; "
                "to change someone's account, remove and re-add the member.",
            )
        current = state.entries.get(member)
        if current is None:
            raise ApiError(404, "not_found")
        emails = list(current.emails)
        subs = dict(current.subs)
        revoke: list[tuple[str, str]] = []
        audit: list[AuditEntry] = []

        def note(action: str, detail: str, hashes: Sequence[str] = ()) -> None:
            audit.append(
                _audit(
                    team,
                    actor,
                    action,
                    "changed",
                    now,
                    retention,
                    member=member,
                    email_sha256=list(hashes),
                    detail=_detail(detail, via),
                )
            )

        if body.remove_email is not None:
            if body.remove_email not in emails:
                raise ApiError(409, "no_such_email", "That member does not have that email.")
            if len(emails) == 1 and body.add_email is None:
                raise ApiError(409, "last_email", "A member keeps at least one email.")
            emails.remove(body.remove_email)
            subs.pop(body.remove_email, None)  # §7.2: its binding goes with it
            revoke.append((member, email_hash(body.remove_email)))  # §7.1
            note("roster.email_remove", "email removed", [email_hash(body.remove_email)])
        if body.add_email is not None:
            holder = _email_holder(state, body.add_email)
            if holder is not None:
                raise ApiError(409, "email_taken", "That email is already on this team.")
            if len(emails) >= MAX_EMAILS_PER_MEMBER:
                raise ApiError(
                    409, "too_many_emails", f"A member has at most {MAX_EMAILS_PER_MEMBER} emails."
                )
            emails.append(body.add_email)
            note("roster.email_add", "email added", [email_hash(body.add_email)])
        role = current.role
        if body.role is not None and body.role != current.role:
            if _last_owner(state.entries, current):
                raise ApiError(409, "last_owner", "A team keeps at least one owner.")
            role = body.role
            note("roster.role", f"role {current.role} -> {role}")
        if not audit:  # nothing to change: the entry as it is, nothing written
            return RosterChange(result=current)
        entry = replace(current, emails=emails, role=role, updated_at=now, subs=subs)
        return RosterChange(result=entry, put=[entry], audit=audit, revoke_email=revoke)

    return fn


def plan_remove(
    team: str,
    actor: str,
    member: str,
    seed_ids: frozenset[str],
    now: datetime,
    retention: timedelta,
    via: str | None,
) -> Callable[[RosterState], RosterChange[RosterEntry]]:
    def fn(state: RosterState) -> RosterChange[RosterEntry]:
        _require_owner(state, actor)
        current = state.entries.get(member)
        if current is None:
            raise ApiError(404, "not_found")
        if _last_owner(state.entries, current):
            raise ApiError(409, "last_owner", "A team keeps at least one owner.")
        if member in seed_ids:
            # The seed is upserted when absent, so a removed seed member would be back at the
            # next start: they leave the team file first (M6-SPEC §1).
            raise ApiError(
                409,
                "seed_member",
                "This member is listed in the team file; remove them there first.",
            )
        audit = _audit(
            team,
            actor,
            "roster.remove",
            "removed",
            now,
            retention,
            member=member,
            email_sha256=[email_hash(e) for e in current.emails],
            detail=_detail(f"role {current.role}{'' if current.active else '; invitation'}", via),
        )
        if not current.active:
            # An invitation withdrawn: the id never had a member, so it is not retired (a
            # tombstone it already had stays as it was).
            return RosterChange(result=current, remove=[member], audit=[audit])
        # Keep every email the id ever had while it stays retired, so the same person can
        # come back under it.
        previous = state.retired.get(member)
        hashes = list(previous.email_sha256) if previous and now < previous.expire_at else []
        hashes += [h for h in (email_hash(e) for e in current.emails) if h not in hashes]
        tomb = RetiredId(
            member=member,
            email_sha256=hashes,
            retired_at=now,
            expire_at=now + RETIRED_ID_LIFETIME,
        )
        return RosterChange(result=current, remove=[member], audit=[audit], retire=[tomb])

    return fn


def _detail(text: str, via: str | None) -> str:
    return f"{text}; via delegate" if via else text


def plan_answer(
    team: str,
    email: str,
    sub: str | None,
    accept: bool,
    now: datetime,
    retention: timedelta,
    via: str | None,
) -> Callable[[RosterState], RosterChange[RosterEntry]]:
    """Accept (the entry becomes active, and ``email`` is bound to ``sub`` when there is one)
    or decline (the entry is removed) the invitation ``email`` holds in ``team`` (M9-SPEC
    §7.2). No invitation for it: ``404``. An email bound to another Google account: ``403``."""

    def fn(state: RosterState) -> RosterChange[RosterEntry]:
        current = next(
            (e for e in state.entries.values() if not e.active and email in e.emails), None
        )
        if current is None:
            raise ApiError(404, "not_found")
        bound = current.subs.get(email)
        if sub is not None and bound is not None and bound != sub:
            raise ApiError(
                403,
                "forbidden",
                "This email now belongs to a different Google account; ask the owner.",
            )
        action, outcome = (
            ("roster.accept", "accepted") if accept else ("roster.decline", "declined")
        )
        audit = _audit(
            team,
            current.member,
            action,
            outcome,
            now,
            retention,
            member=current.member,
            email_sha256=[email_hash(email)],
            detail=_detail(f"role {current.role}; invited by {current.added_by}", via),
        )
        if not accept:
            return RosterChange(result=current, remove=[current.member], audit=[audit])
        subs = dict(current.subs)
        if sub is not None and bound is None:
            subs[email] = sub  # M6-SPEC §7.2: accepting is this account's first use
        entry = replace(current, status=MEMBER_ACTIVE, subs=subs, updated_at=now)
        return RosterChange(result=entry, put=[entry], audit=[audit])

    return fn
