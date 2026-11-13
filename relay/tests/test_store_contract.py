"""One contract, two stores (M1-SPEC §6). The Firestore half needs the emulator:
``scripts/test-relay.sh`` starts one so nothing here is skipped."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest

from relay.clock import format_time
from relay.config import load_schema, parse_team_config
from relay.errors import ApiError
from relay.manifest import ManifestValidator
from relay.service import Caller, RelayService, new_message_id, new_request_id
from relay.store import (
    DELIVERY_SCAN_LIMIT,
    STREAM_SCAN_LIMIT,
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
    StatusChange,
    Store,
    TeamBoundaries,
    ToolEvent,
)
from relay.store_memory import MemoryStore

from .conftest import SCHEMA_PATH, START, FakeClock, emulator_host, team_config_data, unique_team

pytestmark = pytest.mark.anyio

NO_EMULATOR = "FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh to include Firestore"


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


@pytest.fixture
def team() -> str:
    return unique_team()


def make_request(
    team: str, asker: str = "alice", recipients: tuple[str, ...] = ("bob",), **kw
) -> RequestDoc:
    doc = RequestDoc(
        request_id=new_request_id(),
        team=team,
        kind=kw.pop("kind", "question"),
        asker=asker,
        broadcast=kw.pop("broadcast", False),
        question=kw.pop("question", "What is the status?"),
        capability=kw.pop("capability", None),
        created_at=START,
        ack_deadline=START + timedelta(seconds=120),
        answer_deadline=START + timedelta(seconds=1800),
        expire_at=START + timedelta(days=7),
        next_deadline=kw.pop("next_deadline", START + timedelta(seconds=120)),
        recipients={m: RecipientState() for m in recipients},
    )
    assert not kw
    return doc


def make_envelope(team: str, to: str, request_id: str, stream: str = "inbox", **kw) -> Envelope:
    return Envelope(
        id=new_message_id(),
        team=team,
        stream=stream,
        type=kw.pop("type", "question"),
        sender=kw.pop("sender", "alice"),
        to=to,
        request_id=request_id,
        broadcast=False,
        time=START,
        expire_at=kw.pop("expire_at", START + timedelta(days=7)),
        data=kw.pop("data", {"question": "What is the status?"}),
    )


def audit(team: str, action: str = "request.create", **kw) -> AuditEntry:
    return AuditEntry(
        time=kw.pop("time", START),
        team=team,
        actor="alice",
        action=action,
        outcome="created",
        expire_at=START + timedelta(days=90),
        **kw,
    )


def record_for(doc: RequestDoc, body_hash: str = "h" * 64) -> IdempotencyRecord:
    return IdempotencyRecord(
        request_id=doc.request_id,
        body_hash=body_hash,
        recipients=list(doc.recipients),
        ack_deadline=doc.ack_deadline,
        answer_deadline=doc.answer_deadline,
        expire_at=doc.expire_at,
    )


async def create(store: Store, team: str, doc: RequestDoc, key: str = "k1", now=START):
    envs = [make_envelope(team, m, doc.request_id) for m in doc.recipients]
    return await store.create_request(
        team, key, record_for(doc), doc, envs, [audit(team, request_id=doc.request_id)], now
    )


# create_request ------------------------------------------------------------------------------


async def test_create_writes_request_idempotency_envelopes_and_audit(store: Store, team: str):
    cap = {"name": "staging_db_query", "params": {"n": 2**70, "k": "v"}, "environment": "staging"}
    doc = make_request(
        team, recipients=("bob", "carol"), kind="capability", capability=cap, question=None
    )
    outcome = await create(store, team, doc)
    assert outcome.created is True

    stored = await store.get_request(team, doc.request_id)
    assert stored == doc  # every field round-trips, big integers and recipient order included
    assert list(stored.recipients) == ["bob", "carol"]

    rec = await store.get_idempotency(team, "k1", START)
    assert rec == record_for(doc)

    for member in ("bob", "carol"):
        page = await store.read_stream(team, member, "inbox", 0, 50, START)
        assert [e.seq for e in page.messages] == [1]
        assert page.head == 1 and page.cursor == 0
        assert page.messages[0].to == member
    assert [a.action for a in await store.list_audit(team)] == ["request.create"]


async def test_create_with_existing_key_writes_nothing(store: Store, team: str):
    first = make_request(team)
    await create(store, team, first)
    second = make_request(team)
    outcome = await create(store, team, second)
    assert outcome.created is False
    assert outcome.record.request_id == first.request_id
    assert await store.get_request(team, second.request_id) is None
    page = await store.read_stream(team, "bob", "inbox", 0, 50, START)
    assert page.head == 1
    assert len(await store.list_audit(team)) == 1


async def test_expired_idempotency_record_is_absent_and_replaced(store: Store, team: str):
    first = make_request(team)
    await create(store, team, first)
    later = first.expire_at + timedelta(seconds=1)
    assert await store.get_idempotency(team, "k1", later) is None
    second = make_request(team)
    outcome = await create(store, team, second, now=later)
    assert outcome.created is True
    # The new record replaced the old one (both carry the same synthetic expiry).
    assert (await store.get_idempotency(team, "k1", START)).request_id == second.request_id


async def test_concurrent_creates_with_one_key_create_once(store: Store, team: str):
    docs = [make_request(team) for _ in range(4)]
    outcomes = await asyncio.gather(*(create(store, team, d) for d in docs))
    assert sum(o.created for o in outcomes) == 1
    assert len({o.record.request_id for o in outcomes}) == 1
    assert (await store.read_stream(team, "bob", "inbox", 0, 50, START)).head == 1


# mutate_request -----------------------------------------------------------------------------


async def test_mutate_writes_request_envelopes_progress_and_audit(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)

    def fn(current: RequestDoc | None) -> Mutation[str]:
        assert current is not None and current.recipients["bob"].status == "pending"
        current.recipients["bob"].status = "answered"
        current.progress_head = 1
        env = make_envelope(
            team,
            "alice",
            doc.request_id,
            stream="replies",
            type="answer",
            sender="bob",
            data={"text": "done", "data": None},
        )
        entry = ProgressEntry(
            seq=1, member="bob", text="half", pct=50, time=START, expire_at=doc.expire_at
        )
        return Mutation(
            result="ok",
            request=current,
            envelopes=[env, env],
            progress=[entry],
            audit=[audit(team, "request.reply")],
        )

    assert await store.mutate_request(team, doc.request_id, fn) == "ok"
    stored = await store.get_request(team, doc.request_id)
    assert stored.recipients["bob"].status == "answered" and stored.progress_head == 1
    page = await store.read_stream(team, "alice", "replies", 0, 50, START)
    assert [e.seq for e in page.messages] == [1, 2]
    assert page.messages[0].data == {"text": "done", "data": None}
    progress = await store.list_progress(team, doc.request_id)
    assert [(p.seq, p.member, p.text, p.pct) for p in progress] == [(1, "bob", "half", 50)]
    assert sorted(a.action for a in await store.list_audit(team)) == [
        "request.create",
        "request.reply",
    ]


async def test_mutate_that_raises_writes_nothing(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)

    def fn(current: RequestDoc | None) -> Mutation[None]:
        assert current is not None
        current.recipients["bob"].status = "acked"
        raise ApiError(410, "expired")

    with pytest.raises(ApiError):
        await store.mutate_request(team, doc.request_id, fn)
    assert (await store.get_request(team, doc.request_id)).recipients["bob"].status == "pending"
    assert (await store.read_stream(team, "alice", "replies", 0, 50, START)).head == 0


async def test_mutate_missing_request_sees_none(store: Store, team: str):
    seen = []

    def fn(current: RequestDoc | None) -> Mutation[int]:
        seen.append(current)
        return Mutation(result=7)

    assert await store.mutate_request(team, new_request_id(), fn) == 7
    assert seen[-1] is None


async def test_concurrent_mutations_do_not_lose_updates(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)

    def bump(current: RequestDoc | None) -> Mutation[int]:
        assert current is not None
        current.progress_head += 1
        env = make_envelope(team, "alice", doc.request_id, stream="replies", type="answer")
        return Mutation(result=current.progress_head, request=current, envelopes=[env])

    results = await asyncio.gather(
        *(store.mutate_request(team, doc.request_id, bump) for _ in range(5))
    )
    assert sorted(results) == [1, 2, 3, 4, 5]
    assert (await store.get_request(team, doc.request_id)).progress_head == 5
    page = await store.read_stream(team, "alice", "replies", 0, 50, START)
    assert [e.seq for e in page.messages] == [1, 2, 3, 4, 5]


# due_requests ---------------------------------------------------------------------------------


async def test_due_requests_filters_by_asker_and_deadline(store: Store, team: str):
    early = make_request(team, next_deadline=START + timedelta(seconds=10))
    late = make_request(team, next_deadline=START + timedelta(seconds=20))
    future = make_request(team, next_deadline=START + timedelta(seconds=999))
    none = make_request(team, next_deadline=None)
    other = make_request(team, asker="carol", next_deadline=START)
    for i, doc in enumerate([late, early, future, none, other]):
        await create(store, team, doc, key=f"k{i}")
    now = START + timedelta(seconds=30)
    assert await store.due_requests(team, "alice", now, 50) == [early.request_id, late.request_id]
    assert await store.due_requests(team, "alice", now, 1) == [early.request_id]
    assert await store.due_requests(team, "carol", now, 50) == [other.request_id]


# streams --------------------------------------------------------------------------------------


async def _fill_inbox(store: Store, team: str, n: int, expire_first: int = 0) -> str:
    doc = make_request(team)
    await create(store, team, doc)  # seq 1

    def fn(current: RequestDoc | None) -> Mutation[None]:
        envs = [
            make_envelope(
                team,
                "bob",
                doc.request_id,
                expire_at=START + (timedelta(seconds=1) if i < expire_first else timedelta(days=1)),
                data={"i": i},
            )
            for i in range(n)
        ]
        return Mutation(result=None, envelopes=envs)

    await store.mutate_request(team, doc.request_id, fn)
    return doc.request_id


async def test_read_stream_after_limit_cursor_and_expiry(store: Store, team: str):
    await _fill_inbox(store, team, 5, expire_first=2)  # seqs 2..6; seqs 2 and 3 expire
    now = START + timedelta(seconds=5)
    page = await store.read_stream(team, "bob", "inbox", 0, 50, now)
    assert [e.seq for e in page.messages] == [1, 4, 5, 6]
    assert page.head == 6
    page = await store.read_stream(team, "bob", "inbox", 4, 1, now)
    assert [e.seq for e in page.messages] == [5]

    assert await store.set_cursor(team, "bob", "inbox", 4, START) == 4
    assert await store.set_cursor(team, "bob", "inbox", 2, START) == 4  # never moves back
    page = await store.read_stream(team, "bob", "inbox", None, 50, now)  # from the cursor
    assert [e.seq for e in page.messages] == [5, 6] and page.cursor == 4
    with pytest.raises(BeyondHead):
        await store.set_cursor(team, "bob", "inbox", 7, START)
    assert await store.set_cursor(team, "bob", "inbox", 6, START) == 6


async def test_read_stream_empty_and_missing_stream(store: Store, team: str):
    page = await store.read_stream(team, "carol", "replies", 0, 50, START)
    assert page.messages == [] and page.head == 0 and page.cursor == 0
    assert await store.set_cursor(team, "carol", "replies", 0, START) == 0
    with pytest.raises(BeyondHead):
        await store.set_cursor(team, "carol", "replies", 1, START)


async def test_read_stream_skips_a_long_run_of_expired_envelopes(store: Store, team: str):
    if not isinstance(store, MemoryStore):
        # Same code path, fewer documents: writing 1000+ docs to the emulator is slow.
        n_expired = 120
    else:
        n_expired = STREAM_SCAN_LIMIT + 5
    await _fill_inbox(store, team, n_expired + 1, expire_first=n_expired)
    now = START + timedelta(seconds=5)
    page = await store.read_stream(team, "bob", "inbox", 1, 50, now)
    if n_expired < STREAM_SCAN_LIMIT:
        assert [e.data for e in page.messages] == [{"i": n_expired}]
    else:  # the scan is bounded; nothing unexpired within the first STREAM_SCAN_LIMIT
        assert page.messages == []
    assert page.head == n_expired + 2


# members, manifests, audit --------------------------------------------------------------------


async def test_members_manifest_and_last_seen(store: Store, team: str):
    assert await store.get_members(team, ["bob"]) == {}
    await store.touch_presence(team, "bob", "inbox", START, timedelta(seconds=60))
    manifest = {"version": 1, "capabilities": [], "big": 2**70}
    await store.put_manifest(
        team, "bob", manifest, START + timedelta(seconds=1), [audit(team, "manifest.publish")]
    )
    docs = await store.get_members(team, ["bob", "carol"])
    assert list(docs) == ["bob"]
    assert docs["bob"].manifest == manifest
    assert docs["bob"].published_at == START + timedelta(seconds=1)
    assert docs["bob"].last_seen == START  # publishing keeps last_seen
    assert docs["bob"].presence == {"inbox": START}  # ...and presence

    later = START + timedelta(seconds=59)
    await store.touch_presence(team, "bob", "inbox", later, timedelta(seconds=60))
    assert (await store.get_members(team, ["bob"]))["bob"].last_seen == START
    await store.touch_presence(
        team, "bob", "inbox", START + timedelta(seconds=60), timedelta(seconds=60)
    )
    assert (await store.get_members(team, ["bob"]))["bob"].last_seen == START + timedelta(
        seconds=60
    )
    assert [a.action for a in await store.list_audit(team)] == ["manifest.publish"]


async def test_audit_round_trip(store: Store, team: str):
    entry = audit(
        team,
        "request.reply",
        request_id="rq_" + "0" * 32,
        message_id="msg_" + "1" * 32,
        envelope_type="answer",
        to=["alice"],
        content_sha256="a" * 64,
        content_length=12,
        detail="from pending",
    )
    await store.append_audit([entry])
    await store.append_audit([audit(team, "request.ack", time=START + timedelta(seconds=1))])
    got = await store.list_audit(team)
    assert got[0] == entry
    assert [a.action for a in got] == ["request.reply", "request.ack"]
    assert await store.list_audit(unique_team()) == []


# the sweep, through the service, against both stores ------------------------------------------


async def test_concurrent_sweeps_write_each_notice_once(store: Store, team: str):
    data = team_config_data()
    data["teams"][0]["id"] = team
    config = parse_team_config(data)
    clock = FakeClock()
    service = RelayService(config, store, ManifestValidator(load_schema(SCHEMA_PATH)), clock)
    doc = make_request(team, recipients=("bob", "carol"))
    await create(store, team, doc)
    clock.advance(121)
    counts = await asyncio.gather(*(service.sweep_asker(team, "alice") for _ in range(3)))
    assert sum(counts) == 2
    page = await store.read_stream(team, "alice", "replies", 0, 50, clock())
    assert sorted((e.type, e.data["member"]) for e in page.messages) == [
        ("no_response", "bob"),
        ("no_response", "carol"),
    ]
    stored = await store.get_request(team, doc.request_id)
    assert stored.next_deadline is None
    assert {s.status for s in stored.recipients.values()} == {"no_response"}
    notices = [a for a in await store.list_audit(team) if a.action == "deadline.notice"]
    assert len(notices) == 2 and all(a.actor == "relay" for a in notices)


# expired backlogs (M1-SPEC §11.5) -------------------------------------------------------------

EXPIRED = START + timedelta(seconds=1)
LIVE = START + timedelta(days=1)
AFTER_EXPIRY = START + timedelta(seconds=5)


async def _append(store: Store, team: str, expiries: list, member: str = "bob") -> None:
    """Append one envelope per expiry to ``member``'s inbox, in transactions of at most 400
    writes (Firestore caps a transaction at 500)."""
    doc = make_request(team)
    await store.create_request(team, "k-" + doc.request_id, record_for(doc), doc, [], [], START)
    for i in range(0, len(expiries), 400):
        chunk = expiries[i : i + 400]

        def fn(current: RequestDoc | None, chunk=chunk, base=i) -> Mutation[None]:
            envs = [
                make_envelope(team, member, doc.request_id, expire_at=exp, data={"i": base + j})
                for j, exp in enumerate(chunk)
            ]
            return Mutation(result=None, envelopes=envs)

        await store.mutate_request(team, doc.request_id, fn)


async def test_a_backlog_of_more_than_the_scan_limit_of_expired_messages_drains(
    store: Store, team: str
):
    n_expired = STREAM_SCAN_LIMIT + 5
    await _append(store, team, [EXPIRED] * n_expired + [LIVE])
    live_seq = n_expired + 1

    # One read scans at most STREAM_SCAN_LIMIT, finds nothing live, and moves the stored
    # cursor past exactly what it scanned.
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert page.messages == [] and page.head == live_seq
    assert page.cursor == STREAM_SCAN_LIMIT

    # The next read from the stored cursor reaches the live message; the cursor stops just
    # before it (never past a live message) until the client acks it.
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [live_seq]
    assert page.messages[0].data == {"i": n_expired}
    assert page.cursor == n_expired
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [live_seq] and page.cursor == n_expired
    assert await store.set_cursor(team, "bob", "inbox", live_seq, START) == live_seq


async def test_the_cursor_skips_only_the_contiguous_expired_run(store: Store, team: str):
    # seqs 1-3 expired, 4 live, 5-6 expired, 7 live
    await _append(store, team, [EXPIRED] * 3 + [LIVE] + [EXPIRED] * 2 + [LIVE])
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [4, 7]
    assert page.cursor == 3  # not 6: seq 4 is live and not yet acked
    assert await store.set_cursor(team, "bob", "inbox", 4, START) == 4
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [7] and page.cursor == 6


async def test_a_peek_never_moves_the_cursor_or_stamps(store: Store, team: str):
    """M7-SPEC §1: ``advance=False`` reads what a read from the cursor would, writing nothing."""
    await _append(store, team, [EXPIRED] * 3 + [LIVE] + [EXPIRED] + [LIVE])
    for _ in range(2):
        page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY, advance=False)
        assert [e.seq for e in page.messages] == [4, 6]
        assert page.cursor == 0 and page.head == 6
    page = await store.read_stream(team, "bob", "inbox", None, 1, AFTER_EXPIRY, advance=False)
    assert [e.seq for e in page.messages] == [4] and page.cursor == 0
    # A read that may advance still does, from where the peeks left it.
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert page.cursor == 3


async def test_the_cursor_moves_only_for_reads_that_start_at_it(store: Store, team: str):
    await _append(store, team, [EXPIRED] * 4 + [LIVE])
    # An explicit `after` below the stored cursor: the gap (0, after] was never scanned.
    page = await store.read_stream(team, "bob", "inbox", 2, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [5] and page.cursor == 0
    # Nothing expired yet: nothing moves.
    page = await store.read_stream(team, "bob", "inbox", None, 50, START)
    assert [e.seq for e in page.messages] == [1, 2, 3, 4, 5] and page.cursor == 0
    # An explicit `after` equal to the stored cursor starts at it.
    page = await store.read_stream(team, "bob", "inbox", 0, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [5] and page.cursor == 4
    # A later read never moves the cursor backwards.
    assert await store.set_cursor(team, "bob", "inbox", 5, START) == 5
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert page.messages == [] and page.cursor == 5


async def test_a_small_limit_still_advances_past_the_expired_run(store: Store, team: str):
    await _append(store, team, [EXPIRED] * 30 + [LIVE, LIVE])
    page = await store.read_stream(team, "bob", "inbox", None, 1, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [31] and page.cursor == 30


# quotas (M1-SPEC §11.7) ------------------------------------------------------------------------


def quota(key: str, limit: int) -> Quota:
    return Quota(key=key, limit=limit, expire_at=START + timedelta(minutes=2))


async def test_create_counts_quotas_and_refuses_at_the_limit_writing_nothing(
    store: Store, team: str
):
    quotas = [quota("alice.requests.1", 2), quota("alice.broadcasts.1", 5)]
    for i in range(2):
        doc = make_request(team)
        envs = [make_envelope(team, "bob", doc.request_id)]
        outcome = await store.create_request(
            team, f"k{i}", record_for(doc), doc, envs, [audit(team)], START, quotas
        )
        assert outcome.created
    refused = make_request(team)
    with pytest.raises(QuotaExceeded) as exc:
        await store.create_request(
            team,
            "k-refused",
            record_for(refused),
            refused,
            [make_envelope(team, "bob", refused.request_id)],
            [audit(team)],
            START,
            quotas,
        )
    assert exc.value.quota.key == "alice.requests.1"
    assert await store.get_request(team, refused.request_id) is None
    assert await store.get_idempotency(team, "k-refused", START) is None
    assert (await store.read_stream(team, "bob", "inbox", 0, 50, START)).head == 2
    assert len(await store.list_audit(team)) == 2

    # The second quota counted too: with one more allowed there, it is the one refused.
    tight = [quota("alice.requests.2", 10), quota("alice.broadcasts.1", 2)]
    doc = make_request(team)
    with pytest.raises(QuotaExceeded) as exc:
        await store.create_request(team, "k-b", record_for(doc), doc, [], [], START, tight)
    assert exc.value.quota.key == "alice.broadcasts.1"
    # ...and the refused attempt did not count against the first.
    ok = [quota("alice.requests.2", 1)]
    doc = make_request(team)
    assert (
        await store.create_request(team, "k-c", record_for(doc), doc, [], [], START, ok)
    ).created


async def test_a_replay_does_not_count_against_a_quota(store: Store, team: str):
    q = [quota("alice.requests.9", 1)]
    first = make_request(team)
    assert (
        await store.create_request(team, "k", record_for(first), first, [], [], START, q)
    ).created
    again = make_request(team)
    outcome = await store.create_request(team, "k", record_for(again), again, [], [], START, q)
    assert outcome.created is False and outcome.record.request_id == first.request_id


async def test_quotas_are_per_team_and_key(store: Store, team: str):
    other = unique_team()
    for i, (t, key) in enumerate(
        ((team, "alice.requests.1"), (other, "alice.requests.1"), (team, "bob.x.1"))
    ):
        doc = make_request(t)
        outcome = await store.create_request(
            t, f"k{i}", record_for(doc), doc, [], [], START, [quota(key, 1)]
        )
        assert outcome.created


async def test_concurrent_creates_never_exceed_a_quota(store: Store, team: str):
    q = [quota("alice.requests.7", 3)]

    async def attempt(i: int) -> bool:
        doc = make_request(team)
        envs = [make_envelope(team, "bob", doc.request_id)]
        try:
            await store.create_request(team, f"k{i}", record_for(doc), doc, envs, [], START, q)
        except QuotaExceeded:
            return False
        return True

    results = await asyncio.gather(*(attempt(i) for i in range(6)))
    assert sum(results) == 3
    assert (await store.read_stream(team, "bob", "inbox", 0, 50, START)).head == 3


async def test_append_audit_capped(store: Store, team: str):
    q = quota("alice.refused.1", 2)
    assert await store.append_audit_capped(team, [audit(team, "a1")], q) is True
    assert await store.append_audit_capped(team, [audit(team, "a2")], q) is True
    assert await store.append_audit_capped(team, [audit(team, "a3")], q) is False
    assert sorted(a.action for a in await store.list_audit(team)) == ["a1", "a2"]
    fresh = quota("alice.refused.2", 2)
    assert await store.append_audit_capped(team, [audit(team, "a4")], fresh) is True


async def test_concurrent_capped_audits_never_exceed_the_cap(store: Store, team: str):
    q = quota("carol.refused.1", 4)
    results = await asyncio.gather(
        *(store.append_audit_capped(team, [audit(team, f"a{i}")], q) for i in range(8))
    )
    assert sum(results) == 4
    assert len(await store.list_audit(team)) == 4


async def test_count_quota(store: Store, team: str):
    # M2-SPEC §7.3, the read budget: a bare counter, nothing else written.
    q = quota("alice.reads.1", 2)
    assert await store.count_quota(team, q) is True
    assert await store.count_quota(team, q) is True
    assert await store.count_quota(team, q) is False
    assert await store.count_quota(team, q) is False
    assert await store.count_quota(team, quota("alice.reads.2", 2)) is True  # a new minute
    assert await store.count_quota(team, quota("bob.reads.1", 2)) is True  # another member
    assert await store.count_quota(unique_team(), q) is True  # another team
    assert await store.list_audit(team) == []


async def test_concurrent_counts_never_exceed_the_quota(store: Store, team: str):
    q = quota("carol.reads.1", 3)
    results = await asyncio.gather(*(store.count_quota(team, q) for _ in range(8)))
    assert sum(results) == 3


# M2-SPEC §3.1: presence per stream ------------------------------------------------------------


async def test_presence_is_recorded_per_stream_and_throttled_separately(store: Store, team: str):
    every = timedelta(seconds=15)
    at = [START + timedelta(seconds=s) for s in range(0, 40)]

    async def bob():
        return (await store.get_members(team, ["bob"]))["bob"]

    await store.touch_presence(team, "bob", "inbox", at[0], every)
    assert (await bob()).presence == {"inbox": at[0]}
    await store.touch_presence(team, "bob", "replies", at[5], every)  # its own interval
    assert (await bob()).presence == {"inbox": at[0], "replies": at[5]}
    assert (await bob()).last_seen == at[5]
    await store.touch_presence(team, "bob", "inbox", at[14], every)  # throttled
    await store.touch_presence(team, "bob", "replies", at[19], every)  # throttled
    assert (await bob()).presence == {"inbox": at[0], "replies": at[5]}
    await store.touch_presence(team, "bob", "inbox", at[15], every)
    assert (await bob()).presence == {"inbox": at[15], "replies": at[5]}
    assert (await bob()).last_seen == at[15]
    await store.touch_presence(team, "bob", "replies", at[20], every)
    got = await bob()
    assert got.presence == {"inbox": at[15], "replies": at[20]} and got.last_seen == at[20]
    # A write never moves last_seen backwards (it is the later of the two).
    await store.touch_presence(team, "carol", "replies", at[30], every)
    await store.touch_presence(team, "carol", "inbox", at[10], every)
    carol = (await store.get_members(team, ["carol"]))["carol"]
    assert carol.presence == {"replies": at[30], "inbox": at[10]}
    assert carol.last_seen == at[30]
    assert (await bob()).presence == {"inbox": at[15], "replies": at[20]}  # per member


async def test_presence_survives_publishing_a_manifest(store: Store, team: str):
    await store.touch_presence(team, "bob", "replies", START, timedelta(seconds=15))
    await store.put_manifest(team, "bob", {"version": 1, "capabilities": []}, START, [])
    assert (await store.get_members(team, ["bob"]))["bob"].presence == {"replies": START}


# M2-SPEC §3.2: delivery times on cursor advance ----------------------------------------------

T1 = START + timedelta(seconds=1)
T2 = START + timedelta(seconds=2)
T3 = START + timedelta(seconds=3)


async def _append_to(store: Store, team: str, request_id: str, envelopes: list[Envelope]) -> None:
    def fn(current: RequestDoc | None) -> Mutation[None]:
        return Mutation(result=None, envelopes=envelopes)

    await store.mutate_request(team, request_id, fn)


async def test_set_cursor_stamps_delivered_at_and_answer_delivered_at(store: Store, team: str):
    doc = make_request(team, recipients=("bob", "carol"))
    await create(store, team, doc)  # a question in bob's and carol's inbox, seq 1 each
    assert await store.set_cursor(team, "bob", "inbox", 1, T1) == 1
    stored = await store.get_request(team, doc.request_id)
    assert stored.recipients["bob"].delivered_at == T1
    assert stored.recipients["carol"].delivered_at is None
    assert stored.updated_at == T1

    rid = doc.request_id
    answer = make_envelope(
        team, "alice", rid, stream="replies", type="answer", sender="bob", data={"text": "x"}
    )
    notice = make_envelope(
        team,
        "alice",
        rid,
        stream="replies",
        type="no_response",
        sender="relay",
        data={"member": "carol", "detail": "No response yet from carol."},
    )
    await _append_to(store, team, rid, [notice, answer])
    assert await store.set_cursor(team, "alice", "replies", 2, T2) == 2
    stored = await store.get_request(team, rid)
    assert stored.recipients["bob"].answer_delivered_at == T2
    assert stored.recipients["carol"].answer_delivered_at is None  # a notice sets nothing
    assert stored.recipients["carol"].delivered_at is None
    assert stored.updated_at == T2


async def test_capability_calls_are_stamped_like_questions(store: Store, team: str):
    doc = make_request(team, kind="capability", question=None)
    await store.create_request(
        team,
        "k",
        record_for(doc),
        doc,
        [make_envelope(team, "bob", doc.request_id, type="capability_call", data={})],
        [],
        START,
    )
    await store.set_cursor(team, "bob", "inbox", 1, T1)
    assert (await store.get_request(team, doc.request_id)).recipients["bob"].delivered_at == T1


async def test_delivery_times_are_first_write_wins(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)
    rid = doc.request_id
    await store.set_cursor(team, "bob", "inbox", 1, T1)
    # A second copy of the question (a redelivery) is passed later: nothing is overwritten.
    await _append_to(store, team, rid, [make_envelope(team, "bob", rid)])
    answers = [
        make_envelope(team, "alice", rid, stream="replies", type="answer", sender="bob")
        for _ in range(2)
    ]
    await _append_to(store, team, rid, answers[:1])
    await store.set_cursor(team, "alice", "replies", 1, T1)
    await _append_to(store, team, rid, answers[1:])
    before = await store.get_request(team, rid)
    assert await store.set_cursor(team, "bob", "inbox", 2, T3) == 2
    assert await store.set_cursor(team, "alice", "replies", 2, T3) == 2
    after = await store.get_request(team, rid)
    assert after.recipients["bob"].delivered_at == T1
    assert after.recipients["bob"].answer_delivered_at == T1
    assert after == before  # nothing changed, so updated_at did not move either


async def test_a_cursor_that_does_not_move_stamps_nothing(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)
    await store.set_cursor(team, "bob", "inbox", 0, T1)
    assert (await store.get_request(team, doc.request_id)).recipients["bob"].delivered_at is None
    await store.set_cursor(team, "bob", "inbox", 1, T1)
    await store.set_cursor(team, "bob", "inbox", 1, T2)
    await store.set_cursor(team, "bob", "inbox", 0, T3)
    assert (await store.get_request(team, doc.request_id)).recipients["bob"].delivered_at == T1


async def test_stamps_skip_expired_missing_and_foreign_requests(store: Store, team: str):
    expired = make_request(team)
    expired.expire_at = START + timedelta(seconds=2)
    await create(store, team, expired, key="k-exp")
    live = make_request(team, recipients=("carol",))
    await create(store, team, live, key="k-live")  # carol's inbox only
    ghost = new_request_id()
    envs = [
        make_envelope(team, "bob", ghost),  # no such request
        make_envelope(team, "bob", live.request_id),  # bob is not one of its recipients
    ]
    await _append_to(store, team, expired.request_id, envs)
    assert await store.set_cursor(team, "bob", "inbox", 3, T3) == 3
    assert (await store.get_request(team, expired.request_id)) == expired  # untouched
    assert (await store.get_request(team, live.request_id)) == live
    assert await store.get_request(team, ghost) is None


async def test_one_advance_stamps_at_most_the_first_100_messages(store: Store, team: str):
    docs = [make_request(team) for _ in range(DELIVERY_SCAN_LIMIT + 1)]
    for i, doc in enumerate(docs):
        await store.create_request(team, f"k{i}", record_for(doc), doc, [], [], START)
    envs = [make_envelope(team, "bob", doc.request_id) for doc in docs]
    await _append_to(store, team, docs[0].request_id, envs)
    assert await store.set_cursor(team, "bob", "inbox", len(docs), T1) == len(docs)
    stamped = [
        (await store.get_request(team, d.request_id)).recipients["bob"].delivered_at for d in docs
    ]
    assert stamped[:DELIVERY_SCAN_LIMIT] == [T1] * DELIVERY_SCAN_LIMIT
    assert stamped[DELIVERY_SCAN_LIMIT] is None  # beyond the bound: left unstamped


async def test_the_automatic_advance_stamps_deliveries_first_write_wins(store: Store, team: str):
    # The store's rule is the same for both advances: it stamps the live requests of the
    # messages passed. (In the service an envelope expires with its request, so the automatic
    # advance, which only passes expired messages, finds nothing live to stamp.)
    first = make_request(team)
    second = make_request(team)
    for i, doc in enumerate((first, second)):
        await store.create_request(team, f"k{i}", record_for(doc), doc, [], [], START)
    rid1, rid2 = first.request_id, second.request_id
    await _append_to(
        store,
        team,
        rid1,
        [
            make_envelope(team, "bob", rid1, expire_at=LIVE),  # seq 1, delivered normally
            make_envelope(team, "bob", rid1, expire_at=EXPIRED),  # seq 2
            make_envelope(team, "bob", rid2, expire_at=EXPIRED),  # seq 3
            make_envelope(team, "bob", rid2, expire_at=LIVE),  # seq 4
        ],
    )
    await store.set_cursor(team, "bob", "inbox", 1, START)
    page = await store.read_stream(team, "bob", "inbox", None, 50, AFTER_EXPIRY)
    assert [e.seq for e in page.messages] == [4] and page.cursor == 3
    one = await store.get_request(team, rid1)
    two = await store.get_request(team, rid2)
    assert one.recipients["bob"].delivered_at == START  # not overwritten by the advance
    assert two.recipients["bob"].delivered_at == AFTER_EXPIRY  # stamped by the advance
    assert two.updated_at == AFTER_EXPIRY
    await store.set_cursor(team, "bob", "inbox", 4, AFTER_EXPIRY + timedelta(seconds=9))
    assert (await store.get_request(team, rid2)).recipients["bob"].delivered_at == AFTER_EXPIRY


async def test_concurrent_advances_stamp_once(store: Store, team: str):
    doc = make_request(team)
    await create(store, team, doc)
    times = [START + timedelta(seconds=i) for i in range(1, 5)]
    await asyncio.gather(*(store.set_cursor(team, "bob", "inbox", 1, t) for t in times))
    stamped = (await store.get_request(team, doc.request_id)).recipients["bob"].delivered_at
    assert stamped in times


# M2-SPEC §3.3-§3.5: the new request fields round-trip -----------------------------------------


async def test_the_m2_request_fields_round_trip(store: Store, team: str):
    doc = make_request(team, recipients=("bob", "carol"))
    doc.updated_at = START
    await create(store, team, doc)
    assert await store.get_request(team, doc.request_id) == doc

    def fn(current: RequestDoc | None) -> Mutation[None]:
        assert current is not None
        bob = current.recipients["bob"]
        bob.delivered_at = T1
        bob.answer_delivered_at = T3
        bob.tools = [
            ToolEvent(tool="Read", status="ok", at=T1, duration_ms=12),
            ToolEvent(tool="staging_db_query", status="error", at=T2, duration_ms=None),
        ]
        bob.last_progress_pct = 92.5
        bob.answer_preview = "préview ✓ " * 3
        current.recipients["carol"].last_progress_pct = 40
        current.progress_head = 2
        current.updated_at = T3
        entries = [
            ProgressEntry(seq=1, member="bob", text="half", pct=50, time=T1, expire_at=LIVE),
            ProgressEntry(
                seq=2,
                member="bob",
                kind="tool",
                text=None,
                pct=None,
                tool="Read",
                status="ok",
                duration_ms=12,
                time=T2,
                expire_at=LIVE,
            ),
        ]
        return Mutation(result=None, request=current, progress=entries)

    await store.mutate_request(team, doc.request_id, fn)
    stored = await store.get_request(team, doc.request_id)
    bob = stored.recipients["bob"]
    assert bob.tools == [
        ToolEvent(tool="Read", status="ok", at=T1, duration_ms=12),
        ToolEvent(tool="staging_db_query", status="error", at=T2, duration_ms=None),
    ]
    assert (bob.delivered_at, bob.answer_delivered_at) == (T1, T3)
    assert bob.last_progress_pct == 92.5 and bob.answer_preview == "préview ✓ " * 3
    assert stored.recipients["carol"].last_progress_pct == 40
    assert stored.recipients["carol"].tools == [] and stored.updated_at == T3
    progress = await store.list_progress(team, doc.request_id)
    assert [(p.seq, p.kind, p.text, p.pct, p.tool, p.status, p.duration_ms) for p in progress] == [
        (1, "progress", "half", 50, None, None, None),
        (2, "tool", None, None, "Read", "ok", 12),
    ]


# M2-SPEC §3.5: the updated_at queries -----------------------------------------------------------


async def _with_updated_at(store: Store, team: str, times: list) -> list[RequestDoc]:
    docs = []
    for i, at in enumerate(times):
        doc = make_request(team)
        doc.updated_at = at
        await store.create_request(team, f"u{i}", record_for(doc), doc, [], [], START)
        docs.append(doc)
    return docs


async def test_requests_updated_after_is_ordered_bounded_and_per_team(store: Store, team: str):
    at = [START + timedelta(seconds=s) for s in range(6)]
    docs = await _with_updated_at(store, team, [at[3], at[1], at[2], at[2], None, at[5]])
    await _with_updated_at(store, unique_team(), [at[4]])  # another team's request
    key = {d.request_id: (d.updated_at, d.request_id) for d in docs if d.updated_at}
    expected = sorted(key, key=lambda rid: key[rid])  # by (updated_at, request_id)

    got = await store.requests_updated_after(team, START, 50)
    assert [d.request_id for d in got] == expected  # no updated_at: never returned
    assert await store.requests_updated_after(team, START, 50) == [
        next(d for d in docs if d.request_id == rid) for rid in expected
    ]
    got = await store.requests_updated_after(team, at[2], 50)  # strictly after
    assert [d.request_id for d in got] == expected[3:]
    got = await store.requests_updated_after(team, START, 2)
    assert [d.request_id for d in got] == expected[:2]
    got = await store.requests_updated_after(team, START, 50, descending=True)
    assert [d.request_id for d in got] == expected[::-1]
    got = await store.requests_updated_after(team, at[1], 3, descending=True)
    assert [d.request_id for d in got] == expected[::-1][:3]
    assert await store.requests_updated_after(team, at[5], 50) == []


async def test_requests_updated_at_returns_one_group_by_id(store: Store, team: str):
    at = START + timedelta(seconds=7)
    docs = await _with_updated_at(store, team, [at, T1, at, at])
    group = sorted(d.request_id for d in docs if d.updated_at == at)
    assert [d.request_id for d in await store.requests_updated_at(team, at, 50)] == group
    assert [d.request_id for d in await store.requests_updated_at(team, at, 2)] == group[:2]
    assert await store.requests_updated_at(team, T2, 50) == []


# M2-SPEC §7.1: updated_at is monotonic --------------------------------------------------------

MS = timedelta(milliseconds=1)


def _set_updated_at(at) -> object:
    """A mutation that writes the request back with ``updated_at = at`` (a writer's now)."""

    def fn(current: RequestDoc | None) -> Mutation[None]:
        assert current is not None
        current.updated_at = at
        return Mutation(result=None, request=current)

    return fn


async def _updated_at(store: Store, team: str, request_id: str):
    return (await store.get_request(team, request_id)).updated_at


async def test_a_write_never_moves_updated_at_backwards(store: Store, team: str):
    doc = make_request(team)
    doc.updated_at = T3
    await create(store, team, doc)
    rid = doc.request_id

    await store.mutate_request(team, rid, _set_updated_at(T1))  # a writer whose clock is behind
    assert await _updated_at(store, team, rid) == T3 + MS
    await store.mutate_request(team, rid, _set_updated_at(T3 + MS))  # equal to the stored one
    assert await _updated_at(store, team, rid) == T3 + 2 * MS
    await store.mutate_request(team, rid, _set_updated_at(None))  # none set: still forward
    assert await _updated_at(store, team, rid) == T3 + 3 * MS
    later = T3 + timedelta(seconds=10)
    await store.mutate_request(team, rid, _set_updated_at(later))  # a later clock stands
    assert await _updated_at(store, team, rid) == later

    # A delivery stamp with an older clock moves it forward too.
    assert await store.set_cursor(team, "bob", "inbox", 1, T1) == 1
    stored = await store.get_request(team, rid)
    assert stored.recipients["bob"].delivered_at == T1
    assert stored.updated_at == later + MS


async def test_a_mutation_that_writes_nothing_leaves_updated_at_alone(store: Store, team: str):
    doc = make_request(team)
    doc.updated_at = T2
    await create(store, team, doc)
    await store.mutate_request(team, doc.request_id, lambda current: Mutation(result=None))
    assert await _updated_at(store, team, doc.request_id) == T2


async def test_a_request_written_before_m2_takes_the_writers_time(store: Store, team: str):
    doc = make_request(team)  # no updated_at
    await create(store, team, doc)
    await store.mutate_request(team, doc.request_id, _set_updated_at(T1))
    assert await _updated_at(store, team, doc.request_id) == T1


async def test_concurrent_writers_with_one_clock_commit_distinct_increasing_times(
    store: Store, team: str
):
    # Five writers stamp the same `now`; whichever order they commit in (Firestore retries
    # the losers, which then read the winner's value), each lands 1 ms after the previous.
    doc = make_request(team)
    doc.updated_at = START
    await create(store, team, doc)
    rid = doc.request_id

    def bump(current: RequestDoc | None) -> Mutation[None]:
        assert current is not None
        current.progress_head += 1
        current.updated_at = T1
        return Mutation(result=None, request=current)

    await asyncio.gather(*(store.mutate_request(team, rid, bump) for _ in range(5)))
    stored = await store.get_request(team, rid)
    assert stored.progress_head == 5
    assert stored.updated_at == T1 + 4 * MS


async def test_two_writers_and_a_clock_that_goes_backwards(store: Store, team: str):
    """Two relay instances share one store; the second's clock is 10 s behind the first's,
    and then the first's clock steps back too. Every change still moves updated_at forward,
    and a feed poll from the previous next_since always sees the change."""
    data = team_config_data(min_ack_timeout_seconds=2)
    data["teams"][0]["id"] = team
    config = parse_team_config(data)
    validator = ManifestValidator(load_schema(SCHEMA_PATH))
    ahead = FakeClock(START + timedelta(seconds=10))
    behind = FakeClock(START)
    one = RelayService(config, store, validator, ahead)
    two = RelayService(config, store, validator, behind)
    alice, bob = Caller(team, "alice"), Caller(team, "bob")

    _, created = await one.create_request(
        alice,
        {"idempotency_key": "k-two-writers", "kind": "question", "to": ["bob"], "question": "Q?"},
    )
    rid = created["request_id"]
    feed = await one.activity(alice, "2026-09-01T00:00:00Z", None)
    assert [e["request_id"] for e in feed["requests"]] == [rid]
    since = feed["next_since"]
    stamps = [feed["requests"][0]["updated_at"]]

    async def changed() -> None:
        nonlocal since
        # Either instance serves the feed; the one whose clock is behind is used here.
        page = await two.activity(alice, since, None)
        assert [e["request_id"] for e in page["requests"]] == [rid], len(stamps)
        stamps.append(page["requests"][0]["updated_at"])
        since = page["next_since"]

    await two.ack(bob, rid)
    await changed()
    await two.progress(bob, rid, {"text": "looking", "pct": 10})
    await changed()
    await two.set_cursor(bob, "inbox", {"acked_seq": 1})  # delivered_at
    await changed()
    ahead.current = START - timedelta(seconds=30)  # the first clock steps back as well
    await one.tool_event(bob, rid, {"tool": "Read", "status": "ok"})
    await changed()
    await one.reply(bob, rid, {"idempotency_key": "r-two-writers", "text": "Here."})
    await changed()

    first = START + timedelta(seconds=10)
    assert stamps == [format_time(first + i * MS) for i in range(6)]
    # The delivery stamp and the ack keep each writer's own clock; only updated_at is floored.
    stored = await store.get_request(team, rid)
    assert stored.recipients["bob"].acked_at == START
    assert stored.recipients["bob"].delivered_at == START


# Boundaries schema v3 and the member status (local folders only, 13 Nov 2026) ---------------

TOPIC_ONLY = TeamBoundaries(version=3, topic="Our work", updated_at=START, updated_by="alice")


def _writing(new: TeamBoundaries):
    def fn(current, actor) -> BoundariesChange[None]:
        return BoundariesChange(result=None, boundaries=new)

    return fn


async def test_boundaries_round_trip(store: Store, team: str):
    await store.set_boundaries(team, "alice", _writing(TOPIC_ONLY))
    assert await store.get_boundaries(team) == TOPIC_ONLY


@pytest.mark.parametrize(
    "status",
    [
        {
            "daemon": {"version": "1.0.0", "started_at": "2026-09-23T12:00:00.000Z"},
            "folder_count": 20,
        },
        # An older plugin's status, as an earlier relay stored it: kept as it is.
        {
            "daemon": {"version": "0.9.0", "started_at": "2026-09-23T12:00:00.000Z"},
            "folders": {"repo_roots": 1, "clones": 2, "extra_folders": 0},
            "drive": {"connected": True},
            "sources": {"boundaries_version": 3, "missing": ["repo:example-labs/api"]},
        },
    ],
)
async def test_a_status_round_trips(store: Store, team: str, status: dict):
    def fn(current, entry) -> StatusChange[None]:
        return StatusChange(result=None, status=MemberStatus(status=status, seen_at=START))

    await store.set_member_status(team, "alice", fn)
    assert await store.get_member_statuses(team, ["alice"]) == {
        "alice": MemberStatus(status=status, seen_at=START)
    }


async def test_a_new_document_holds_the_v3_fields_only():
    """Written whole: over an earlier relay's document (schema v2), the write leaves the topic,
    version and who and when, nothing else."""
    if not emulator_host():
        pytest.skip(NO_EMULATOR)
    from relay.store_firestore import FirestoreStore, _read

    fs = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-relay"))
    try:
        team = unique_team()
        await fs._boundaries(team).set(  # noqa: SLF001 - an earlier relay's exact shape
            {
                "version": 2,
                "topic": "T",
                "github_orgs": ["Example-Org"],
                "orgs_since": {"example-org": 2},
                "drives": [{"domain": "example.com", "shared_drive": "D", "since": 1}],
                "member_folders": True,
                "member_folders_since": 2,
                "github_repos": [],
                "drive_folders": [],
                "updated_at": START,
                "updated_by": "alice",
            }
        )
        stored = await fs.get_boundaries(team)
        assert stored == TeamBoundaries(version=2, topic="T", updated_at=START, updated_by="alice")
        await fs.set_boundaries(team, "alice", _writing(TOPIC_ONLY))
        raw = (await _read(fs._boundaries(team))).to_dict()  # noqa: SLF001
        assert raw is not None
        assert set(raw) == {"version", "topic", "updated_at", "updated_by"}
        assert (raw["version"], raw["topic"], raw["updated_by"]) == (3, "Our work", "alice")
    finally:
        await fs.aclose()
