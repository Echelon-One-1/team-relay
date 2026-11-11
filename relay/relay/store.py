"""The store protocol and the records it holds (M1-SPEC §6).

The protocol is a handful of high-level atomic operations, not CRUD, so the invariants
that need a transaction live in exactly one primitive each:

- :meth:`Store.create_request`: the request, its idempotency record, one envelope per
  recipient (seqs assigned) and the audit entries, or nothing, in one transaction; an
  existing unexpired idempotency record wins and nothing is written.
- :meth:`Store.mutate_request`: re-read one request, run a *pure* function over it, then
  write the new request, append the envelopes it produced to their target streams
  (assigning seqs), add progress entries and audit entries, in one transaction. Ack,
  reply, progress and the deadline sweep are all this primitive with a different function.
  The function may run more than once (Firestore retries on contention), so it must not
  have side effects; raising aborts the transaction and writes nothing.
- :meth:`Store.set_cursor`: read head and cursor, move the cursor forward and stamp the
  delivery times of the messages it passed (M2-SPEC §3.2), atomically.
- :meth:`Store.append_audit_capped`: count one against a per-minute counter and write the
  audit entries only while the counter is under its limit, atomically.
- :meth:`Store.count_quota`: count one against a per-minute counter while it is under its
  limit, atomically (the read budget, M2-SPEC §7.3).
- :meth:`Store.mutate_roster`: read a team's roster version and every roster entry, run a
  *pure* function over them, count the quotas, and write the entries it changed, delete the
  members it removed (revoking every live device credential of theirs), revoke the
  credentials minted through an email it took off a member (M6-SPEC §7.1) and bump the
  version, in one transaction (M6-SPEC §1). Seeding and the owner endpoints are all this
  primitive with a different function.
- :meth:`Store.mutate_login`: read one login, run a pure function, write its new version and
  the one-time code it minted, in one transaction (M5-SPEC §2).
- :meth:`Store.redeem_code`: read one login code, run a pure function, then write the used
  code, the credential it mints (revoking the member's least recently used live credentials
  beyond MAX_LIVE_CREDENTIALS) or revoke the credential a reused code minted, in one
  transaction (M5-SPEC §2 step 7, §3).
- :meth:`Store.create_team`: read the team and its creator's account, run a pure function,
  count the quotas, and write the team, its first owner, the creator's account (the team
  counted as created by it, and the owner's membership) and the audit, in one transaction
  (M9-SPEC §2). Two creations of one id: one wins, the other's function sees the team.
- :meth:`Store.delete_team`: read the team and its creator's account, run a pure function,
  and write the team's new version (``deleted``: from then on no credential, roster change
  or login of it counts), take it off its creator's account and write the admin audit, in
  one transaction (M9-SPEC §1, §4).
- :meth:`Store.purge_team`: remove a deleted team's documents in bounded batches, each a
  transaction that first checks the team is still deleted; resumable.
- :meth:`Store.set_boundaries`: read the team, its boundaries and the actor's roster entry, run
  a pure function, count the quotas, and write the boundaries and the audit, in one
  transaction (M10-SPEC §1). The version check and the owner rule live in that function.
- :meth:`Store.set_acceptance`: read the team, its boundaries, the member's acceptance and roster
  entry, run a pure function, count the quotas, and write the acceptance and the audit, in one
  transaction (M11-SPEC §2). The version check lives in that function.
- :meth:`Store.set_member_status`: read the team, the member's status and roster entry and the
  team's boundaries, run a pure function, and write the new status, in one transaction
  (M11-SPEC §3). The 20-second rule, and keeping only missing-source keys of the current
  boundaries' items (PICKERS-SPEC §3.3), live in that function.

A member's acceptance and status (M11-SPEC §2, §3) leave with the member: the roster
transaction that removes a member deletes both; and with the team (the purge).

A reply's full text (M11-SPEC §4) is an :class:`AnswerEntry` below its request, written by the
reply's :meth:`Store.mutate_request` and expiring with the request. It is not a field of the
request document: a broadcast's answers together could pass Firestore's 1 MiB per document.

Teams (M9-SPEC §1) are ``teams/{team}`` records. A team the API created is ``seed=False``; the
team file's teams are seed teams, and a record written before M9 (``roster_version`` only)
reads as an active seed team. A created record is never turned into a seed one (M9-SPEC
§7.1). For the teams the API created (and only those), each Google email's roster entries
(active or invited) are indexed in ``accounts/{sha256(email)}``, kept exact by the roster
transactions, so "which teams is this email on or invited to" is one read. The teams an
account created are counted on its email's document and, when the creation had a Google
``sub``, on ``accounts/{sha256("sub:" + sub)}`` too (M9-SPEC §7.6).

Roster entries (M6-SPEC §1) carry a ``status`` (M9-SPEC §7.2): ``invited`` when an owner
added them, ``active`` once accepted, for a seed member, and for every entry stored before
the field existed.

Every write of an existing request keeps its ``updated_at`` monotonic (M2-SPEC §7.1): the
store stamps it, inside the transaction that writes the request, as the later of the value
the writer set and the previous stored value plus 1 ms (:func:`monotonic_updated_at`). A
retried transaction therefore never writes an older value than a change that committed
first, whatever the writer's clock says.

Per-sender counters (:class:`Quota`) live in the store so a limit holds across instances;
:meth:`Store.create_request` checks and increments them in the creating transaction.

Implementations: :mod:`relay.store_memory` (a lock plays the transaction) and
:mod:`relay.store_firestore`. Both must pass ``tests/test_store_contract.py``. Neither
filters by business rules; expiry filtering on reads is done where noted.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal, Protocol

from .jsonutil import sha256_hex

StreamName = Literal["inbox", "replies"]
STREAMS: tuple[str, ...] = ("inbox", "replies")

Status = Literal["pending", "acked", "answered", "no_response", "timed_out"]


@dataclass
class Envelope:
    """One message in one member's stream (§5). ``seq`` is 0 until the store assigns it."""

    id: str
    team: str
    stream: str
    type: str
    sender: str  # "from" on the wire
    to: str
    request_id: str
    broadcast: bool
    time: datetime
    expire_at: datetime
    data: dict[str, Any]
    seq: int = 0


@dataclass
class ToolEvent:
    """One tool the recipient's answering session used (M2-SPEC §3.3): never its input,
    output or path, only the name, the outcome and the duration."""

    tool: str
    status: str  # "ok" | "error" | "waiting" (M4-SPEC §2)
    at: datetime
    duration_ms: int | None = None


@dataclass
class RecipientState:
    status: str = "pending"
    acked_at: datetime | None = None
    answered_at: datetime | None = None
    reply_key: str | None = None
    reply_message_id: str | None = None
    progress_count: int = 0  # progress events of kind "progress" only
    # M2-SPEC §3.2: first write wins, never overwritten.
    delivered_at: datetime | None = None
    answer_delivered_at: datetime | None = None
    tools: list[ToolEvent] = field(default_factory=list)  # §3.3, at most 50
    last_progress_pct: int | float | None = None  # the most recent pct reported
    answer_preview: str | None = None  # §3.4, the first 2000 characters of the reply


@dataclass
class RequestDoc:
    request_id: str
    team: str
    kind: str
    asker: str
    broadcast: bool
    question: str | None
    capability: dict[str, Any] | None  # {"name", "params", "environment"}
    created_at: datetime
    ack_deadline: datetime
    answer_deadline: datetime
    expire_at: datetime
    next_deadline: datetime | None
    recipients: dict[str, RecipientState]  # insertion order is the recipient order
    progress_head: int = 0
    # M2-SPEC §3.5: set on every change. None only on documents written before M2, which
    # the activity feed never returns (Firestore leaves a document without the field out
    # of a query on it, and MemoryStore does the same).
    updated_at: datetime | None = None


@dataclass
class ProgressEntry:
    """One entry of a request's progress list: a progress event (``kind="progress"``, with
    ``text`` and ``pct``) or a tool event (``kind="tool"``, with ``tool``, ``status`` and
    ``duration_ms``; M2-SPEC §3.3). One sequence covers both."""

    seq: int
    member: str
    text: str | None
    pct: int | float | None
    time: datetime
    expire_at: datetime
    kind: str = "progress"
    tool: str | None = None
    status: str | None = None
    duration_ms: int | None = None


@dataclass
class IdempotencyRecord:
    request_id: str
    body_hash: str
    recipients: list[str]
    ack_deadline: datetime
    answer_deadline: datetime
    expire_at: datetime


@dataclass
class MemberDoc:
    manifest: dict[str, Any] | None = None
    published_at: datetime | None = None
    last_seen: datetime | None = None
    # M2-SPEC §3.1: per stream ("inbox" is the answering session, "replies" the working
    # session), the last time a poll of that stream was recorded.
    presence: dict[str, datetime] = field(default_factory=dict)


@dataclass
class AuditEntry:
    time: datetime
    team: str
    actor: str
    action: str
    outcome: str
    expire_at: datetime
    request_id: str | None = None
    message_id: str | None = None
    envelope_type: str | None = None
    to: list[str] = field(default_factory=list)
    content_sha256: str | None = None
    content_length: int | None = None
    detail: str | None = None
    # M6-SPEC §2: the member a roster change or a credential is about, and the SHA-256 of
    # every email it touched (never the email itself).
    member: str | None = None
    email_sha256: list[str] = field(default_factory=list)


# Roster (M6-SPEC §1) ---------------------------------------------------------------------


# M9-SPEC §7.2: a roster entry an owner added is ``invited`` until its person accepts; only
# an ``active`` entry is a member. An entry stored without a status (every entry written
# before invitations existed) is active: that is the whole migration, no step to run.
MEMBER_ACTIVE = "active"
MEMBER_INVITED = "invited"


@dataclass
class RosterEntry:
    """``teams/{team}/roster/{member}``: who the member is (their lower-cased Google emails),
    their role and whether they are a member yet (``status``). Never expires."""

    member: str
    emails: list[str]
    role: str  # "owner" | "member"
    added_by: str
    added_at: datetime
    updated_at: datetime
    # M6-SPEC §7.2: email -> the Google ``sub`` of the account that first signed in with it.
    # An email without an entry here is not bound yet. Removing an email drops its binding.
    subs: dict[str, str] = field(default_factory=dict)
    # M9-SPEC §7.2: "active" (a member) or "invited" (grants nothing until accepted).
    status: str = MEMBER_ACTIVE

    @property
    def active(self) -> bool:
        return self.status == MEMBER_ACTIVE


@dataclass
class RetiredId:
    """``teams/{team}/retired/{member}``: a removed member's id, kept until ``expire_at``
    (past the longest a request and its messages can live) with the SHA-256 of the emails it
    had, so the id cannot be handed to someone else while its history is still readable."""

    member: str
    email_sha256: list[str]
    retired_at: datetime
    expire_at: datetime


@dataclass
class RosterState:
    """A team's roster as one transaction read it: ``roster_version`` (0 before the first
    change), every entry by member id, and the retired ids (expired ones included; the
    caller compares ``expire_at``)."""

    version: int
    entries: dict[str, RosterEntry]
    retired: dict[str, RetiredId] = field(default_factory=dict)


@dataclass
class RosterChange[T]:
    """What a :meth:`Store.mutate_roster` function asks the store to write. ``put`` entries
    are written whole; ``remove`` members are deleted and their live credentials revoked.
    The version is bumped when either is non-empty; nothing is written otherwise, and the
    quotas are counted only then."""

    result: T
    put: list[RosterEntry] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    audit: list[AuditEntry] = field(default_factory=list)
    # Written with a removal; kept (not deleted) when the id is given back, so the next
    # removal merges every email the id had. The TTL policy deletes them.
    retire: list[RetiredId] = field(default_factory=list)
    # M6-SPEC §7.1: ``(member, email_sha256)`` of an email taken off a member: every live
    # credential of that member minted through it (or recording no email) is revoked.
    revoke_email: list[tuple[str, str]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.put or self.remove or self.retire or self.revoke_email)


@dataclass
class RosterOutcome[T]:
    result: T
    version: int
    revoked: list[str]  # credential keys revoked with a removal or an email's removal


# Teams (M9-SPEC §1) ----------------------------------------------------------------------

TEAM_ACTIVE = "active"
TEAM_DELETED = "deleted"


@dataclass
class TeamRecord:
    """``teams/{team}``. ``seed`` is True for a team of the team file; ``members`` and
    ``owners`` are the roster's counts as of its last change (None before one). A deleted
    team keeps its id reserved until ``reserved_until``; ``purge_complete`` says its
    documents are gone."""

    id: str
    name: str
    status: str = TEAM_ACTIVE
    seed: bool = True
    created_at: datetime | None = None
    created_by_member: str | None = None
    created_by_email_sha256: str | None = None
    roster_version: int = 0
    members: int | None = None
    owners: int | None = None
    # M9-SPEC §7.6: the creator's Google ``sub`` (its SHA-256), when the creation had one: the
    # per-account limit counts it as well as the email.
    created_by_sub_sha256: str | None = None
    deleted_at: datetime | None = None
    deleted_by_email_sha256: str | None = None
    reserved_until: datetime | None = None
    purge_complete: bool = False

    @property
    def active(self) -> bool:
        return self.status == TEAM_ACTIVE


@dataclass
class AccountRecord:
    """``accounts/{sha256(email)}``: the teams created through the API that the email is on
    (team -> member), and those it created and has not deleted (the per-account limit)."""

    key: str
    memberships: dict[str, str] = field(default_factory=dict)
    created: list[str] = field(default_factory=list)


def account_key(email: str) -> str:
    """The account index's document id for a Google email: the SHA-256 of its lower-cased
    form (the same value the audit keeps, :func:`relay.roster.email_hash`)."""
    return sha256_hex(email.lower())


def sub_account_key(sub: str) -> str:
    """The account document of a Google account by its ``sub`` (M9-SPEC §7.6): it holds only
    the teams that account created. Never equal to an email's key (the input differs)."""
    return sha256_hex("sub:" + sub)


@dataclass
class AdminAuditEntry:
    """``admin_audit/{auto}`` (M9-SPEC §4): relay-wide, outside any team, so it outlives a
    deleted team. Never an email: the actor's SHA-256 only."""

    time: datetime
    actor_email_sha256: str
    action: str
    team: str
    outcome: str
    expire_at: datetime
    detail: str | None = None
    # M9-SPEC §7.5: "direct" (the person's own Google identity) or "delegate" (the console).
    via: str = "direct"


@dataclass
class TeamCreation[T]:
    """What a :meth:`Store.create_team` function asks the store to write: the team (whole)
    and its first owner, or nothing (``team`` None)."""

    result: T
    team: TeamRecord | None = None
    owner: RosterEntry | None = None
    audit: list[AuditEntry] = field(default_factory=list)
    admin_audit: list[AdminAuditEntry] = field(default_factory=list)


@dataclass
class TeamDeletion[T]:
    """What a :meth:`Store.delete_team` function asks the store to write: the team's new
    version (or None to leave it) and admin audit entries."""

    result: T
    team: TeamRecord | None = None
    admin_audit: list[AdminAuditEntry] = field(default_factory=list)


class TeamGone(Exception):
    """The team is deleted: a roster change or a credential for it writes nothing."""


# Boundaries (M10-SPEC §1) -------------------------------------------------------------------


@dataclass(frozen=True)
class DriveBoundary:
    """A shared Google Drive members answer from: the Workspace domain whose Drive for desktop
    mount counts, and the shared drive's name as it appears under "Shared drives"."""

    domain: str
    shared_drive: str


@dataclass(frozen=True)
class RepoBoundary:
    """PICKERS-SPEC §2.1: one GitHub repository, matched by a clone's origin
    ``github.com/<org>/<repo>``. ``id`` is GitHub's repository id from the relay's listing, or
    None when the owner pasted it (not checked against GitHub)."""

    org: str
    repo: str
    id: int | None


@dataclass(frozen=True)
class FolderBoundary:
    """PICKERS-SPEC §2.1: one folder of a shared drive (``folder_id == drive_id``: the whole
    shared drive), matched on a member's Mac by its Drive id. ``drive_id`` None: pasted as a
    link (not checked); ``folder_name`` is display text and a search hint, never a path;
    ``drive_name`` None when it could not be read."""

    domain: str
    drive_id: str | None
    folder_id: str
    folder_name: str
    drive_name: str | None


@dataclass
class TeamBoundaries:
    """``teams/{team}/settings/boundaries``: what a team's members answer about and from. The
    owners set it; ``version`` counts the changes (1 for the first). Never expires; purged
    with the team."""

    version: int
    topic: str
    github_orgs: list[str]
    # M10 name-matched drives; since PICKERS-SPEC §2.1 a write may keep these, never add one.
    drives: list[DriveBoundary]
    member_folders: bool
    updated_at: datetime
    updated_by: str
    # M10-SPEC §7.1: the version in which each item was last added: kept while the item stays,
    # the new version when it is added or added back after a removal. Orgs by lower-case name,
    # drives by domain and name; member folders while allowed (None while not).
    org_since: dict[str, int]
    drive_since: dict[DriveBoundary, int]
    member_folders_since: int | None
    # PICKERS-SPEC §2.4: picked repositories and shared-drive folders, with their ``since`` by
    # lower-case ``org/repo`` and by folder id. A document stored before them reads as empty.
    github_repos: list[RepoBoundary] = field(default_factory=list)
    drive_folders: list[FolderBoundary] = field(default_factory=list)
    repo_since: dict[str, int] = field(default_factory=dict)
    folder_since: dict[str, int] = field(default_factory=dict)


@dataclass
class BoundariesChange[T]:
    """What a :meth:`Store.set_boundaries` function asks the store to write: the team's new
    boundaries (whole) and the audit, or nothing (``boundaries`` None)."""

    result: T
    boundaries: TeamBoundaries | None = None
    audit: list[AuditEntry] = field(default_factory=list)


# A member's acceptance and status (M11-SPEC §2, §3) ----------------------------------------


@dataclass(frozen=True)
class Acceptance:
    """``teams/{team}/acceptances/{member}``: the boundaries version the member accepted and
    when. Only the member writes it (or a delegate acting for them). Never expires; removed
    with the member and with the team."""

    version: int
    accepted_at: datetime


@dataclass
class AcceptanceChange[T]:
    """What a :meth:`Store.set_acceptance` function asks the store to write: the member's new
    acceptance and the audit, or nothing (``acceptance`` None)."""

    result: T
    acceptance: Acceptance | None = None
    audit: list[AuditEntry] = field(default_factory=list)


@dataclass
class MemberStatus:
    """``teams/{team}/member_status/{member}``: what the member's background answerer last
    reported (counts, booleans and times only, as validated; since PICKERS-SPEC §3.3 also
    ``sources``: keys of the team's own boundary items its Mac could not find) and when the
    relay received it (``seen_at``, the relay's clock). Overwritten; removed with the member
    and the team."""

    status: dict[str, Any]
    seen_at: datetime


@dataclass
class StatusChange[T]:
    """What a :meth:`Store.set_member_status` function asks the store to write."""

    result: T
    status: MemberStatus | None = None


@dataclass(frozen=True)
class AnswerEntry:
    """``teams/{team}/requests/{id}/answers/{member}``: a recipient's full reply text
    (M11-SPEC §4), kept as long as its request (``expire_at`` is the request's)."""

    member: str
    text: str
    expire_at: datetime


def roster_memberships(entries: Mapping[str, RosterEntry]) -> dict[str, str]:
    """email -> member over a roster's entries, invited ones included: the account index
    says where to look (for a membership or an invitation), the roster decides which."""
    found: dict[str, str] = {}
    for member, entry in entries.items():
        for email in entry.emails:
            found.setdefault(email, member)
    return found


def membership_changes(
    before: Mapping[str, RosterEntry], put: Sequence[RosterEntry], remove: Sequence[str]
) -> dict[str, str | None]:
    """The emails whose membership a roster change moves: email -> its member after the
    change, or None when it leaves the team. Pure, for both stores' account index."""
    after = dict(before)
    for member in remove:
        after.pop(member, None)
    for entry in put:
        after[entry.member] = entry
    old, new = roster_memberships(before), roster_memberships(after)
    return {e: new.get(e) for e in sorted(set(old) | set(new)) if old.get(e) != new.get(e)}


def roster_counts(
    before: Mapping[str, RosterEntry], put: Sequence[RosterEntry], remove: Sequence[str]
) -> tuple[int, int]:
    """``(members, owners)`` after a roster change, counting active entries only (an
    invitation is not a member yet, M9-SPEC §7.2)."""
    after = dict(before)
    for member in remove:
        after.pop(member, None)
    for entry in put:
        after[entry.member] = entry
    active = [e for e in after.values() if e.active]
    return len(active), sum(1 for e in active if e.role == "owner")


# A purge batch removes at most this many documents, in one transaction (Firestore allows
# 500 writes in one).
PURGE_BATCH = 400


# Device credentials (M5-SPEC §3) ---------------------------------------------------------

# At most this many live (unrevoked, unexpired) credentials per member: minting one more
# revokes the least recently used beyond it, so a removal revokes a bounded number in its
# transaction.
MAX_LIVE_CREDENTIALS = 20


@dataclass
class CredentialRecord:
    """``teams/{team}/credentials/{key}``, ``key`` the SHA-256 hex of the whole credential.
    ``expire_at`` rolls forward with use (the TTL field)."""

    key: str
    team: str
    member: str
    device: str
    created_at: datetime
    last_used_at: datetime
    expire_at: datetime
    revoked: bool = False
    revoked_at: datetime | None = None
    # M6-SPEC §7.1: the SHA-256 of the roster email the credential was minted through. None
    # only on credentials minted before it was recorded.
    email_sha256: str | None = None

    def live(self, now: datetime) -> bool:
        return not self.revoked and now < self.expire_at


def credentials_over_cap(
    records: Sequence[CredentialRecord], now: datetime, keep: int
) -> list[CredentialRecord]:
    """The live credentials to revoke so that at most ``keep`` stay live: the least recently
    used first (ties: the oldest, then the key). Pure, for both stores."""
    live = [r for r in records if r.live(now)]
    if len(live) <= keep:
        return []
    live.sort(key=lambda r: (r.last_used_at, r.created_at, r.key))
    return live[: len(live) - keep]


# Login (M5-SPEC §2) ----------------------------------------------------------------------


@dataclass
class LoginChoice:
    team: str
    member: str


@dataclass
class LoginDoc:
    """``logins/{key}``, ``key`` the SHA-256 hex of the login id (the ``trl`` cookie and
    Google's ``state``). Steps: ``google`` → ``exchanging`` → ``choose`` → ``done``, or
    ``closed`` from any of them."""

    key: str
    port: int
    state: str  # the plugin's, returned to its listener
    challenge: str  # the plugin's PKCE challenge
    device: str
    step: str
    nonce: str
    google_verifier: str  # the relay's own PKCE verifier towards Google
    created_at: datetime
    expire_at: datetime
    csrf_sha256: str | None = None
    email: str | None = None
    choices: list[LoginChoice] = field(default_factory=list)
    sub: str | None = None  # the Google account's ``sub`` (M6-SPEC §7.2)


@dataclass
class LoginCode:
    """``login_codes/{key}``, ``key`` the SHA-256 hex of the one-time code."""

    key: str
    login_key: str
    team: str
    member: str
    device: str
    challenge: str
    created_at: datetime
    expire_at: datetime
    used: bool = False
    credential_key: str | None = None
    # The Google email the login signed in with: the token response names it (M5-SPEC §9.3)
    # and the credential records its hash (M6-SPEC §7.1).
    email: str | None = None


def revocable_by_email(record: CredentialRecord, member: str, email_sha256: str) -> bool:
    """Whether taking ``email_sha256`` off ``member`` revokes ``record`` (M6-SPEC §7.1): a
    credential of that member minted through that email, or one that does not record its
    email (it may have been). Liveness is the caller's check."""
    return record.member == member and record.email_sha256 in (email_sha256, None)


@dataclass
class LoginChange[T]:
    """What a :meth:`Store.mutate_login` function asks the store to write."""

    result: T
    login: LoginDoc | None = None  # the new version, or None to leave it
    code: LoginCode | None = None  # a code to create


@dataclass
class Redemption[T]:
    """What a :meth:`Store.redeem_code` function asks the store to write: the code's new
    version, a credential to create, the ``(team, key)`` of a credential to revoke (the one a
    reused code minted), and audit entries."""

    result: T
    code: LoginCode | None = None
    credential: CredentialRecord | None = None
    revoke: tuple[str, str] | None = None
    audit: list[AuditEntry] = field(default_factory=list)


@dataclass
class RedeemOutcome[T]:
    result: T
    revoked: list[CredentialRecord]  # revoked in the transaction (reuse, or over the cap)


@dataclass
class Mutation[T]:
    """What a :meth:`Store.mutate_request` function asks the store to write."""

    result: T
    request: RequestDoc | None = None  # the new version, or None to leave it as it was
    envelopes: list[Envelope] = field(default_factory=list)
    progress: list[ProgressEntry] = field(default_factory=list)
    audit: list[AuditEntry] = field(default_factory=list)
    # M11-SPEC §4: full reply texts, created below the request (one per recipient, ever).
    answers: list[AnswerEntry] = field(default_factory=list)


@dataclass
class CreateOutcome:
    created: bool
    record: IdempotencyRecord  # the stored one when created is False


@dataclass
class StreamPage:
    messages: list[Envelope]
    cursor: int
    head: int


# read_stream scans at most this many envelopes past ``after`` looking for unexpired ones,
# so one read has a bounded cost; a read from the stored cursor also moves the cursor past
# the expired run it scanned, so the next read starts beyond it (M1-SPEC §11.5).
STREAM_SCAN_LIMIT = 1000


# A cursor advance reads at most this many of the messages it passes, ascending, to stamp
# their delivery times (M2-SPEC §3.2); messages beyond it in one advance stay unstamped.
DELIVERY_SCAN_LIMIT = 100

# M11-SPEC §4: recent_questions reads at most this many of the asker's questions looking for
# unexpired ones (expired ones wait for TTL), so one listing has a bounded cost.
RECENT_SCAN_LIMIT = 200

DELIVERED_TYPES = frozenset({"question", "capability_call"})

# M2-SPEC §7.1: a rewritten request's updated_at is at least this much after the previous one.
UPDATED_AT_STEP = timedelta(milliseconds=1)


def monotonic_updated_at(new: datetime | None, previous: datetime | None) -> datetime | None:
    """The ``updated_at`` to store when a request whose stored value is ``previous`` is
    rewritten with ``new`` (M2-SPEC §7.1): ``max(new, previous + 1 ms)``. With no previous
    value (a document written before M2) ``new`` stands; with no new value the previous one
    still moves forward, so no write can make a request disappear from the feed or move it
    backwards. Both stores call this inside the writing transaction, on the value read
    there."""
    if previous is None:
        return new
    floor = previous + UPDATED_AT_STEP
    return floor if new is None or new < floor else new


def stamp_deliveries(
    envelopes: Sequence[Envelope], requests: dict[str, RequestDoc], now: datetime
) -> list[RequestDoc]:
    """Record delivery times for the messages a cursor advance passed (M2-SPEC §3.2), on the
    given request documents, in place; return the documents that changed.

    - an ``inbox`` question or capability call sets the recipient's ``delivered_at``;
    - a ``replies`` answer sets the answering recipient's ``answer_delivered_at``;
    - notices (``no_response``, ``timed_out``) set nothing;
    - first write wins: a time already set is never overwritten;
    - a request that is missing or expired at ``now`` is left alone (reads treat it as
      gone, and nothing about it can be delivered any more);
    - a changed request's ``updated_at`` becomes ``max(now, previous + 1 ms)`` (§7.1).

    Pure, so both stores run exactly the same rule inside their own transaction.
    """
    changed: dict[str, RequestDoc] = {}
    for env in envelopes:
        doc = requests.get(env.request_id)
        if doc is None or now >= doc.expire_at:
            continue
        if env.stream == "inbox" and env.type in DELIVERED_TYPES:
            state = doc.recipients.get(env.to)
            if state is not None and state.delivered_at is None:
                state.delivered_at = now
                changed[doc.request_id] = doc
        elif env.stream == "replies" and env.type == "answer":
            state = doc.recipients.get(env.sender)
            if state is not None and state.answer_delivered_at is None:
                state.answer_delivered_at = now
                changed[doc.request_id] = doc
    for doc in changed.values():
        doc.updated_at = monotonic_updated_at(now, doc.updated_at)  # §7.1
    return list(changed.values())


class BeyondHead(Exception):
    """``acked_seq`` is greater than the stream head."""


@dataclass(frozen=True)
class Quota:
    """A fixed-window counter: at most ``limit`` counts under ``key`` (the window is part of
    the key, so a new window starts from zero). ``expire_at`` is its TTL field."""

    key: str
    limit: int
    expire_at: datetime


class QuotaExceeded(Exception):
    """A :class:`Quota` is already at its limit; nothing was written."""

    def __init__(self, quota: Quota) -> None:
        super().__init__(quota.key)
        self.quota = quota


# Mutation functions receive the current request (None when it does not exist).
type MutateFn[T] = Callable[[RequestDoc | None], Mutation[T]]
type RosterFn[T] = Callable[[RosterState], RosterChange[T]]
type LoginFn[T] = Callable[[LoginDoc | None], LoginChange[T]]
type RedeemFn[T] = Callable[[LoginCode | None], Redemption[T]]
# The team, the creator's account by email, and by ``sub`` (None without one, M9-SPEC §7.6).
type TeamCreateFn[T] = Callable[
    [TeamRecord | None, AccountRecord | None, AccountRecord | None], TeamCreation[T]
]
type TeamDeleteFn[T] = Callable[[TeamRecord | None], TeamDeletion[T]]
# The stored boundaries (None when never set) and the actor's roster entry (None when absent).
type BoundariesFn[T] = Callable[[TeamBoundaries | None, RosterEntry | None], BoundariesChange[T]]
# The boundaries (None when never set), the member's acceptance and roster entry (None when
# absent).
type AcceptanceFn[T] = Callable[
    [TeamBoundaries | None, Acceptance | None, RosterEntry | None], AcceptanceChange[T]
]
# The member's status (None when none), roster entry (None when absent) and the team's
# boundaries (None when never set).
type StatusFn[T] = Callable[
    [MemberStatus | None, RosterEntry | None, TeamBoundaries | None], StatusChange[T]
]


class Store(Protocol):
    async def aclose(self) -> None: ...

    # Members -------------------------------------------------------------------------
    async def get_members(self, team: str, members: Sequence[str]) -> dict[str, MemberDoc]:
        """The docs that exist, keyed by member."""
        ...

    async def put_manifest(
        self,
        team: str,
        member: str,
        manifest: dict[str, Any],
        published_at: datetime,
        audit: Sequence[AuditEntry],
    ) -> None:
        """Store the discovery payload and its audit entries atomically; keep last_seen."""
        ...

    async def touch_presence(
        self, team: str, member: str, stream: str, now: datetime, min_interval: timedelta
    ) -> None:
        """Set ``presence[stream]`` to ``now`` unless it is already within ``min_interval``;
        when it is written, ``last_seen`` becomes the later of itself and ``now``."""
        ...

    # Requests ------------------------------------------------------------------------
    async def get_idempotency(
        self, team: str, key_id: str, now: datetime
    ) -> IdempotencyRecord | None:
        """The record, or None when absent or expired."""
        ...

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
        """An unexpired idempotency record wins (``created=False``, nothing written, no
        quota counted). Otherwise every quota must be under its limit (else
        :class:`QuotaExceeded` and nothing is written) and is incremented with the rest."""
        ...

    async def get_request(self, team: str, request_id: str) -> RequestDoc | None: ...

    async def list_progress(self, team: str, request_id: str) -> list[ProgressEntry]:
        """Ascending by seq."""
        ...

    async def mutate_request[T](self, team: str, request_id: str, fn: MutateFn[T]) -> T:
        """Run ``fn`` on the request read inside the transaction and write what it returns.
        A written request's ``updated_at`` is replaced by :func:`monotonic_updated_at` of the
        value ``fn`` set and the one read (M2-SPEC §7.1)."""
        ...

    async def due_requests(self, team: str, asker: str, now: datetime, limit: int) -> list[str]:
        """Ids of the asker's requests with ``next_deadline <= now``, earliest first."""
        ...

    async def requests_updated_after(
        self, team: str, since: datetime, limit: int, *, descending: bool = False
    ) -> list[RequestDoc]:
        """Up to ``limit`` of the team's requests with ``updated_at > since``, ordered by
        ``(updated_at, request_id)`` ascending (or both descending), expired ones included
        (the caller filters). One query on the single field ``updated_at``."""
        ...

    async def requests_updated_at(self, team: str, at: datetime, limit: int) -> list[RequestDoc]:
        """Up to ``limit`` of the team's requests with ``updated_at == at``, by request id."""
        ...

    async def list_answers(self, team: str, request_id: str) -> dict[str, str]:
        """M11-SPEC §4: the request's full answers, member -> text (expired ones included:
        the caller has checked the request's own expiry)."""
        ...

    async def recent_questions(
        self, team: str, asker: str, now: datetime, limit: int
    ) -> list[RequestDoc]:
        """M11-SPEC §4: up to ``limit`` of ``asker``'s questions (``kind`` "question") that
        have not expired at ``now``, newest first by ``(created_at, request_id)`` descending,
        scanning at most RECENT_SCAN_LIMIT documents. One query on ``asker``, ``kind`` and
        ``created_at`` (the composite index in ``firestore.indexes.json``)."""
        ...

    # Streams -------------------------------------------------------------------------
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
        """Up to ``limit`` unexpired envelopes with seq > ``after`` (None: the stored
        cursor) and seq <= head, ascending, skipping expired ones (TTL deletion is lazy),
        scanning at most STREAM_SCAN_LIMIT envelopes; plus the stored cursor and head.

        When the read starts at the stored cursor (``after`` is None or equal to it), the
        cursor is moved, atomically and never backwards, past the contiguous run of expired
        envelopes the scan found right after it: they can never be delivered. It never moves
        past an unexpired envelope. The returned cursor is the stored one after that move.
        That move is a cursor advance like :meth:`set_cursor`'s and stamps deliveries the
        same way, in the same transaction (M2-SPEC §3.2).

        With ``advance=False`` (a peek: M7-SPEC §1, the inbox summary) nothing is written:
        the cursor never moves and nothing is stamped."""
        ...

    async def set_cursor(
        self, team: str, member: str, stream: str, acked_seq: int, now: datetime
    ) -> int:
        """Cursor becomes max(cursor, acked_seq); raises :class:`BeyondHead`. When it moves,
        the first DELIVERY_SCAN_LIMIT messages it passed are read and
        :func:`stamp_deliveries` is applied to their requests, in the same transaction."""
        ...

    # Audit ---------------------------------------------------------------------------
    async def append_audit(self, entries: Sequence[AuditEntry]) -> None: ...

    async def append_audit_capped(
        self, team: str, entries: Sequence[AuditEntry], quota: Quota
    ) -> bool:
        """Count one against ``quota`` and write ``entries``, atomically, if the quota is
        under its limit; otherwise write nothing and return False."""
        ...

    async def list_audit(self, team: str, limit: int = 1000) -> list[AuditEntry]:
        """Oldest first. For operators and tests; the HTTP API never exposes it."""
        ...

    async def count_quota(self, team: str, quota: Quota) -> bool:
        """Count one against ``quota`` and return True, atomically, if it is under its
        limit; otherwise write nothing and return False."""
        ...

    # Roster (M6-SPEC §1) -------------------------------------------------------------
    async def roster_version(self, team: str) -> int:
        """``teams/{team}.roster_version`` (0 when unset): one small read."""
        ...

    async def read_roster(self, team: str) -> RosterState:
        """The version and every entry, read consistently (one transaction)."""
        ...

    async def mutate_roster[T](
        self, team: str, fn: RosterFn[T], now: datetime, quotas: Sequence[Quota] = ()
    ) -> RosterOutcome[T]:
        """Read the team, the roster and the retired ids; a deleted team raises
        :class:`TeamGone` (nothing written). Run ``fn`` (pure; raising writes nothing).
        When it changed something: every quota must be under its limit (else
        :class:`QuotaExceeded`, nothing written) and is counted; ``put`` entries are
        written, ``remove`` members deleted with every live credential of theirs revoked
        (``revoked_at = now``) and their acceptance and status deleted (M11-SPEC §2, §3),
        every live credential :func:`revocable_by_email` by a ``revoke_email`` pair
        revoked, ``retire`` ids written, ``roster_version`` incremented and the team's
        ``members``/``owners`` counts set, the audit written, and for a team the API created
        (``seed`` False) every account whose membership moved (:func:`membership_changes`)
        updated; all in one transaction."""
        ...

    # Teams (M9-SPEC §1) --------------------------------------------------------------
    async def get_teams(self, teams: Sequence[str]) -> dict[str, TeamRecord]:
        """The team records that exist, in one batched read. A document holding only a
        ``roster_version`` (written before M9) reads as an active seed team."""
        ...

    async def list_teams(self, after: str | None, limit: int) -> list[TeamRecord]:
        """Up to ``limit`` team records with ``seed`` False, by id, after ``after``."""
        ...

    async def ensure_seed_team(self, team: str, name: str, now: datetime) -> TeamRecord:
        """Make ``teams/{team}`` a seed team's record: create it, or fill what a record
        written before M9 lacks (id, name, status, ``seed``, ``created_at``, the roster
        counts). A record the API created (``seed`` False, active or deleted) is never
        adopted: it is returned as it is, and the caller refuses to start (M9-SPEC §7.1).
        One transaction; returns the record."""
        ...

    async def team_has_documents(self, team: str) -> bool:
        """Whether anything at all is stored under ``teams/{team}``: its record or any
        document below it (M9-SPEC §7.1: a team is created only over an empty id)."""
        ...

    async def create_team[T](
        self,
        team: str,
        email_sha256: str,
        fn: TeamCreateFn[T],
        quotas: Sequence[Quota] = (),
        sub_key: str | None = None,
    ) -> T:
        """Read the team (None when absent), the account ``email_sha256`` and, with
        ``sub_key``, the account ``sub_key``; run ``fn`` (pure; raising writes nothing). When
        it returns a team: every quota (relay-wide counters) must be under its limit (else
        :class:`QuotaExceeded`, nothing written) and is counted; the team is written whole (a
        deleted record is replaced), its owner entry written as its only roster entry, both
        accounts get the team in ``created``, the email's account the owner's membership for
        each of the owner's emails, and the audit and admin audit are written; one
        transaction."""
        ...

    async def delete_team[T](self, team: str, fn: TeamDeleteFn[T]) -> T:
        """Read the team (None when absent) and its creator's accounts (by email and by
        ``sub``); run ``fn`` (pure). When it returns a new version: write it; when that
        version is deleted and the stored one was not, take the team off both accounts'
        ``created``; write the admin audit; one transaction."""
        ...

    async def purge_team(self, team: str, budget: int) -> bool:
        """Remove up to ``budget`` of the deleted team's documents (every one under
        ``teams/{team}``, each credential's pointer, and each roster email's membership in
        the account index), in transactions of at most PURGE_BATCH that each first check the
        team is still deleted. True when nothing is left (the record is then marked
        ``purge_complete``); False when the budget ran out or the team is not deleted."""
        ...

    # Boundaries (M10-SPEC §1) -------------------------------------------------------
    async def get_boundaries(self, team: str) -> TeamBoundaries | None:
        """The team's boundaries, None when never set."""
        ...

    async def set_boundaries[T](
        self, team: str, member: str, fn: BoundariesFn[T], quotas: Sequence[Quota] = ()
    ) -> T:
        """Read the team (a deleted one raises :class:`TeamGone`, nothing written), its
        boundaries and ``member``'s roster entry; run ``fn`` (pure; raising writes nothing).
        When it returns boundaries: every quota (the team's counters) must be under its limit
        (else :class:`QuotaExceeded`, nothing written) and is counted, and the boundaries are
        written whole with the audit; one transaction."""
        ...

    # A member's acceptance and status (M11-SPEC §2, §3) ---------------------------------
    async def get_acceptances(self, team: str, members: Sequence[str]) -> dict[str, Acceptance]:
        """The acceptances that exist among ``members``', in one batched read."""
        ...

    async def set_acceptance[T](
        self, team: str, member: str, fn: AcceptanceFn[T], quotas: Sequence[Quota] = ()
    ) -> T:
        """Read the team (a deleted one raises :class:`TeamGone`, nothing written), its
        boundaries, ``member``'s acceptance and roster entry; run ``fn`` (pure; raising writes
        nothing). When it returns an acceptance: every quota (the team's counters) must be
        under its limit (else :class:`QuotaExceeded`, nothing written) and is counted, and the
        acceptance is written whole with the audit; one transaction."""
        ...

    async def get_member_statuses(
        self, team: str, members: Sequence[str]
    ) -> dict[str, MemberStatus]:
        """The statuses that exist among ``members``', in one batched read."""
        ...

    async def set_member_status[T](self, team: str, member: str, fn: StatusFn[T]) -> T:
        """Read the team (a deleted one raises :class:`TeamGone`, nothing written),
        ``member``'s status and roster entry and the team's boundaries; run ``fn`` (pure;
        raising writes nothing); write the status it returns whole; one transaction."""
        ...

    async def get_account(self, email_sha256: str) -> AccountRecord | None: ...

    async def append_admin_audit(self, entries: Sequence[AdminAuditEntry]) -> None: ...

    async def list_admin_audit(self, limit: int = 1000) -> list[AdminAuditEntry]:
        """Oldest first. For operators and tests; the HTTP API never exposes it."""
        ...

    # Device credentials (M5-SPEC §3) -------------------------------------------------
    async def find_credential(self, teams: Sequence[str], key: str) -> CredentialRecord | None:
        """The credential ``key`` (revoked or expired ones included; the caller decides): in
        whichever of ``teams`` holds it, else in the team its pointer
        (``credential_teams/{key}``, written with every credential since M9) names. One
        batched read, plus one more when only the pointer found it."""
        ...

    async def touch_credential(
        self, team: str, key: str, last_used_at: datetime, expire_at: datetime
    ) -> None:
        """Record a use (the rolling expiry, the pointer's with it) unless the credential is
        gone or revoked."""
        ...

    async def list_credentials(self, team: str, member: str) -> list[CredentialRecord]:
        """Every credential of the member, revoked and expired ones included, any order."""
        ...

    async def revoke_credential(
        self, team: str, key: str, member: str, now: datetime, audit: Sequence[AuditEntry]
    ) -> CredentialRecord | None:
        """Revoke the member's live credential ``key`` and write ``audit``, atomically;
        None (nothing written) when there is no such live credential of that member."""
        ...

    # Login (M5-SPEC §2) --------------------------------------------------------------
    async def create_login(self, login: LoginDoc) -> None: ...

    async def mutate_login[T](self, key: str, fn: LoginFn[T]) -> T:
        """Read login ``key`` (None when absent), run ``fn`` (pure; raising writes
        nothing), write the new login and create the code it minted, atomically."""
        ...

    async def redeem_code[T](self, key: str, fn: RedeemFn[T], now: datetime) -> RedeemOutcome[T]:
        """Read code ``key`` (None when absent), run ``fn`` (pure; raising writes nothing),
        then atomically: write the code's new version; create the credential and its pointer
        (revoking the member's live credentials beyond MAX_LIVE_CREDENTIALS - 1 by
        :func:`credentials_over_cap`); revoke ``revoke`` when it is live; write the audit. A
        credential for a deleted team raises :class:`TeamGone` (nothing written)."""
        ...

    async def count_login_quota(self, quota: Quota) -> bool:
        """:meth:`count_quota` for the login pages, outside any team (M5-SPEC §2)."""
        ...
