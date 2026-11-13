"""The team primitives of the store contract (M9-SPEC §1, §2, §4), on both stores: creation
(uniqueness and the per-account limit under concurrency, the quotas, the account index),
the roster's index upkeep, deletion (the creator's slot, TeamGone for later writes) and the
batched, resumable removal. The Firestore half needs the emulator (scripts/test-relay.sh)."""

from __future__ import annotations

import asyncio
import gc
import os
import uuid
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import grpc
import pytest

from relay.errors import ApiError
from relay.roster import email_hash
from relay.store import (
    TEAM_ACTIVE,
    TEAM_DELETED,
    AccountRecord,
    AdminAuditEntry,
    AuditEntry,
    CredentialRecord,
    LoginCode,
    Quota,
    QuotaExceeded,
    Redemption,
    RetiredId,
    RosterChange,
    RosterEntry,
    Store,
    TeamCreation,
    TeamDeletion,
    TeamGone,
    TeamRecord,
)
from relay.store_memory import MemoryStore

from .conftest import START, emulator_host, unique_team
from .test_store_contract import make_envelope, make_request, record_for

pytestmark = pytest.mark.anyio

NO_EMULATOR = "FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh to include Firestore"
NOW = START


@pytest.fixture(params=["memory", "firestore"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[Store]:
    if request.param == "memory":
        yield MemoryStore()
        return
    if not emulator_host():
        pytest.skip(NO_EMULATOR)
    from relay.store_firestore import FirestoreStore

    fs = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-relay"))
    try:
        yield fs
    finally:
        await fs.aclose()


def new_id() -> str:
    return "k" + uuid.uuid4().hex[:20]


def new_email() -> str:
    return f"u{uuid.uuid4().hex[:16]}@example.com"


def owner_entry(member: str, email: str) -> RosterEntry:
    return RosterEntry(
        member=member,
        emails=[email],
        role="owner",
        added_by="relay",
        added_at=NOW,
        updated_at=NOW,
        subs={email: "sub-" + member},
    )


def team_record(team: str, email: str, member: str = "owner1") -> TeamRecord:
    return TeamRecord(
        id=team,
        name="Team " + team,
        status=TEAM_ACTIVE,
        seed=False,
        created_at=NOW,
        created_by_member=member,
        created_by_email_sha256=email_hash(email),
        roster_version=1,
        members=1,
        owners=1,
    )


def creating(team: str, email: str, member: str = "owner1", limit: int = 3):
    """The service's creation rule in miniature: the id must be free and the account under
    its limit."""
    record = team_record(team, email, member)
    entry = owner_entry(member, email)

    def fn(
        current: TeamRecord | None, account: AccountRecord | None, by_sub: AccountRecord | None
    ) -> TeamCreation[str]:
        if current is not None:
            raise ApiError(409, "team_exists")
        if account is not None and len(account.created) >= limit:
            raise ApiError(409, "team_limit")
        audit = AuditEntry(
            time=NOW,
            team=team,
            actor=member,
            action="team.create",
            outcome="created",
            expire_at=NOW + timedelta(days=30),
            email_sha256=[email_hash(email)],
        )
        admin = AdminAuditEntry(
            time=NOW,
            actor_email_sha256=email_hash(email),
            action="team.create",
            team=team,
            outcome="created",
            expire_at=NOW + timedelta(days=30),
        )
        return TeamCreation(
            result="created", team=record, owner=entry, audit=[audit], admin_audit=[admin]
        )

    return fn


async def create(store: Store, team: str, email: str, member: str = "owner1", **kw) -> str:
    return await store.create_team(team, email_hash(email), creating(team, email, member), **kw)


def deleting(now: datetime = NOW):
    def fn(current: TeamRecord | None) -> TeamDeletion[str]:
        if current is None:
            raise ApiError(404, "not_found")
        if current.status == TEAM_DELETED:
            return TeamDeletion(result="already")
        deleted = replace(
            current,
            status=TEAM_DELETED,
            deleted_at=now,
            reserved_until=now + timedelta(days=31),
            purge_complete=False,
        )
        entry = AdminAuditEntry(
            time=now,
            actor_email_sha256="a" * 64,
            action="team.delete",
            team=current.id,
            outcome="deleted",
            expire_at=now + timedelta(days=30),
        )
        return TeamDeletion(result="deleted", team=deleted, admin_audit=[entry])

    return fn


def add_member(member: str, email: str, role: str = "member"):
    def fn(state):
        entry = RosterEntry(
            member=member,
            emails=[email],
            role=role,
            added_by="owner1",
            added_at=NOW,
            updated_at=NOW,
        )
        return RosterChange(result=entry, put=[entry])

    return fn


def remove_member(member: str):
    return lambda state: RosterChange(result=None, remove=[member])


# Records ---------------------------------------------------------------------------------------


async def test_a_missing_team_has_no_record(store: Store):
    assert await store.get_teams([new_id()]) == {}
    assert await store.get_teams([]) == {}


async def test_a_roster_written_before_m9_reads_as_an_active_seed_team(store: Store):
    team = unique_team()
    await store.mutate_roster(team, add_member("alice", new_email(), "owner"), NOW)
    record = (await store.get_teams([team]))[team]
    assert (record.id, record.name, record.status, record.seed) == (team, team, "active", True)
    assert record.roster_version == 1 and (record.members, record.owners) == (1, 1)


async def test_ensure_seed_team_fills_the_record_once(store: Store):
    team = unique_team()
    await store.mutate_roster(team, add_member("alice", new_email(), "owner"), NOW)
    await store.mutate_roster(team, add_member("bob", new_email()), NOW)
    record = await store.ensure_seed_team(team, "Demo team", NOW)
    assert (record.name, record.status, record.seed, record.created_at) == (
        "Demo team",
        "active",
        True,
        NOW,
    )
    assert (record.members, record.owners, record.roster_version) == (2, 1, 2)
    again = await store.ensure_seed_team(team, "Renamed", NOW + timedelta(days=1))
    assert (again.name, again.created_at) == ("Demo team", NOW)
    assert (await store.get_teams([team]))[team] == again


async def test_ensure_seed_team_leaves_a_deleted_record(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.delete_team(team, deleting())
    record = await store.ensure_seed_team(team, team, NOW)
    assert record.status == TEAM_DELETED and record.seed is False


# Creating ----------------------------------------------------------------------------------------


async def test_create_writes_the_team_its_owner_the_index_and_the_audit(store: Store):
    team, email = new_id(), new_email()
    assert await create(store, team, email) == "created"
    record = (await store.get_teams([team]))[team]
    assert record == team_record(team, email)
    roster = await store.read_roster(team)
    assert roster.version == 1 and list(roster.entries) == ["owner1"]
    assert roster.entries["owner1"].subs == {email: "sub-owner1"}
    account = await store.get_account(email_hash(email))
    assert account == AccountRecord(
        key=email_hash(email), memberships={team: "owner1"}, created=[team]
    )
    assert [e.action for e in await store.list_audit(team)] == ["team.create"]
    admin = [e for e in await store.list_admin_audit(100000) if e.team == team]
    assert [(e.action, e.actor_email_sha256) for e in admin] == [("team.create", email_hash(email))]


async def test_a_creation_that_raises_writes_nothing(store: Store):
    team, email = new_id(), new_email()

    def fn(current, account, by_sub):
        raise ApiError(409, "nope")

    with pytest.raises(ApiError):
        await store.create_team(team, email_hash(email), fn)
    assert await store.get_teams([team]) == {}
    assert await store.get_account(email_hash(email)) is None


async def test_a_second_creation_of_one_id_sees_the_first(store: Store):
    team, first, second = new_id(), new_email(), new_email()
    await create(store, team, first)
    with pytest.raises(ApiError) as caught:
        await create(store, team, second, "owner2")
    assert caught.value.code == "team_exists"
    assert list((await store.read_roster(team)).entries) == ["owner1"]
    assert await store.get_account(email_hash(second)) is None


async def test_concurrent_creations_of_one_id_create_it_once(store: Store):
    team = new_id()
    emails = [new_email() for _ in range(6)]
    results = await asyncio.gather(
        *(create(store, team, e, f"owner{i}") for i, e in enumerate(emails)),
        return_exceptions=True,
    )
    assert results.count("created") == 1
    losers = [r for r in results if r != "created"]
    assert all(isinstance(r, ApiError) and r.code == "team_exists" for r in losers)
    winner = emails[results.index("created")]
    record = (await store.get_teams([team]))[team]
    assert record.created_by_email_sha256 == email_hash(winner)
    assert len((await store.read_roster(team)).entries) == 1
    for email in emails:
        account = await store.get_account(email_hash(email))
        assert (account is not None) == (email == winner)


async def test_the_per_account_limit_holds_under_concurrency(store: Store):
    email = new_email()
    teams = [new_id() for _ in range(6)]
    results = await asyncio.gather(
        *(create(store, t, email) for t in teams), return_exceptions=True
    )
    assert results.count("created") == 3
    assert all(r.code == "team_limit" for r in results if isinstance(r, ApiError))
    account = await store.get_account(email_hash(email))
    assert account is not None and len(account.created) == 3
    won = {t for t, r in zip(teams, results, strict=True) if r == "created"}
    assert set(account.created) == won


async def test_quotas_count_only_a_creation_and_refuse_over_the_limit(store: Store):
    key = "team_create.test." + uuid.uuid4().hex
    quota = Quota(key=key, limit=2, expire_at=NOW + timedelta(days=2))
    email = new_email()
    first, second, third = new_id(), new_id(), new_id()
    await create(store, first, email, quotas=[quota])
    # A refused creation counts nothing.
    with pytest.raises(ApiError):
        await create(store, first, new_email(), quotas=[quota])
    await create(store, second, email, quotas=[quota])
    with pytest.raises(QuotaExceeded):
        await create(store, third, email, quotas=[quota])
    assert await store.get_teams([third]) == {}
    account = await store.get_account(email_hash(email))
    assert account is not None and account.created == [first, second]


# The account index -------------------------------------------------------------------------------


async def test_the_roster_keeps_the_index_of_a_created_team(store: Store):
    team, owner, bob = new_id(), new_email(), new_email()
    await create(store, team, owner)
    await store.mutate_roster(team, add_member("bob", bob), NOW)
    assert (await store.get_account(email_hash(bob))).memberships == {team: "bob"}
    record = (await store.get_teams([team]))[team]
    assert (record.members, record.owners, record.roster_version) == (2, 1, 2)

    # An email moved to another entry of the same team, then taken off.
    other = new_email()

    def swap(state):
        entry = replace(state.entries["bob"], emails=[other])
        return RosterChange(result=None, put=[entry])

    await store.mutate_roster(team, swap, NOW)
    assert await store.get_account(email_hash(bob)) is None  # nothing left in it
    assert (await store.get_account(email_hash(other))).memberships == {team: "bob"}
    await store.mutate_roster(team, remove_member("bob"), NOW)
    assert await store.get_account(email_hash(other)) is None
    record = (await store.get_teams([team]))[team]
    assert (record.members, record.owners) == (1, 1)


async def test_a_seed_team_is_not_indexed(store: Store):
    team, email = unique_team(), new_email()
    await store.mutate_roster(team, add_member("alice", email, "owner"), NOW)
    await store.ensure_seed_team(team, team, NOW)
    await store.mutate_roster(team, add_member("bob", new_email()), NOW)
    assert await store.get_account(email_hash(email)) is None


async def test_one_email_on_two_created_teams(store: Store):
    first, second, email = new_id(), new_id(), new_email()
    await create(store, first, email, "ann")
    await create(store, second, new_email())
    await store.mutate_roster(second, add_member("annie", email), NOW)
    account = await store.get_account(email_hash(email))
    assert account.memberships == {first: "ann", second: "annie"}
    assert account.created == [first]


# Deleting ----------------------------------------------------------------------------------------


async def test_delete_marks_the_team_frees_the_slot_and_audits(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    assert await store.delete_team(team, deleting()) == "deleted"
    record = (await store.get_teams([team]))[team]
    assert record.status == TEAM_DELETED and record.reserved_until == NOW + timedelta(days=31)
    assert record.purge_complete is False
    account = await store.get_account(email_hash(email))
    assert account.created == [] and account.memberships == {team: "owner1"}
    admin = sorted(e.action for e in await store.list_admin_audit(100000) if e.team == team)
    assert admin == ["team.create", "team.delete"]
    # Again: the function sees the deleted record; the slot is not freed twice.
    assert await store.delete_team(team, deleting()) == "already"


async def test_a_deleted_team_takes_no_roster_change_and_mints_no_credential(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.delete_team(team, deleting())
    with pytest.raises(TeamGone):
        await store.mutate_roster(team, add_member("bob", new_email()), NOW)
    assert list((await store.read_roster(team)).entries) == ["owner1"]

    key = "c" * 64
    code = LoginCode(
        key=uuid.uuid4().hex * 2,
        login_key="l" * 64,
        team=team,
        member="owner1",
        device="d",
        challenge="x" * 43,
        created_at=NOW,
        expire_at=NOW + timedelta(minutes=2),
    )

    def redeem(doc):
        record = CredentialRecord(
            key=key,
            team=team,
            member="owner1",
            device="d",
            created_at=NOW,
            last_used_at=NOW,
            expire_at=NOW + timedelta(days=90),
        )
        return Redemption(result="ok", code=replace(code, used=True), credential=record)

    with pytest.raises(TeamGone):
        await store.redeem_code(code.key, redeem, NOW)
    assert await store.find_credential([team], key) is None


async def test_a_credential_is_found_through_its_pointer(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    key = uuid.uuid4().hex * 2
    record = CredentialRecord(
        key=key,
        team=team,
        member="owner1",
        device="d",
        created_at=NOW,
        last_used_at=NOW,
        expire_at=NOW + timedelta(days=90),
    )
    await store.redeem_code(
        uuid.uuid4().hex * 2, lambda doc: Redemption(result=None, credential=record), NOW
    )
    assert await store.find_credential([team], key) == record
    # Not among the teams asked about: the pointer names it.
    assert await store.find_credential([unique_team()], key) == record
    assert await store.find_credential([], key) == record
    later = NOW + timedelta(days=1)
    await store.touch_credential(team, key, later, later + timedelta(days=90))
    found = await store.find_credential([], key)
    assert found is not None and found.last_used_at == later


# Removal -----------------------------------------------------------------------------------------


async def _populate(store: Store, team: str, owner_email: str) -> dict[str, str]:
    """A created team with a member, a retired id, a request with its envelope, a manifest,
    presence and a credential."""
    bob = new_email()
    await store.mutate_roster(team, add_member("bob", bob), NOW)
    await store.mutate_roster(team, add_member("carol", new_email()), NOW)
    tomb = RetiredId(
        member="carol", email_sha256=["c" * 64], retired_at=NOW, expire_at=NOW + timedelta(days=31)
    )
    await store.mutate_roster(
        team, lambda state: RosterChange(result=None, remove=["carol"], retire=[tomb]), NOW
    )

    doc = make_request(team, asker="owner1", recipients=("bob",))
    env = make_envelope(team, "bob", doc.request_id)
    await store.create_request(team, "k1", record_for(doc), doc, [env], [], NOW)
    await store.put_manifest(team, "bob", {"version": 1, "capabilities": []}, NOW, [])
    await store.touch_presence(team, "bob", "inbox", NOW, timedelta(seconds=15))
    key = uuid.uuid4().hex * 2
    credential = CredentialRecord(
        key=key,
        team=team,
        member="bob",
        device="d",
        created_at=NOW,
        last_used_at=NOW,
        expire_at=NOW + timedelta(days=90),
    )
    await store.redeem_code(
        uuid.uuid4().hex * 2, lambda d: Redemption(result=None, credential=credential), NOW
    )
    return {"bob": bob, "request": doc.request_id, "credential": key}


async def _assert_gone(store: Store, team: str, made: dict[str, str], owner_email: str) -> None:
    state = await store.read_roster(team)
    assert state.entries == {} and state.retired == {}
    assert await store.get_request(team, made["request"]) is None
    assert await store.get_members(team, ["bob", "owner1"]) == {}
    page = await store.read_stream(team, "bob", "inbox", None, 10, NOW)
    assert page.messages == [] and page.head == 0
    assert await store.list_audit(team) == []
    assert await store.find_credential([team], made["credential"]) is None
    assert await store.list_credentials(team, "bob") == []
    assert await store.get_account(email_hash(made["bob"])) is None
    owner = await store.get_account(email_hash(owner_email))
    assert owner is None or team not in owner.memberships


async def test_purge_refuses_a_team_that_is_not_deleted(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    assert await store.purge_team(team, 1000) is False
    assert list((await store.read_roster(team)).entries) == ["owner1"]
    assert await store.purge_team(new_id(), 1000) is False  # no record at all


async def test_purge_removes_everything_in_one_call(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    made = await _populate(store, team, email)
    await store.delete_team(team, deleting())
    assert await store.purge_team(team, 1000) is True
    await _assert_gone(store, team, made, email)
    record = (await store.get_teams([team]))[team]
    assert record.status == TEAM_DELETED and record.purge_complete is True
    # The record itself stays: the id is reserved.
    assert await store.purge_team(team, 1000) is True


async def test_purge_in_small_batches_resumes_until_done(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    made = await _populate(store, team, email)
    await store.delete_team(team, deleting())
    calls = 0
    while not await store.purge_team(team, 2):
        calls += 1
        assert calls < 100
        assert (await store.get_teams([team]))[team].purge_complete is False
    assert calls >= 2  # it did take several
    await _assert_gone(store, team, made, email)
    assert (await store.get_teams([team]))[team].purge_complete is True


async def test_a_deleted_id_is_created_again_only_after_its_removal(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.delete_team(team, deleting())
    assert await store.purge_team(team, 1000)
    later = NOW + timedelta(days=32)

    def again(current, account, by_sub):
        assert current is not None and current.status == TEAM_DELETED and current.purge_complete
        record = replace(
            team_record(team, email, "newowner"),
            created_at=later,
            roster_version=current.roster_version + 1,
        )
        return TeamCreation(result="again", team=record, owner=owner_entry("newowner", email))

    assert await store.create_team(team, email_hash(email), again) == "again"
    record = (await store.get_teams([team]))[team]
    assert record.status == TEAM_ACTIVE and record.roster_version == 2
    assert list((await store.read_roster(team)).entries) == ["newowner"]
    account = await store.get_account(email_hash(email))
    assert account.created == [team] and account.memberships == {team: "newowner"}


# Listing -----------------------------------------------------------------------------------------


async def test_list_teams_pages_created_teams_by_id(store: Store):
    prefix = "a" + uuid.uuid4().hex[:12]
    ids = [f"{prefix}-{n}" for n in ("x", "y", "z")]
    for team in ids:
        await create(store, team, new_email())
    seed = unique_team()
    await store.ensure_seed_team(seed, seed, NOW)
    first = await store.list_teams(prefix, 2)
    assert [r.id for r in first] == ids[:2]
    rest = await store.list_teams(ids[1], 1)
    assert [r.id for r in rest] == ids[2:]
    assert all(not r.seed for r in await store.list_teams(None, 50))


async def test_admin_audit_round_trips(store: Store):
    team = new_id()
    entry = AdminAuditEntry(
        time=datetime(2026, 9, 24, 12, 0, 0, 123000, tzinfo=UTC),
        actor_email_sha256="b" * 64,
        action="team.delete",
        team=team,
        outcome="resumed",
        expire_at=NOW + timedelta(days=400),
        detail="members 3",
    )
    await store.append_admin_audit([entry])
    assert [e for e in await store.list_admin_audit(100000) if e.team == team] == [entry]


# Contention and finished calls (13 Nov 2026) ------------------------------------------------------


@pytest.mark.parametrize("team_scoped", [False, True])
async def test_a_counter_hit_at_once_lets_exactly_its_limit_through(
    store: Store, team_scoped: bool
):
    # An atomic increment, no read-then-write transaction: twenty at once take no locks.
    quota = Quota(key="hot." + uuid.uuid4().hex, limit=5, expire_at=NOW + timedelta(hours=2))
    team = unique_team()

    async def count() -> bool:
        if team_scoped:
            return await store.count_quota(team, quota)
        return await store.count_login_quota(quota)

    results = await asyncio.gather(*(count() for _ in range(20)))
    assert results.count(True) == 5
    assert await count() is False


async def test_twelve_creations_by_one_account_at_once_create_three(store: Store):
    email = new_email()
    results = await asyncio.gather(
        *(create(store, new_id(), email) for _ in range(12)), return_exceptions=True
    )
    assert results.count("created") == 3
    assert all(r.code == "team_limit" for r in results if isinstance(r, ApiError)), results
    account = await store.get_account(email_hash(email))
    assert account is not None and len(account.created) == 3


async def test_no_grpc_call_is_left_open_after_a_store_call(store: Store):
    # gRPC delivers a call's closing status to the event loop the call was made on; a call
    # still waiting for it when a test's loop closes reaches that closed loop later, and
    # "Event loop is closed" fails whatever test runs then.
    if isinstance(store, MemoryStore):
        pytest.skip("no gRPC")

    def open_calls() -> list[str]:
        # Checked right after each call returns, before anything else can run: the call must
        # be finished already, not merely soon.
        gc.collect()
        return [
            type(o).__name__
            for o in gc.get_objects()
            if isinstance(o, grpc.aio.Call) and not o.done()
        ]

    team = new_id()
    await create(store, team, new_email())
    assert open_calls() == []
    assert await store.team_has_documents(team) is True
    assert open_calls() == []
    assert await store.get_account(email_hash(new_email())) is None
    assert open_calls() == []
    assert await store.roster_version(team) >= 1
    assert open_calls() == []
    assert await store.get_boundaries(team) is None
    assert open_calls() == []
    quota = Quota(key="open." + uuid.uuid4().hex, limit=1, expire_at=NOW + timedelta(hours=2))
    assert await store.count_login_quota(quota) is True
    assert open_calls() == []


async def test_one_instances_holders_of_a_key_take_turns():
    from relay.store_firestore import _Turns

    turns = _Turns()
    inside: list[str] = []
    most = 0

    async def hold(name: str, keys: list[str]) -> None:
        nonlocal most
        async with turns.hold(keys):
            inside.append(name)
            most = max(most, len(inside))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            inside.remove(name)

    # Overlapping key sets, given in different orders: one at a time, and no deadlock.
    await asyncio.gather(hold("a", ["x", "y"]), hold("b", ["y", "x"]), hold("c", ["y", "z", "y"]))
    assert most == 1
    # Disjoint keys do not wait for each other.
    most = 0
    await asyncio.gather(hold("d", ["p"]), hold("e", ["q"]))
    assert most == 2
    assert turns._locks == {}
