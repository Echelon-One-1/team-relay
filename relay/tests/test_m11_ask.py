"""M11-SPEC §4: asking from the console, on both stores.

- A reply's full text is kept with its request (``answers``, written in the reply's
  transaction, expiring with the request, purged with the team) and ``GET requests/{id}``
  hands each recipient's full ``answer`` next to ``answer_preview`` to the asker only: never
  to another recipient, nor to a delegate reading for one.
- ``GET me/requests`` lists the caller's own questions, newest first, unexpired, with the
  first 200 code points of each (one indexed query: asker, kind, created_at).
- A delegate with ``member-self`` asks questions for the viewer under the viewer's limits; a
  capability call through a delegate is refused.

The Firestore half needs the emulator (scripts/test-relay.sh)."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from relay.service import new_request_id
from relay.store import AnswerEntry, Mutation, RecipientState, RequestDoc, Store
from relay.store_memory import MemoryStore

from .conftest import EMAILS, START, Api, FakeClock, emulator_host, open_api
from .test_m11_member import _member_self
from .test_store_contract import create, make_request
from .test_team_store import create as create_team
from .test_team_store import deleting, new_email, new_id

pytestmark = pytest.mark.anyio

RELAY_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(params=["memory", "firestore"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[Store]:
    if request.param == "memory":
        yield MemoryStore()
        return
    if not emulator_host():
        pytest.skip("FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh")
    from relay.store_firestore import FirestoreStore

    fs = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-relay"))
    try:
        yield fs
    finally:
        await fs.aclose()


def answering(member: str, text: str, expire_at):
    def fn(doc: RequestDoc | None) -> Mutation[None]:
        assert doc is not None
        doc.recipients[member].status = "answered"
        entry = AnswerEntry(member=member, text=text, expire_at=expire_at)
        return Mutation(result=None, request=doc, answers=[entry])

    return fn


# The store: answers --------------------------------------------------------------------------


async def test_an_answer_is_written_with_its_request_and_listed(store: Store):
    team = new_id()
    doc = make_request(team, recipients=("bob", "carol"))
    await create(store, team, doc)
    assert await store.list_answers(team, doc.request_id) == {}
    long = "é" * 31999 + "🎉"
    await store.mutate_request(team, doc.request_id, answering("bob", long, doc.expire_at))
    await store.mutate_request(team, doc.request_id, answering("carol", "short", doc.expire_at))
    assert await store.list_answers(team, doc.request_id) == {"bob": long, "carol": "short"}
    assert (await store.get_request(team, doc.request_id)).recipients["bob"].status == "answered"


async def test_a_refused_mutation_writes_no_answer(store: Store):
    team = new_id()
    doc = make_request(team)
    await create(store, team, doc)

    def refuse(current: RequestDoc | None) -> Mutation[None]:
        answering("bob", "no", doc.expire_at)(current)
        raise RuntimeError("refused")

    with pytest.raises(RuntimeError):
        await store.mutate_request(team, doc.request_id, refuse)
    assert await store.list_answers(team, doc.request_id) == {}


async def test_the_purge_removes_answers(store: Store):
    team = new_id()
    await create_team(store, team, new_email())
    doc = make_request(team)
    await create(store, team, doc)
    await store.mutate_request(team, doc.request_id, answering("bob", "the answer", doc.expire_at))
    await store.delete_team(team, deleting())
    calls = 0
    while not await store.purge_team(team, 1):
        calls += 1
        assert calls < 50
    assert await store.list_answers(team, doc.request_id) == {}


# The store: recent questions -----------------------------------------------------------------


def asked(team: str, asker: str, minute: int, **kw: Any) -> RequestDoc:
    doc = make_request(team, asker=asker, **kw)
    doc.created_at = START + timedelta(minutes=minute)
    return doc


async def test_recent_questions_are_the_askers_newest_first(store: Store):
    team = new_id()
    docs = [asked(team, "alice", m) for m in (1, 3, 2)]
    tied = [asked(team, "alice", 4) for _ in range(2)]
    capability = asked(
        team,
        "alice",
        5,
        kind="capability",
        question=None,
        capability={"name": "x_y", "params": {}, "environment": "staging"},
    )
    others = asked(team, "bob", 6, recipients=("alice",))
    expired = asked(team, "alice", 7)
    expired.expire_at = START + timedelta(minutes=8)
    for i, doc in enumerate([*docs, *tied, capability, others, expired]):
        await create(store, team, doc, key=f"k{i}")
    now = START + timedelta(minutes=10)
    found = await store.recent_questions(team, "alice", now, 20)
    ties = sorted((d.request_id for d in tied), reverse=True)
    assert [d.request_id for d in found] == [
        *ties,
        docs[1].request_id,
        docs[2].request_id,
        docs[0].request_id,
    ]
    assert [d.request_id for d in await store.recent_questions(team, "alice", now, 2)] == ties
    assert await store.recent_questions(team, "carol", now, 20) == []
    # Before it expired, the expired one was the newest.
    early = await store.recent_questions(team, "alice", START + timedelta(minutes=7), 1)
    assert [d.request_id for d in early] == [expired.request_id]


async def test_recent_questions_skip_many_expired_ones(store: Store):
    team = new_id()
    keep = asked(team, "alice", 0)
    await create(store, team, keep, key="keep")
    for i in range(30):
        doc = asked(team, "alice", 1 + i)
        doc.expire_at = START + timedelta(hours=1)
        await create(store, team, doc, key=f"gone{i}")
    found = await store.recent_questions(team, "alice", START + timedelta(hours=2), 5)
    assert [d.request_id for d in found] == [keep.request_id]


def test_the_composite_index_for_recent_questions_is_declared():
    indexes = json.loads((RELAY_ROOT / "firestore.indexes.json").read_text())["indexes"]
    fields = [
        [(f["fieldPath"], f["order"]) for f in index["fields"]]
        for index in indexes
        if index["collectionGroup"] == "requests" and index["queryScope"] == "COLLECTION"
    ]
    assert [
        ("asker", "ASCENDING"),
        ("kind", "ASCENDING"),
        ("created_at", "DESCENDING"),
    ] in fields


# GET requests/{id}: the full answers ---------------------------------------------------------


async def test_the_asker_reads_every_full_answer(api: Api):
    rid = await api.ask("alice", to=["bob", "carol"])
    long = "x" * 31999 + "🎉"
    await api.reply("bob", rid, long)
    r = await api.get("alice", f"/requests/{rid}")
    assert r.status_code == 200, r.text
    recipients = r.json()["recipients"]
    assert recipients["bob"]["answer"] == long
    assert recipients["bob"]["answer_preview"] == long[:2000]
    assert recipients["carol"]["answer"] is None
    assert recipients["carol"]["answer_preview"] is None
    await api.reply("carol", rid, "short")
    recipients = (await api.get("alice", f"/requests/{rid}")).json()["recipients"]
    assert recipients["carol"]["answer"] == "short"
    assert recipients["carol"]["answer_preview"] == "short"


async def test_no_recipient_reads_an_answer_in_full(api: Api):
    rid = await api.ask("alice", to="*")
    await api.reply("bob", rid, "bob's private answer")
    await api.reply("carol", rid, "carol's private answer")
    for me in ("bob", "carol"):
        r = await api.get(me, f"/requests/{rid}")
        assert r.status_code == 200, r.text
        assert set(r.json()["recipients"]) == {me}
        mine = r.json()["recipients"][me]
        assert mine["answer"] is None
        assert mine["answer_preview"] == f"{me}'s private answer"
        other = "carol" if me == "bob" else "bob"
        assert other not in r.text


async def test_a_delegate_reads_full_answers_for_the_asker_only(api: Api):
    rid = await api.ask("alice", to=["bob", "carol"])
    await api.reply("bob", rid, "the full answer for alice")
    r = await api.delegated("GET", f"/requests/{rid}", EMAILS["alice"])
    assert r.status_code == 200
    assert r.json()["recipients"]["bob"]["answer"] == "the full answer for alice"
    r = await api.delegated("GET", f"/requests/{rid}", EMAILS["bob"])
    assert r.status_code == 200
    assert r.json()["recipients"]["bob"]["answer"] is None
    r = await api.delegated("GET", f"/requests/{rid}", EMAILS["carol"])
    assert r.status_code == 200 and "the full answer" not in r.text


async def test_an_answer_lives_as_long_as_its_request(api: Api):
    rid = await api.ask("alice", to=["bob"], answer_timeout_seconds=60, ttl_seconds=60)
    await api.reply("bob", rid, "gone with the request")
    assert (await api.get("alice", f"/requests/{rid}")).status_code == 200
    api.clock.advance(60)
    assert (await api.get("alice", f"/requests/{rid}")).status_code == 404


async def test_a_replayed_reply_keeps_the_first_answer(api: Api):
    rid = await api.ask("alice", to=["bob"])
    body = {"idempotency_key": "reply-" + uuid.uuid4().hex, "text": "first"}
    assert (await api.post("bob", f"/requests/{rid}/reply", body)).status_code == 200
    replay = {**body, "text": "second"}
    assert (await api.post("bob", f"/requests/{rid}/reply", replay)).status_code == 200
    recipients = (await api.get("alice", f"/requests/{rid}")).json()["recipients"]
    assert recipients["bob"]["answer"] == "first"


# GET me/requests --------------------------------------------------------------------------------


async def my_requests(api: Api, member: str = "alice", **params: Any) -> list[dict[str, Any]]:
    r = await api.get(member, "/me/requests", **params)
    assert r.status_code == 200, r.text
    return r.json()["requests"]


async def test_my_requests_are_my_questions_newest_first(api: Api):
    first = await api.ask("alice", to=["bob"], question="First?")
    api.clock.advance(1)
    long = "🎉" * 150 + "q" * 150
    second = await api.ask("alice", to=["bob", "carol"], question=long)
    api.clock.advance(1)
    third = await api.ask("alice", to="*", question="Everyone?")
    api.clock.advance(1)
    await api.publish("bob")
    await api.invoke("alice", "bob")
    await api.ask("bob", to=["alice"], question="Bob's own?")
    listed = await my_requests(api)
    assert listed == [
        {
            "id": third,
            "to": "*",
            "created_at": "2026-09-23T12:00:02.000Z",
            "question_preview": "Everyone?",
        },
        {
            "id": second,
            "to": ["bob", "carol"],
            "created_at": "2026-09-23T12:00:01.000Z",
            "question_preview": long[:200],
        },
        {
            "id": first,
            "to": ["bob"],
            "created_at": "2026-09-23T12:00:00.000Z",
            "question_preview": "First?",
        },
    ]
    assert len(listed[1]["question_preview"]) == 200  # code points
    assert [e["id"] for e in await my_requests(api, limit="2")] == [third, second]
    assert [e["question_preview"] for e in await my_requests(api, "bob")] == ["Bob's own?"]
    assert await my_requests(api, "carol") == []


async def test_the_default_is_20_and_the_most_is_50(api: Api):
    ids = []
    for _ in range(21):
        ids.append(await api.ask("alice", to=["bob"]))
        api.clock.advance(1)
    assert [e["id"] for e in await my_requests(api)] == ids[::-1][:20]
    assert [e["id"] for e in await my_requests(api, limit="50")] == ids[::-1]
    for bad in ("0", "51", "x", "-1", "1.5", "²", ""):
        r = await api.get("alice", "/me/requests", limit=bad)
        assert (r.status_code, r.json()["error"]) == (400, "invalid_query"), bad


async def test_expired_requests_are_not_listed(api: Api):
    gone = await api.ask("alice", to=["bob"], answer_timeout_seconds=60, ttl_seconds=60)
    api.clock.advance(1)
    kept = await api.ask("alice", to=["bob"])
    assert [e["id"] for e in await my_requests(api)] == [kept, gone]
    api.clock.advance(60)
    assert [e["id"] for e in await my_requests(api)] == [kept]


async def test_a_delegate_reads_the_viewers_requests(api: Api):
    rid = await api.ask("alice", to=["bob"])
    r = await api.delegated("GET", "/me/requests", EMAILS["alice"])
    assert r.status_code == 200 and [e["id"] for e in r.json()["requests"]] == [rid]
    r = await api.delegated("GET", "/me/requests", EMAILS["bob"])
    assert r.status_code == 200 and r.json()["requests"] == []


async def test_my_requests_reads_are_rate_limited(kind_clock: tuple[str, FakeClock]):
    kind, clock = kind_clock
    async with open_api(kind, clock, reads_per_minute=2) as api:
        for _ in range(2):
            assert (await api.get("alice", "/me/requests")).status_code == 200
        r = await api.get("alice", "/me/requests")
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        assert (await api.get("bob", "/me/requests")).status_code == 200


@pytest.fixture(params=["memory", "firestore"])
def kind_clock(request: pytest.FixtureRequest, clock: FakeClock) -> tuple[str, FakeClock]:
    return request.param, clock


# Asking through a delegate -----------------------------------------------------------------


@pytest.fixture(params=["memory", "firestore"])
async def console(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with open_api(request.param, clock, configure=_member_self) as api:
        yield api


def question(to: Any = ("bob",), text: str = "Where is the deploy log?") -> dict[str, Any]:
    return {
        "idempotency_key": "key-" + uuid.uuid4().hex,
        "kind": "question",
        "to": list(to) if isinstance(to, tuple | list) else to,
        "question": text,
    }


async def test_a_member_self_delegate_asks_for_the_viewer(console: Api):
    api = console
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question())
    assert r.status_code == 201, r.text
    rid = r.json()["request_id"]
    doc = (await api.get("alice", f"/requests/{rid}")).json()
    assert doc["asker"] == "alice" and list(doc["recipients"]) == ["bob"]
    inbox = (await api.stream("bob", "inbox"))["messages"]
    assert [(m["from"], m["request_id"]) for m in inbox] == [("alice", rid)]
    api.clock.advance(1)
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question(to="*"))
    assert r.status_code == 201, r.text
    created = [
        e
        for e in await api.store.list_audit(api.team)
        if e.action == "request.create" and e.outcome == "created"
    ]
    assert [(e.actor, e.detail) for e in created] == [("alice", "via delegate")] * 2
    assert [e["id"] for e in await my_requests(api)] == [r.json()["request_id"], rid]


async def test_a_delegate_never_invokes_a_capability(console: Api):
    api = console
    await api.publish("bob")
    body = {
        "idempotency_key": "key-" + uuid.uuid4().hex,
        "kind": "capability",
        "to": ["bob"],
        "capability": {"name": "staging_db_query", "params": {"dataset": "users"}},
    }
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=body)
    assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    assert (await api.stream("bob", "inbox"))["messages"] == []
    # The member may, as before.
    assert (await api.post("alice", "/requests", body)).status_code == 201


async def test_a_delegate_asks_under_the_viewers_limits(kind_clock: tuple[str, FakeClock]):
    kind, clock = kind_clock
    async with open_api(kind, clock, configure=_member_self, requests_per_minute=2) as api:
        assert (await api.post("alice", "/requests", question())).status_code == 201
        r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question())
        assert r.status_code == 201
        r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question())
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        r = await api.delegated("POST", "/requests", EMAILS["bob"], json=question(to=["alice"]))
        assert r.status_code == 201


async def test_a_read_only_delegate_cannot_ask(api: Api):
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question())
    assert r.status_code == 403
    assert await my_requests(api) == []


async def test_a_delegate_cannot_ask_as_someone_else(console: Api):
    api = console
    body = {**question(), "from": "bob"}
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=body)
    assert r.status_code == 422
    r = await api.delegated("POST", "/requests", EMAILS["alice"], json=question(to=["alice"]))
    assert (r.status_code, r.json()["error"]) == (400, "bad_recipients")


def test_recipient_state_has_no_full_answer_field():
    """The full text never sits on the request document (a broadcast's 50 answers of 32000
    characters would pass Firestore's 1 MiB per document): only the preview does."""
    assert "answer" not in RecipientState.__dataclass_fields__
    assert "answer_preview" in RecipientState.__dataclass_fields__
    assert new_request_id().startswith("rq_")
