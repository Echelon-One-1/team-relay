"""M2-SPEC §3.3 (tool events) and §3.4 (answer preview), through the HTTP API, on both stores."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from relay.service import MAX_TOOL_EVENTS_PER_RECIPIENT

from .conftest import Api, auth

pytestmark = pytest.mark.anyio

T0 = "2026-09-23T12:00:00.000Z"


def at(seconds: int) -> str:
    return f"2026-09-23T12:00:{seconds:02d}.000Z"


def events(rid: str) -> str:
    return f"/requests/{rid}/events"


async def _heads(api: Api) -> dict[tuple[str, str], int]:
    return {
        (m, s): (await api.stream(m, s))["head"]
        for m in ("alice", "bob", "carol")
        for s in ("inbox", "replies")
    }


async def test_a_tool_event_is_recorded_on_the_recipient_and_in_the_progress_list(api: Api):
    await api.publish("bob")
    rid = await api.invoke()
    await api.ack("bob", rid)
    api.clock.advance(1)
    r = await api.post("bob", events(rid), {"tool": "Read", "status": "ok", "duration_ms": 12})
    assert r.status_code == 201 and r.json() == {"seq": 1}
    api.clock.advance(1)
    r = await api.post("bob", f"/requests/{rid}/progress", {"text": "Querying", "pct": 40})
    assert r.json() == {"seq": 2}  # one sequence for both kinds
    api.clock.advance(1)
    r = await api.post("bob", events(rid), {"tool": "staging_db_query", "status": "error"})
    assert r.status_code == 201 and r.json() == {"seq": 3}

    body = (await api.get("alice", f"/requests/{rid}")).json()
    assert body["progress"] == [
        {
            "seq": 1,
            "member": "bob",
            "kind": "tool",
            "text": None,
            "pct": None,
            "tool": "Read",
            "status": "ok",
            "duration_ms": 12,
            "time": at(1),
        },
        {
            "seq": 2,
            "member": "bob",
            "kind": "progress",
            "text": "Querying",
            "pct": 40,
            "tool": None,
            "status": None,
            "duration_ms": None,
            "time": at(2),
        },
        {
            "seq": 3,
            "member": "bob",
            "kind": "tool",
            "text": None,
            "pct": None,
            "tool": "staging_db_query",
            "status": "error",
            "duration_ms": None,
            "time": at(3),
        },
    ]
    entry = (await api.feed_entry("carol", rid))["recipients"]["bob"]  # metadata: any member
    assert entry["tools"] == [
        {"tool": "Read", "status": "ok", "at": at(1), "duration_ms": 12},
        {"tool": "staging_db_query", "status": "error", "at": at(3), "duration_ms": None},
    ]
    assert entry["progress_count"] == 1  # tool events are not progress events
    assert entry["last_progress_pct"] == 40
    assert (await api.feed_entry("alice", rid))["updated_at"] == at(3)


async def test_tool_events_never_enter_a_stream(api: Api):
    rid = await api.ask(to=["bob", "carol"])
    before = await _heads(api)
    for tool in ("Read", "Glob", "Grep"):
        r = await api.post("bob", events(rid), {"tool": tool, "status": "ok"})
        assert r.status_code == 201
    assert await _heads(api) == before
    assert (await api.stream("alice", "replies"))["messages"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"tool": "", "status": "ok"},
        {"tool": "a b", "status": "ok"},
        {"tool": "Read\n", "status": "ok"},
        {"tool": "\nRead", "status": "ok"},
        {"tool": "x" * 65, "status": "ok"},
        {"tool": "Reäd", "status": "ok"},
        {"tool": "a/b", "status": "ok"},
        {"tool": "~/.ssh/id_rsa", "status": "ok"},
        {"tool": "a;b", "status": "ok"},
        {"tool": 5, "status": "ok"},
        {"tool": None, "status": "ok"},
        {"status": "ok"},
        {"tool": "Read"},
        {"tool": "Read", "status": "OK"},
        {"tool": "Read", "status": "failed"},
        {"tool": "Read", "status": None},
        {"tool": "Read", "status": "Waiting"},
        {"tool": "Read", "status": "waiting "},
        {"tool": "Read", "status": "wait"},
        {"tool": "Read", "status": "pending"},
        {"tool": "Read", "status": "denied"},
        {"tool": "Read", "status": "allowed"},
        {"tool": "Read", "status": ["waiting"]},
        # A waiting event names the tool, never the path it asked for (M4-SPEC §2).
        {
            "tool": "Read",
            "status": "waiting",
            "path": "/Users/bob/notes",  # e1-guard: allow (synthetic test path)
        },
        {"tool": "Read", "status": "waiting", "file_path": "/etc/hosts"},
        {"tool": "Read", "status": "waiting", "input": {"pattern": "**/*"}},
        {"tool": "Read", "status": "ok", "duration_ms": -1},
        {"tool": "Read", "status": "ok", "duration_ms": 3_600_001},
        {"tool": "Read", "status": "ok", "duration_ms": True},
        {"tool": "Read", "status": "ok", "duration_ms": 1.5},
        {"tool": "Read", "status": "ok", "duration_ms": "12"},
        {"tool": "Read", "status": "ok", "duration_ms": 10**40},
        # Never an input, an output, a path, or a sender.
        {"tool": "Read", "status": "ok", "input": {"file_path": "/etc/hosts"}},
        {"tool": "Read", "status": "ok", "output": "secret"},
        {"tool": "Read", "status": "ok", "path": "/etc/hosts"},
        {"tool": "Read", "status": "ok", "from": "carol"},
        [],
        "Read",
        None,
    ],
)
async def test_malformed_tool_events_are_refused_and_audited(api: Api, body: Any):
    rid = await api.ask(to=["bob"])
    r = await api.post("bob", events(rid), body)
    assert r.status_code in (400, 422), (body, r.text)
    assert set(r.json()) == {"error", "detail"}
    assert (await api.get("alice", f"/requests/{rid}")).json()["progress"] == []
    refused = [a for a in await api.store.list_audit(api.team) if a.outcome == "refused"]
    assert [(a.actor, a.action, a.request_id) for a in refused] == [("bob", "request.event", rid)]


@pytest.mark.parametrize(
    "body",
    [
        {"tool": "x" * 64, "status": "ok"},
        {"tool": "A-z_0.9:mcp", "status": "error"},
        {"tool": "Read", "status": "waiting"},
        {"tool": "Grep", "status": "waiting", "duration_ms": 0},
        {"tool": "Glob", "status": "waiting", "duration_ms": 3_600_000},
        {"tool": "Read", "status": "ok", "duration_ms": 0},
        {"tool": "Read", "status": "ok", "duration_ms": 3_600_000},
        {"tool": "Read", "status": "ok", "duration_ms": None},
    ],
)
async def test_tool_events_at_the_bounds_are_accepted(api: Api, body: dict[str, Any]):
    rid = await api.ask(to=["bob"])
    r = await api.post("bob", events(rid), body)
    assert r.status_code == 201, r.text
    [tool] = (await api.feed_entry("alice", rid))["recipients"]["bob"]["tools"]
    assert tool == {
        "tool": body["tool"],
        "status": body["status"],
        "at": T0,
        "duration_ms": body.get("duration_ms"),
    }


async def test_only_a_recipient_may_post_tool_events(api: Api):
    rid = await api.ask(to=["bob"])
    body = {"tool": "Read", "status": "ok"}
    for member in ("alice", "carol"):  # the asker and a teammate who was not asked
        r = await api.post(member, events(rid), body)
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
    for bad in ("rq_" + "0" * 32, "not-an-id", "rq_" + "A" * 32):
        assert (await api.post("bob", events(bad), body)).status_code == 404
    r = await api.client.post(
        f"/v1/teams/other/requests/{rid}/events", json=body, headers=auth("bob")
    )
    assert r.status_code == 404  # bob's team is not "other"
    r = await api.client.post(api.url(events(rid)), json=body, headers=auth("dave"))
    assert r.status_code == 404  # dave's team is not this one
    r = await api.client.post(api.url(events(rid)), json=body)
    assert r.status_code == 401
    assert (await api.feed_entry("alice", rid))["recipients"]["bob"]["tools"] == []
    refused = sorted(
        (a.actor, a.action, a.detail)
        for a in await api.store.list_audit(api.team)
        if a.outcome == "refused"
    )
    # bob's three bad ids and his call into team "other" are all filed under his own team.
    assert refused == (
        [("alice", "request.event", "404 not_found")]
        + [("bob", "request.event", "404 not_found")] * 4
        + [("carol", "request.event", "404 not_found")]
    )


async def test_tool_events_are_capped_per_recipient(api: Api):
    rid = await api.ask(to=["bob", "carol"])
    body = {"tool": "Read", "status": "ok", "duration_ms": 1}
    for _ in range(MAX_TOOL_EVENTS_PER_RECIPIENT):
        assert (await api.post("bob", events(rid), body)).status_code == 201
    r = await api.post("bob", events(rid), body)
    assert r.status_code == 429 and r.json()["error"] == "too_many_tool_events"
    feed = await api.feed_entry("alice", rid)
    assert len(feed["recipients"]["bob"]["tools"]) == MAX_TOOL_EVENTS_PER_RECIPIENT
    # carol has her own budget; bob's progress has its own budget too.
    assert (await api.post("carol", events(rid), body)).status_code == 201
    r = await api.post("bob", f"/requests/{rid}/progress", {"text": "still going"})
    assert r.status_code == 201
    audit = await api.store.list_audit(api.team)
    assert [a.detail for a in audit if a.outcome == "refused"] == ["429 too_many_tool_events"]


# M4-SPEC §2: "waiting" --------------------------------------------------------------------------


async def test_a_waiting_event_is_recorded_like_any_tool_event(api: Api):
    """Waiting, then the outcome of the same tool: both kept in order, one sequence with
    progress, on the recipient and in the progress list; nothing else changes."""
    rid = await api.ask(to=["bob", "carol"])
    before = await _heads(api)
    r = await api.post("bob", events(rid), {"tool": "Read", "status": "waiting"})
    assert r.status_code == 201 and r.json() == {"seq": 1}
    api.clock.advance(4)
    r = await api.post("bob", events(rid), {"tool": "Read", "status": "ok", "duration_ms": 9})
    assert r.status_code == 201 and r.json() == {"seq": 2}
    api.clock.advance(1)
    r = await api.post("bob", events(rid), {"tool": "Grep", "status": "waiting"})
    assert r.json() == {"seq": 3}

    assert await _heads(api) == before  # never a stream, waiting included
    entry = (await api.feed_entry("carol", rid))["recipients"]["bob"]
    assert entry["tools"] == [
        {"tool": "Read", "status": "waiting", "at": at(0), "duration_ms": None},
        {"tool": "Read", "status": "ok", "at": at(4), "duration_ms": 9},
        {"tool": "Grep", "status": "waiting", "at": at(5), "duration_ms": None},
    ]
    assert entry["progress_count"] == 0
    progress = (await api.get("alice", f"/requests/{rid}")).json()["progress"]
    assert [(p["kind"], p["tool"], p["status"]) for p in progress] == [
        ("tool", "Read", "waiting"),
        ("tool", "Read", "ok"),
        ("tool", "Grep", "waiting"),
    ]
    assert (await api.feed_entry("alice", rid))["updated_at"] == at(5)
    audit = [a for a in await api.store.list_audit(api.team) if a.action == "request.event"]
    assert [(a.actor, a.outcome) for a in audit] == [("bob", "recorded")] * 3


async def test_waiting_events_count_against_the_same_cap(api: Api):
    rid = await api.ask(to=["bob"])
    for i in range(MAX_TOOL_EVENTS_PER_RECIPIENT):
        status = "waiting" if i % 2 == 0 else "ok"
        assert (
            await api.post("bob", events(rid), {"tool": "Read", "status": status})
        ).status_code == 201
    r = await api.post("bob", events(rid), {"tool": "Read", "status": "waiting"})
    assert r.status_code == 429 and r.json()["error"] == "too_many_tool_events"


async def test_waiting_follows_the_same_access_and_expiry_rules(api: Api):
    rid = await api.ask(
        to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60
    )
    body = {"tool": "Read", "status": "waiting"}
    for member in ("alice", "carol"):
        assert (await api.post(member, events(rid), body)).status_code == 404
    api.clock.advance(60)
    r = await api.post("bob", events(rid), body)
    assert r.status_code == 410 and r.json()["error"] == "expired"


async def test_tool_events_after_expiry_are_410(api: Api):
    rid = await api.ask(
        to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60
    )
    api.clock.advance(60)
    r = await api.post("bob", events(rid), {"tool": "Read", "status": "ok"})
    assert r.status_code == 410 and r.json()["error"] == "expired"


async def test_tool_events_are_audited_like_progress_hash_and_length_only(api: Api):
    rid = await api.ask(to=["bob"])
    body = {"tool": "Grep", "status": "ok", "duration_ms": 7}
    assert (await api.post("bob", events(rid), body)).status_code == 201
    [entry] = [a for a in await api.store.list_audit(api.team) if a.action == "request.event"]
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    assert entry.actor == "bob" and entry.outcome == "recorded" and entry.request_id == rid
    assert entry.content_sha256 == hashlib.sha256(canonical.encode()).hexdigest()
    assert entry.content_length == len(canonical)
    assert entry.detail is None and "Grep" not in repr(entry)


async def test_an_oversized_tool_event_is_413_and_audited(api: Api):
    rid = await api.ask(to=["bob"])
    r = await api.client.post(
        api.url(events(rid)),
        headers={**auth("bob"), "Content-Type": "application/json"},
        content=b'{"tool": "Read", "status": "ok", "pad": "' + b"x" * (300 * 1024) + b'"}',
    )
    assert r.status_code == 413
    [entry] = [a for a in await api.store.list_audit(api.team) if a.outcome == "refused"]
    assert (entry.action, entry.detail) == ("request.event", "413 too_large")


async def test_tool_events_are_allowed_after_the_answer(api: Api):
    # The PostToolUse hook can land after the reply; it is still the recipient's event.
    rid = await api.ask(to=["bob"])
    await api.reply("bob", rid)
    r = await api.post("bob", events(rid), {"tool": "reply", "status": "ok"})
    assert r.status_code == 201


# §3.4 answer preview ---------------------------------------------------------------------------


async def test_the_answer_preview_is_the_first_2000_code_points(api: Api):
    rid = await api.ask(to=["bob", "carol"])
    long = ("✓" * 1999) + "🎉" + ("z" * 500)  # a non-BMP character at code point 2000
    await api.reply("bob", rid, text=long)
    await api.reply("carol", rid, text="short answer")
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["bob"]["answer_preview"] == long[:2000]
    assert entry["recipients"]["bob"]["answer_preview"].endswith("🎉")
    assert entry["recipients"]["carol"]["answer_preview"] == "short answer"
    # The answer itself is untouched.
    texts = sorted(m["data"]["text"] for m in (await api.stream("alice", "replies"))["messages"])
    assert texts == sorted([long, "short answer"])


async def test_a_reply_replay_keeps_the_first_preview(api: Api):
    rid = await api.ask(to=["bob"])
    body = {"idempotency_key": "reply-key-000001", "text": "first"}
    assert (await api.post("bob", f"/requests/{rid}/reply", body)).status_code == 200
    assert (await api.post("bob", f"/requests/{rid}/reply", body)).status_code == 200
    other = {"idempotency_key": "reply-key-000002", "text": "second"}
    assert (await api.post("bob", f"/requests/{rid}/reply", other)).status_code == 409
    assert (await api.feed_entry("alice", rid))["recipients"]["bob"]["answer_preview"] == "first"
