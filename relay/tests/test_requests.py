"""Requests (M1-SPEC §3.5), ack (§3.8), reply (§3.9), progress (§3.10), status (§3.11)."""

from __future__ import annotations

import pytest

from .conftest import auth
from .helpers import (
    T,
    ack,
    ask,
    capability_body,
    get,
    post,
    publish,
    question_body,
    reply,
    status,
    stream,
)

pytestmark = pytest.mark.anyio


# Creating ------------------------------------------------------------------------------------


async def test_directed_question_lands_in_the_recipients_inbox_only(client):
    created = await ask(client, to=["bob"])
    assert created["created"] is True and created["recipients"] == ["bob"]
    assert created["request_id"].startswith("rq_") and len(created["request_id"]) == 35
    assert created["ack_deadline"] == "2026-09-23T12:02:00.000Z"
    assert created["answer_deadline"] == "2026-09-23T12:30:00.000Z"
    assert created["expire_at"] == "2026-09-30T12:00:00.000Z"

    inbox = await stream(client, "bob", "inbox")
    assert inbox["head"] == 1 and inbox["cursor"] == 0
    [env] = inbox["messages"]
    assert env["id"].startswith("msg_") and len(env["id"]) == 36
    assert env == {
        "id": env["id"],
        "seq": 1,
        "team": "demo",
        "stream": "inbox",
        "type": "question",
        "from": "alice",
        "to": "bob",
        "request_id": created["request_id"],
        "broadcast": False,
        "time": "2026-09-23T12:00:00.000Z",
        "expire_at": "2026-09-30T12:00:00.000Z",
        "data": {
            "question": "Where is the deploy log?",
            "ack_deadline": "2026-09-23T12:02:00.000Z",
            "answer_deadline": "2026-09-23T12:30:00.000Z",
        },
    }
    assert (await stream(client, "carol", "inbox"))["messages"] == []
    assert (await stream(client, "alice", "inbox"))["messages"] == []
    assert (await stream(client, "alice", "replies"))["messages"] == []


@pytest.mark.parametrize("field", ["from", "sender", "asker", "actor"])
async def test_a_body_naming_the_sender_is_422(client, field, memory_store):
    r = await post(client, "alice", "/requests", question_body(**{field: "bob"}))
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_body" and field in r.json()["detail"]
    assert (await stream(client, "bob", "inbox"))["head"] == 0
    audit = await memory_store.list_audit("demo")
    assert [(a.action, a.detail) for a in audit] == [("request.create", "422 invalid_body")]


@pytest.mark.parametrize(
    "mutation",
    [
        {"kind": "poll"},
        {"question": ""},
        {"question": "x" * 8001},
        {"question": None},
        {"capability": {"name": "staging_db_query", "params": {}}},
        {"to": "bob"},
        {"to": ["bob"] * 65},
        {"idempotency_key": "short"},
        {"idempotency_key": "has space in it"},
        {"idempotency_key": "k" * 129},
        {"ack_timeout_seconds": "120"},
        {"ack_timeout_seconds": 1},
        {"ack_timeout_seconds": 3601},
        {"answer_timeout_seconds": 4},
        {"answer_timeout_seconds": 86401},
        {"answer_timeout_seconds": 600, "ttl_seconds": 599},
        {"ttl_seconds": 2592001},
    ],
)
async def test_invalid_bodies_are_422(client, mutation):
    body = question_body()
    body.update(mutation)
    r = await post(client, "alice", "/requests", body)
    assert r.status_code == 422, r.text
    assert r.json()["error"] == "invalid_body" and r.json()["detail"]


async def test_capability_kind_with_a_question_is_422(client):
    await publish(client)
    body = capability_body()
    body["question"] = "also this"
    r = await post(client, "alice", "/requests", body)
    assert r.status_code == 422


async def test_timeout_bounds_come_from_the_team_config(client):
    # conftest sets limits.min_ack_timeout_seconds: 2 and leaves the answer minimum at 60.
    created = await ask(client, ack_timeout_seconds=2, answer_timeout_seconds=60, ttl_seconds=60)
    assert created["ack_deadline"] == "2026-09-23T12:00:02.000Z"
    assert created["expire_at"] == "2026-09-23T12:01:00.000Z"
    r = await post(client, "alice", "/requests", question_body(answer_timeout_seconds=59))
    assert r.status_code == 422


async def test_bad_json_and_oversized_bodies(client, memory_store):
    r = await client.post(f"{T}/requests", headers=auth("alice"), content=b"{")
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"
    r = await client.post(f"{T}/requests", headers=auth("alice"), content=b"[1, Infinity]")
    assert r.status_code == 400
    big = b'{"question": "' + b"x" * (300 * 1024) + b'"}'
    r = await client.post(f"{T}/requests", headers=auth("alice"), content=big)
    assert r.status_code == 413 and r.json()["error"] == "too_large"
    r = await client.post(f"{T}/requests", headers=auth("alice"), json=[1, 2])
    assert r.status_code == 422
    details = [a.detail for a in await memory_store.list_audit("demo")]
    assert details == ["400 invalid_json", "400 invalid_json", "413 too_large", "422 invalid_body"]


# Recipients ----------------------------------------------------------------------------------


async def test_broadcast_goes_to_every_teammate(client):
    created = await ask(client, to="*")
    assert created["recipients"] == ["bob", "carol"]
    for member in ("bob", "carol"):
        [env] = (await stream(client, member, "inbox"))["messages"]
        assert env["broadcast"] is True and env["request_id"] == created["request_id"]
    assert (await stream(client, "alice", "inbox"))["messages"] == []
    body = (await status(client, "alice", created["request_id"])).json()
    assert body["broadcast"] is True and list(body["recipients"]) == ["bob", "carol"]


async def test_broadcast_capability_is_400(client):
    await publish(client)
    body = capability_body()
    body["to"] = "*"
    r = await post(client, "alice", "/requests", body)
    assert r.status_code == 400 and r.json()["error"] == "broadcast_capability"


@pytest.mark.parametrize(
    "to",
    [[], ["bob", "bob"], ["alice"], ["bob", "alice"], ["mallory"], ["dave"], ["Bob"]],
)
async def test_bad_recipients_are_400(client, to):
    r = await post(client, "alice", "/requests", question_body(to=to))
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"


async def test_broadcast_with_no_teammates_is_400(client):
    r = await client.post(
        "/v1/teams/other/requests", headers=auth("dave"), json=question_body(to="*")
    )
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"


async def test_capability_needs_exactly_one_recipient(client):
    await publish(client, "bob")
    await publish(client, "carol")
    body = capability_body()
    body["to"] = ["bob", "carol"]
    r = await post(client, "alice", "/requests", body)
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"


# Idempotency ---------------------------------------------------------------------------------


async def test_same_key_same_body_replays_without_redelivery(client, memory_store):
    body = question_body(idempotency_key="retry-key-0001")
    first = await post(client, "alice", "/requests", body)
    second = await post(client, "alice", "/requests", body)
    assert first.status_code == 201 and second.status_code == 200
    assert second.json() == {**first.json(), "created": False}
    assert (await stream(client, "bob", "inbox"))["head"] == 1
    # Spelling out a default is the same validated body.
    third = await post(client, "alice", "/requests", {**body, "ack_timeout_seconds": 120})
    assert third.status_code == 200 and third.json()["request_id"] == first.json()["request_id"]
    outcomes = [
        (a.action, a.outcome)
        for a in await memory_store.list_audit("demo")
        if a.action == "request.create"
    ]
    assert outcomes == [
        ("request.create", "created"),
        ("request.create", "replayed"),
        ("request.create", "replayed"),
    ]


async def test_same_key_different_body_is_409(client, memory_store):
    await post(client, "alice", "/requests", question_body(idempotency_key="retry-key-0002"))
    r = await post(
        client,
        "alice",
        "/requests",
        question_body(idempotency_key="retry-key-0002", question="Something else?"),
    )
    assert r.status_code == 409 and r.json()["error"] == "idempotency_conflict"
    assert (await stream(client, "bob", "inbox"))["head"] == 1
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert [a.detail for a in refused] == ["409 idempotency_conflict"]


async def test_idempotency_keys_are_scoped_to_the_sender(client):
    a = await post(
        client, "alice", "/requests", question_body(to=["carol"], idempotency_key="shared-key-01")
    )
    b = await post(
        client, "bob", "/requests", question_body(to=["carol"], idempotency_key="shared-key-01")
    )
    assert a.status_code == b.status_code == 201
    assert a.json()["request_id"] != b.json()["request_id"]
    assert (await stream(client, "carol", "inbox"))["head"] == 2


async def test_replay_survives_a_manifest_change(client):
    await publish(client)
    body = capability_body(idempotency_key="cap-key-0001")
    first = await post(client, "alice", "/requests", body)
    assert first.status_code == 201
    await publish(client, manifest={"version": 1, "capabilities": []})
    again = await post(client, "alice", "/requests", body)
    assert again.status_code == 200 and again.json()["request_id"] == first.json()["request_id"]


# Capabilities --------------------------------------------------------------------------------


async def test_capability_call_is_validated_and_defaults_filled(client):
    await publish(client)
    r = await post(client, "alice", "/requests", capability_body(params={"dataset": "orders"}))
    assert r.status_code == 201
    [env] = (await stream(client, "bob", "inbox"))["messages"]
    assert env["type"] == "capability_call" and env["from"] == "alice"
    assert env["data"] == {
        "capability": "staging_db_query",
        "params": {"dataset": "orders", "limit": 20},
        "environment": "staging",
        "ack_deadline": "2026-09-23T12:02:00.000Z",
        "answer_deadline": "2026-09-23T12:30:00.000Z",
    }
    body = (await status(client, "alice", r.json()["request_id"])).json()
    assert body["kind"] == "capability" and body["question"] is None
    assert body["capability"] == {
        "name": "staging_db_query",
        "params": {"dataset": "orders", "limit": 20},
        "environment": "staging",
    }


async def test_unknown_capability_is_404(client, memory_store):
    r = await post(client, "alice", "/requests", capability_body())  # bob published nothing
    assert r.status_code == 404 and r.json()["error"] == "unknown_capability"
    await publish(client)
    r = await post(
        client,
        "alice",
        "/requests",
        capability_body(name="production_db_count", params={"table": "users"}),
    )
    assert r.status_code == 404 and r.json()["error"] == "unknown_capability"
    r = await post(client, "alice", "/requests", capability_body(member="carol"))
    assert r.status_code == 404
    assert [a.detail for a in await memory_store.list_audit("demo") if a.outcome == "refused"] == [
        "404 unknown_capability"
    ] * 3


@pytest.mark.parametrize(
    "params, named",
    [
        ({"dataset": "users", "limit": 500}, "limit"),
        ({"dataset": "secrets"}, "dataset"),
        ({"dataset": "users", "sql": "select 1"}, "sql"),
        ({}, "dataset"),
        ({"dataset": "users", "filter": "1; drop table users"}, "filter"),
        ({"dataset": "users", "limit": 5.5}, "limit"),
    ],
)
async def test_invalid_params_are_422_naming_the_param(client, params, named):
    await publish(client)
    r = await post(client, "alice", "/requests", capability_body(params=params))
    assert r.status_code == 422 and r.json()["error"] == "invalid_params"
    assert f"'{named}'" in r.json()["detail"]
    assert (await stream(client, "bob", "inbox"))["head"] == 0


# Ack -----------------------------------------------------------------------------------------


async def test_ack_transitions_and_is_idempotent(client, memory_store):
    rid = (await ask(client))["request_id"]
    r = await ack(client, "bob", rid)
    assert r.status_code == 200 and r.json() == {"status": "acked"}
    assert (await ack(client, "bob", rid)).json() == {"status": "acked"}
    assert (await stream(client, "alice", "replies"))["head"] == 0  # nothing to the asker
    body = (await status(client, "alice", rid)).json()
    assert body["recipients"]["bob"] == {
        "status": "acked",
        "acked_at": "2026-09-23T12:00:00.000Z",
        "answered_at": None,
        # M11-SPEC §4: the preview and, for the asker, the full answer; none yet.
        "answer_preview": None,
        "answer": None,
    }
    doc = await memory_store.get_request("demo", rid)
    assert doc.next_deadline == doc.answer_deadline
    await reply(client, "bob", rid)
    assert (await ack(client, "bob", rid)).json() == {"status": "answered"}  # unchanged


async def test_ack_by_a_non_recipient_is_404(client, memory_store):
    rid = (await ask(client, to=["bob"]))["request_id"]
    for member in ("carol", "alice"):
        r = await ack(client, member, rid)
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await client.post(f"/v1/teams/other/requests/{rid}/ack", headers=auth("dave"))
    assert r.status_code == 404
    for bad in ("rq_" + "0" * 32, "not-an-id", "rq_" + "A" * 32):
        assert (await ack(client, "bob", bad)).status_code == 404
    refused = [
        (a.actor, a.detail) for a in await memory_store.list_audit("demo") if a.outcome == "refused"
    ]
    assert (
        refused
        == [("carol", "404 not_found"), ("alice", "404 not_found")] + [("bob", "404 not_found")] * 3
    )


async def test_ack_after_expiry_is_410(client, clock, memory_store):
    rid = (await ask(client, ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60))[
        "request_id"
    ]
    clock.advance(60)
    r = await ack(client, "bob", rid)
    assert r.status_code == 410 and r.json()["error"] == "expired"
    assert (await memory_store.list_audit("demo"))[-1].detail == "410 expired"


# Reply ---------------------------------------------------------------------------------------


async def test_reply_delivers_one_answer_to_the_asker(client, clock):
    rid = (await ask(client))["request_id"]
    clock.advance(5)
    r = await reply(
        client,
        "bob",
        rid,
        text="It is in the bucket.",
        key="reply-key-01",
        data={"rows": [1, 2], "big": 2**70},
    )
    assert r.status_code == 200
    message_id = r.json()["message_id"]
    assert r.json() == {"status": "answered", "message_id": message_id}
    [env] = (await stream(client, "alice", "replies"))["messages"]
    assert env["id"] == message_id and env["type"] == "answer"
    assert env["from"] == "bob" and env["to"] == "alice" and env["stream"] == "replies"
    assert env["data"] == {"text": "It is in the bucket.", "data": {"rows": [1, 2], "big": 2**70}}
    body = (await status(client, "alice", rid)).json()
    # A reply implies the ack.
    assert body["recipients"]["bob"] == {
        "status": "answered",
        "acked_at": "2026-09-23T12:00:05.000Z",
        "answered_at": "2026-09-23T12:00:05.000Z",
        "answer_preview": "It is in the bucket.",
        "answer": "It is in the bucket.",
    }


async def test_reply_replay_and_conflict(client, memory_store):
    rid = (await ask(client))["request_id"]
    first = await reply(client, "bob", rid, key="reply-key-02")
    again = await reply(client, "bob", rid, key="reply-key-02", text="different text")
    assert again.status_code == 200 and again.json() == first.json()
    assert (await stream(client, "alice", "replies"))["head"] == 1  # nothing re-delivered
    other = await reply(client, "bob", rid, key="reply-key-03")
    assert other.status_code == 409 and other.json()["error"] == "already_answered"
    assert (await memory_store.list_audit("demo"))[-1].detail == "409 already_answered"


async def test_reply_by_a_non_recipient_is_404(client):
    rid = (await ask(client, to=["bob"]))["request_id"]
    assert (await reply(client, "carol", rid)).status_code == 404
    assert (await reply(client, "alice", rid)).status_code == 404
    assert (await stream(client, "alice", "replies"))["head"] == 0


async def test_reply_body_rules(client):
    rid = (await ask(client))["request_id"]
    path = f"/requests/{rid}/reply"
    for body in (
        {"idempotency_key": "reply-key-04", "text": ""},
        {"idempotency_key": "reply-key-04", "text": "x" * 32001},
        {"idempotency_key": "reply-key-04", "text": "ok", "data": [1]},
        {"idempotency_key": "reply-key-04", "text": "ok", "data": {"x": "y" * 70000}},
        {"idempotency_key": "reply-key-04", "text": "ok", "from": "carol"},
        {"text": "ok"},
    ):
        r = await post(client, "bob", path, body)
        assert r.status_code == 422, body
    ok = await post(
        client, "bob", path, {"idempotency_key": "reply-key-04", "text": "ok", "data": None}
    )
    assert ok.status_code == 200


async def test_late_replies_are_still_delivered(client, clock):
    rid = (await ask(client, to=["bob", "carol"], ack_timeout_seconds=10))["request_id"]
    await ack(client, "carol", rid)
    clock.advance(10)
    await stream(client, "alice", "replies")  # sweep: bob no_response
    clock.advance(1800)
    notices = (await stream(client, "alice", "replies"))["messages"]  # carol timed_out
    assert [(m["type"], m["data"]["member"]) for m in notices] == [
        ("no_response", "bob"),
        ("timed_out", "carol"),
    ]
    assert (await reply(client, "bob", rid, text="late bob")).status_code == 200
    assert (await reply(client, "carol", rid, text="late carol")).status_code == 200
    messages = (await stream(client, "alice", "replies", after=2))["messages"]
    assert [(m["type"], m["from"], m["data"]["text"]) for m in messages] == [
        ("answer", "bob", "late bob"),
        ("answer", "carol", "late carol"),
    ]


async def test_reply_after_expiry_is_410(client, clock):
    rid = (await ask(client, ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=100))[
        "request_id"
    ]
    clock.advance(100)
    r = await reply(client, "bob", rid)
    assert r.status_code == 410 and r.json()["error"] == "expired"
    assert (await stream(client, "alice", "replies"))["messages"] == []


# Progress ------------------------------------------------------------------------------------


async def _all_heads(client) -> dict[tuple[str, str], int]:
    heads = {}
    for member in ("alice", "bob", "carol"):
        for name in ("inbox", "replies"):
            heads[(member, name)] = (await stream(client, member, name))["head"]
    return heads


async def test_progress_is_recorded_and_never_enters_a_stream(client, memory_store):
    await publish(client)
    rid = (await post(client, "alice", "/requests", capability_body())).json()["request_id"]
    await ack(client, "bob", rid)
    before = await _all_heads(client)
    r = await post(client, "bob", f"/requests/{rid}/progress", {"text": "Querying", "pct": 40})
    assert r.status_code == 201 and r.json() == {"seq": 1}
    r = await post(client, "bob", f"/requests/{rid}/progress", {"text": "Almost", "pct": 92.5})
    assert r.json() == {"seq": 2}
    r = await post(client, "bob", f"/requests/{rid}/progress", {"text": "No pct"})
    assert r.json() == {"seq": 3}
    assert await _all_heads(client) == before
    body = (await status(client, "alice", rid)).json()
    assert body["progress"] == [
        {
            "seq": 1,
            "member": "bob",
            "kind": "progress",
            "text": "Querying",
            "pct": 40,
            "tool": None,
            "status": None,
            "duration_ms": None,
            "time": "2026-09-23T12:00:00.000Z",
        },
        {
            "seq": 2,
            "member": "bob",
            "kind": "progress",
            "text": "Almost",
            "pct": 92.5,
            "tool": None,
            "status": None,
            "duration_ms": None,
            "time": "2026-09-23T12:00:00.000Z",
        },
        {
            "seq": 3,
            "member": "bob",
            "kind": "progress",
            "text": "No pct",
            "pct": None,
            "tool": None,
            "status": None,
            "duration_ms": None,
            "time": "2026-09-23T12:00:00.000Z",
        },
    ]


async def test_progress_rules(client):
    rid = (await ask(client))["request_id"]
    path = f"/requests/{rid}/progress"
    for body in (
        {"text": ""},
        {"text": "x" * 1001},
        {"text": "a", "pct": 101},
        {"text": "a", "pct": -1},
        {"text": "a", "pct": True},
        {"text": "a", "extra": 1},
    ):
        assert (await post(client, "bob", path, body)).status_code == 422, body
    assert (await post(client, "carol", path, {"text": "not mine"})).status_code == 404
    assert (await post(client, "alice", path, {"text": "not mine"})).status_code == 404


async def test_progress_is_capped_at_200_per_recipient(client, memory_store):
    rid = (await ask(client, to=["bob", "carol"]))["request_id"]
    path = f"/requests/{rid}/progress"
    for i in range(200):
        r = await post(client, "bob", path, {"text": f"step {i}"})
        assert r.status_code == 201
    r = await post(client, "bob", path, {"text": "one too many"})
    assert r.status_code == 429 and r.json()["error"] == "too_much_progress"
    assert (await post(client, "carol", path, {"text": "carol has her own budget"})).json() == {
        "seq": 201
    }
    assert (await memory_store.list_audit("demo"))[-2].detail == "429 too_much_progress"


async def test_progress_after_expiry_is_410(client, clock):
    rid = (await ask(client, ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60))[
        "request_id"
    ]
    clock.advance(61)
    r = await post(client, "bob", f"/requests/{rid}/progress", {"text": "late"})
    assert r.status_code == 410


# The side surface (§3.11) ----------------------------------------------------------------------


async def test_recipients_see_only_their_own_entry_and_progress(client):
    rid = (await ask(client, to=["bob", "carol"]))["request_id"]
    await post(client, "bob", f"/requests/{rid}/progress", {"text": "bob working"})
    await post(client, "carol", f"/requests/{rid}/progress", {"text": "carol working"})
    await ack(client, "carol", rid)

    asker = (await status(client, "alice", rid)).json()
    assert list(asker["recipients"]) == ["bob", "carol"]
    assert [p["member"] for p in asker["progress"]] == ["bob", "carol"]
    assert asker["question"] == "Where is the deploy log?" and asker["asker"] == "alice"

    bob = (await status(client, "bob", rid)).json()
    assert list(bob["recipients"]) == ["bob"]
    assert bob["recipients"]["bob"]["status"] == "pending"
    assert [p["text"] for p in bob["progress"]] == ["bob working"]

    carol = (await status(client, "carol", rid)).json()
    assert list(carol["recipients"]) == ["carol"]
    assert carol["recipients"]["carol"]["status"] == "acked"
    assert [p["text"] for p in carol["progress"]] == ["carol working"]


async def test_status_for_outsiders_is_404(client, clock):
    rid = (await ask(client, to=["bob"]))["request_id"]
    r = await status(client, "carol", rid)
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    assert (
        await client.get(f"/v1/teams/other/requests/{rid}", headers=auth("dave"))
    ).status_code == 404
    assert (await status(client, "alice", "rq_" + "f" * 32)).status_code == 404
    assert (await status(client, "alice", "nope")).status_code == 404
    clock.advance(7 * 86400)
    assert (await status(client, "alice", rid)).status_code == 404  # expired reads as gone


async def test_status_runs_the_sweep_for_that_request(client, clock):
    rid = (await ask(client, ack_timeout_seconds=10))["request_id"]
    clock.advance(10)
    body = (await status(client, "bob", rid)).json()  # any participant's read sweeps
    assert body["recipients"]["bob"]["status"] == "no_response"
    [notice] = (await stream(client, "alice", "replies"))["messages"]
    assert notice["type"] == "no_response" and notice["from"] == "relay"
    assert notice["data"] == {"member": "bob", "detail": "No response yet from bob."}


async def test_error_bodies_have_the_contract_shape(client):
    rid = (await ask(client))["request_id"]
    await reply(client, "bob", rid, key="reply-key-10")
    responses = [
        await post(client, "alice", "/requests", question_body(to=[])),
        await post(client, "alice", "/requests", {"kind": "question"}),
        await reply(client, "bob", rid, key="reply-key-11"),
        await client.put(f"{T}/members/bob/manifest", headers=auth("alice"), json={}),
        await get(client, "alice", "/streams/inbox", wait="99"),
    ]
    for r in responses:
        assert set(r.json()) == {"error", "detail"}, r.json()
        assert r.headers["content-type"] == "application/json"
