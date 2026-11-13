"""M10-SPEC §1, schema v3 (local folders only, 13 Nov 2026): a team's boundaries, its topic, on
both stores. The store primitive (read, a versioned write in one transaction with the actor's
roster entry, TeamGone, the quota, the purge), the body's validation (the shared vectors: valid,
invalid, removed fields, normalised, versions), a document an earlier relay stored read as v3,
and the endpoints: who may read, who may write (owners; a delegate with manage-roster for an
owner), the version check, the audit (no text), the rate limit, and that deleting a team
removes them. The Firestore half needs the emulator (scripts/test-relay.sh)."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import pytest

from relay.app import DELEGATE_ROUTES
from relay.boundaries import REMOVED_FIELDS, parse_set_body
from relay.errors import ApiError
from relay.store import (
    AuditEntry,
    BoundariesChange,
    Quota,
    QuotaExceeded,
    RosterEntry,
    Store,
    TeamBoundaries,
    TeamGone,
)
from relay.store_memory import MemoryStore

from .conftest import (
    EMAILS,
    REPO_ROOT,
    START,
    Api,
    FakeClock,
    accept_invitation,
    auth,
    emulator_host,
    id_token,
    open_api,
)
from .test_team_store import create, deleting, new_email, new_id

pytestmark = pytest.mark.anyio

NOW = START

EXAMPLE: dict[str, Any] = {
    "topic": (
        "Example Org: our clients and their delivery, our products and tools, engineering, "
        "playbook, pipeline and team work."
    ),
}
REMOVED_DETAIL = "no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)"


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


def doc(version: int, topic: str = "Our work", by: str = "owner1") -> TeamBoundaries:
    return TeamBoundaries(
        version=version,
        topic=topic,
        updated_at=NOW + timedelta(seconds=version),
        updated_by=by,
    )


def setting(team: str, expected: int, new: TeamBoundaries, *, owner_only: bool = True):
    """The service's rule in miniature: the actor is an active owner and ``expected`` is the
    stored version."""

    def fn(current: TeamBoundaries | None, actor: RosterEntry | None) -> BoundariesChange[str]:
        if owner_only and (actor is None or not actor.active or actor.role != "owner"):
            raise ApiError(403, "forbidden")
        if (current.version if current else 0) != expected:
            raise ApiError(409, "version_conflict")
        audit = AuditEntry(
            time=NOW,
            team=team,
            actor=new.updated_by,
            action="boundaries_set",
            outcome="set",
            expire_at=NOW + timedelta(days=30),
            detail=f"version {new.version}",
        )
        return BoundariesChange(result="set", boundaries=new, audit=[audit])

    return fn


# The store ---------------------------------------------------------------------------------------


async def test_never_set_reads_as_none(store: Store):
    assert await store.get_boundaries(new_id()) is None


async def test_a_versioned_write_reads_back_whole(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    assert await store.set_boundaries(team, "owner1", setting(team, 0, doc(1))) == "set"
    assert await store.get_boundaries(team) == doc(1)
    assert await store.set_boundaries(team, "owner1", setting(team, 1, doc(2, "Changed"))) == "set"
    assert await store.get_boundaries(team) == doc(2, "Changed")
    audit = [e for e in await store.list_audit(team) if e.action == "boundaries_set"]
    assert sorted(e.detail for e in audit) == ["version 1", "version 2"]


async def test_the_function_sees_the_actors_roster_entry(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    seen: list[Any] = []

    def peek(current, actor):
        seen.append((current, actor.member if actor else None, actor.role if actor else None))
        return BoundariesChange(result=None)

    await store.set_boundaries(team, "owner1", peek)
    await store.set_boundaries(team, "nobody", peek)
    assert seen == [(None, "owner1", "owner"), (None, None, None)]
    # Nothing to write: nothing written.
    assert await store.get_boundaries(team) is None


async def test_a_refusal_writes_nothing(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.set_boundaries(team, "owner1", setting(team, 0, doc(1)))
    with pytest.raises(ApiError) as caught:
        await store.set_boundaries(team, "owner1", setting(team, 0, doc(1, "stale")))
    assert caught.value.code == "version_conflict"
    with pytest.raises(ApiError) as caught:
        await store.set_boundaries(team, "nobody", setting(team, 1, doc(2, "intruder")))
    assert caught.value.code == "forbidden"
    assert await store.get_boundaries(team) == doc(1)
    assert len([e for e in await store.list_audit(team) if e.action == "boundaries_set"]) == 1


async def test_concurrent_writes_of_one_version_store_one(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)

    async def attempt(topic: str) -> str:
        try:
            return await store.set_boundaries(team, "owner1", setting(team, 0, doc(1, topic)))
        except ApiError as exc:
            return exc.code

    outcomes = await asyncio.gather(*(attempt(f"topic {i}") for i in range(5)))
    assert sorted(outcomes) == ["set"] + ["version_conflict"] * 4
    stored = await store.get_boundaries(team)
    assert stored is not None and stored.version == 1


async def test_the_quota_is_counted_only_on_a_write(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    quota = Quota(key="owner1.boundaries.x" + uuid.uuid4().hex, limit=2, expire_at=NOW)
    await store.set_boundaries(team, "owner1", lambda c, a: BoundariesChange(result=None), [quota])
    await store.set_boundaries(team, "owner1", setting(team, 0, doc(1)), [quota])
    await store.set_boundaries(team, "owner1", setting(team, 1, doc(2)), [quota])
    with pytest.raises(QuotaExceeded):
        await store.set_boundaries(team, "owner1", setting(team, 2, doc(3)), [quota])
    assert (await store.get_boundaries(team)).version == 2  # type: ignore[union-attr]


async def test_a_deleted_team_takes_no_boundaries(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.delete_team(team, deleting())
    with pytest.raises(TeamGone):
        await store.set_boundaries(team, "owner1", setting(team, 0, doc(1)))
    assert await store.get_boundaries(team) is None


async def test_the_purge_removes_them(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.set_boundaries(team, "owner1", setting(team, 0, doc(1)))
    await store.delete_team(team, deleting())
    assert await store.purge_team(team, 1000) is True
    assert await store.get_boundaries(team) is None
    assert (await store.get_teams([team]))[team].purge_complete is True


async def test_a_purge_in_batches_of_one_removes_them_too(store: Store):
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.set_boundaries(team, "owner1", setting(team, 0, doc(1)))
    await store.delete_team(team, deleting())
    calls = 0
    while not await store.purge_team(team, 1):
        calls += 1
        assert calls < 50
    assert await store.get_boundaries(team) is None


async def test_boundaries_alone_make_an_id_not_empty(store: Store):
    team = new_id()
    assert await store.team_has_documents(team) is False
    await store.set_boundaries(team, "x", setting(team, 0, doc(1), owner_only=False))
    assert await store.team_has_documents(team) is True


# Validation ---------------------------------------------------------------------------------------


def body(**changes: Any) -> dict[str, Any]:
    boundaries = {**EXAMPLE, **changes}
    return {"version": 0, "boundaries": boundaries}


def test_the_example_boundaries_parse_as_given():
    assert parse_set_body(body()) == (0, EXAMPLE["topic"])


def test_the_topic_is_trimmed_to_at_most_500():
    assert parse_set_body(body(topic="  Our clients  "))[1] == "Our clients"
    assert len(parse_set_body(body(topic="x" * 500))[1]) == 500


BAD_BOUNDARIES: list[dict[str, Any]] = [
    {"topic": ""},
    {"topic": "   "},
    {"topic": "x" * 501},
    {"topic": "carriage\rreturn"},
    {"topic": "vertical\x0btab"},
    {"topic": "\x1fleading unit separator"},
    {"topic": "trailing next line\x85"},
    {"topic": "line\u2028separator"},
    {"topic": "zero\u200bwidth"},
    {"topic": "private \ue000 use"},
    {"topic": "bidi \u202e override"},
    {"topic": "nul \x00"},
    {"topic": 5},
    {"topic": None},
    {"topic": ["a list"]},
]


@pytest.mark.parametrize("change", BAD_BOUNDARIES)
def test_invalid_boundaries_are_400(change: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_set_body(body(**change))
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")
    assert (caught.value.detail or "").startswith("boundaries.topic: ")


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        "x",
        {},
        {"version": 0},
        {"boundaries": EXAMPLE},
        {"version": 0, "boundaries": EXAMPLE, "extra": 1},
        {"version": "0", "boundaries": EXAMPLE},
        {"version": True, "boundaries": EXAMPLE},
        {"version": -1, "boundaries": EXAMPLE},
        {"version": 1.0, "boundaries": EXAMPLE},
        {"version": 2**63, "boundaries": EXAMPLE},
        {"version": 0, "boundaries": None},
        {"version": 0, "boundaries": "topic"},
        {"version": 0, "boundaries": {**EXAMPLE, "secret": "x"}},
        {"version": 0, "boundaries": {}},
    ],
)
def test_invalid_bodies_are_400(raw: Any):
    with pytest.raises(ApiError) as caught:
        parse_set_body(raw)
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")


def test_a_refusal_never_echoes_the_input():
    marker = "do-not-echo-" + uuid.uuid4().hex
    for change in (
        {"topic": marker + "\x01" + marker},
        {"topic": marker * 20},
        {"github_orgs": [marker]},
        {"drive_folders": [{"folder_name": marker}]},
    ):
        with pytest.raises(ApiError) as caught:
            parse_set_body(body(**change))
        assert marker not in str(caught.value.body())
    for raw in (
        {"version": 0, "boundaries": EXAMPLE, marker: 1},
        {"version": 0, "boundaries": {**EXAMPLE, marker: 1}},
    ):
        with pytest.raises(ApiError) as caught:
            parse_set_body(raw)
        assert marker not in str(caught.value.body())


@pytest.mark.parametrize("field", REMOVED_FIELDS)
def test_each_removed_field_is_named_even_when_its_value_is_bad(field: str):
    """A removed field is refused by name whatever it holds, before anything else of the body is
    looked at (an older console's body is told why, never "unknown field")."""
    for value in (None, [], "x", {"nested": True}):
        with pytest.raises(ApiError) as caught:
            parse_set_body({"version": 0, "boundaries": {field: value}})
        assert caught.value.code == "invalid_body"
        assert caught.value.detail == f"boundaries.{field}: {REMOVED_DETAIL}"


# The shared vectors (schema v3) -------------------------------------------------------------------

VECTORS_PATH = REPO_ROOT / "schema" / "boundaries-vectors.json"


def _vectors() -> dict[str, Any]:
    raw = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    # Each placeholder's value, as the file's "placeholders" texts say.
    placeholders = {"TOPIC_500": "a" * 500, "TOPIC_501": "a" * 501}
    # Every placeholder the file names is one this test knows how to expand.
    assert set(raw["placeholders"]) == set(placeholders)

    def expand(value: Any) -> Any:
        if isinstance(value, str):
            return placeholders.get(value, value)
        if isinstance(value, list):
            return [expand(v) for v in value]
        if isinstance(value, dict):
            return {k: expand(v) for k, v in value.items()}
        return value

    return expand(raw)


VECTORS = _vectors()


def test_the_vectors_expand_their_placeholders():
    valid = [b["topic"] for b in VECTORS["valid"]]
    invalid = [case["boundaries"].get("topic") for case in VECTORS["invalid"]]
    assert "a" * 500 in valid and "a" * 501 in invalid
    text = json.dumps({k: v for k, v in VECTORS.items() if k != "placeholders"})
    assert not any(f'"{name}"' in text for name in VECTORS["placeholders"])


@pytest.mark.parametrize("boundaries", VECTORS["valid"])
def test_every_valid_vector_is_accepted(boundaries: dict[str, Any]):
    assert parse_set_body({"version": 0, "boundaries": boundaries}) == (
        0,
        boundaries["topic"].strip(),
    )


@pytest.mark.parametrize("case", VECTORS["invalid"], ids=lambda case: case["why"])
def test_every_invalid_vector_is_400(case: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")
    # The refusal names the field at fault (the body itself: no field).
    detail = caught.value.detail or ""
    where = detail.split(":", 1)[0]
    if case["field"] is None:
        assert where in ("(body)", "boundaries"), detail
    else:
        assert where == f"boundaries.{case['field']}", detail


@pytest.mark.parametrize("case", VECTORS["removed"], ids=lambda case: case["field"])
def test_every_removed_vector_is_400_naming_the_field(case: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")
    assert caught.value.detail == f"boundaries.{case['field']}: {REMOVED_DETAIL}"


@pytest.mark.parametrize("case", VECTORS["normalised"], ids=lambda case: case["why"])
def test_every_normalised_vector_is_stored_as_expected(case: dict[str, Any]):
    _, topic = parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    assert {"topic": topic} == case["expect"]


@pytest.mark.parametrize("version", VECTORS["versions"]["valid"])
def test_every_valid_version_vector_is_accepted(version: Any):
    assert parse_set_body({"version": version, "boundaries": VECTORS["valid"][0]})[0] == version


@pytest.mark.parametrize("version", VECTORS["versions"]["invalid"], ids=repr)
def test_every_invalid_version_vector_is_400(version: Any):
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": version, "boundaries": VECTORS["valid"][0]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")


def _stored_document(stored: dict[str, Any], version: int) -> dict[str, Any]:
    """A vector's stored boundaries as an earlier relay wrote the Firestore document: its fields
    and each item's ``since``, beside the version and who and when."""
    out: dict[str, Any] = {
        **stored,
        "version": version,
        "updated_at": NOW,
        "updated_by": "owner1",
    }
    if "github_orgs" in stored:
        out["orgs_since"] = {o.lower(): 1 for o in stored["github_orgs"]}
    if "drives" in stored:
        out["drives"] = [{**d, "since": 1} for d in stored["drives"]]
    if "member_folders" in stored:
        out["member_folders_since"] = 1 if stored["member_folders"] else None
    if "github_repos" in stored:
        out["github_repos"] = [{**r, "since": 1} for r in stored["github_repos"]]
    if "drive_folders" in stored:
        out["drive_folders"] = [{**f, "since": 1} for f in stored["drive_folders"]]
    return out


@pytest.mark.parametrize("case", VECTORS["stored"], ids=lambda case: case["why"])
def test_every_stored_vector_reads_as_its_topic(case: dict[str, Any]):
    """A document an earlier relay stored (M10, schema v2) reads as v3: topic, version and who
    and when kept, the rest ignored."""
    from relay.boundaries import boundaries_json
    from relay.store_firestore import _boundaries_from_doc

    read = _boundaries_from_doc(_stored_document(case["stored"], 3))
    assert read == TeamBoundaries(
        version=3, topic=case["expect"]["topic"], updated_at=NOW, updated_by="owner1"
    )
    assert boundaries_json("t", read)["boundaries"] == case["expect"]


async def test_a_stored_v2_document_reads_as_v3_and_the_next_write_drops_the_rest(clock: FakeClock):
    """On the emulator: every stored vector written as an earlier relay wrote it reads over HTTP
    as its topic alone; members' acceptances of its version still count; an owner's next PUT
    (of the version read) replaces the whole document with the v3 fields only."""
    if not emulator_host():
        pytest.skip("FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh")
    from relay.store_firestore import FirestoreStore, _read

    for case in VECTORS["stored"]:
        async with open_api("firestore", clock) as api:
            fs = api.store
            assert isinstance(fs, FirestoreStore)
            ref = fs._boundaries(api.team)  # noqa: SLF001 - an earlier relay's exact shape
            await ref.set(_stored_document(case["stored"], 4))
            r = await api.get("bob", "/boundaries")
            assert r.status_code == 200, r.text
            assert r.json() == {
                "team": api.team,
                "version": 4,
                "boundaries": case["expect"],
                "updated_at": "2026-09-23T12:00:00.000Z",
                "updated_by": "owner1",
            }, case["why"]
            r = await api.client.put(
                api.url("/me/acceptance"), headers=auth("bob"), json={"version": 4}
            )
            assert r.status_code == 200, r.text
            r = await put(api, "alice", {"version": 4, "boundaries": {"topic": "Changed"}})
            assert r.status_code == 200, r.text
            raw = (await _read(ref)).to_dict()
            assert raw is not None
            assert set(raw) == {"version", "topic", "updated_at", "updated_by"}, case["why"]
            assert (raw["version"], raw["topic"], raw["updated_by"]) == (5, "Changed", "alice")


async def test_the_vectors_hold_over_http(api: Api):
    version = 0
    for boundaries in VECTORS["valid"]:
        r = await put(api, "alice", {"version": version, "boundaries": boundaries})
        assert r.status_code == 200, (boundaries, r.text)
        version += 1
        assert r.json()["version"] == version
        assert r.json()["boundaries"] == {"topic": boundaries["topic"].strip()}
    for case in VECTORS["invalid"]:
        r = await api.client.put(
            api.url("/boundaries"),
            headers={**auth("alice"), "Content-Type": "application/json"},
            content=json.dumps({"version": version, "boundaries": case["boundaries"]}),
        )
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), case["why"]
    for case in VECTORS["removed"]:
        r = await put(api, "alice", {"version": version, "boundaries": case["boundaries"]})
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body")
        assert r.json()["detail"] == f"boundaries.{case['field']}: {REMOVED_DETAIL}"
    for case in VECTORS["normalised"]:
        r = await put(api, "alice", {"version": version, "boundaries": case["boundaries"]})
        assert r.status_code == 200, r.text
        version += 1
        assert r.json()["boundaries"] == case["expect"]
    for bad in VECTORS["versions"]["invalid"]:
        r = await put(api, "alice", {"version": bad, "boundaries": VECTORS["valid"][0]})
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), bad
    assert (await api.get("bob", "/boundaries")).json()["version"] == version


def test_a_topic_keeps_its_inner_newlines_and_tabs():
    assert parse_set_body(body(topic="\n  Clients:\n\t- one\n\t- two\n\t"))[1] == (
        "Clients:\n\t- one\n\t- two"
    )


# The endpoints ------------------------------------------------------------------------------------


def _manage(data: dict[str, Any]) -> None:
    data["delegates"][0]["scope"] = ["read", "manage-roster"]


@asynccontextmanager
async def _managing(kind: str, clock: FakeClock, **limits: int) -> AsyncIterator[Api]:
    async with open_api(kind, clock, configure=_manage, **limits) as api:
        yield api


@pytest.fixture(params=["memory", "firestore"])
async def managed(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with _managing(request.param, clock) as api:
        yield api


async def put(api: Api, member: str, payload: Any) -> Any:
    return await api.client.put(api.url("/boundaries"), headers=auth(member), json=payload)


async def test_the_source_routes_are_gone(api: Api):
    """Local folders only (13 Nov 2026): no source settings, GitHub listing or Drive client,
    for an owner, a member or a delegate reading for an owner."""
    for path in ("/sources/config", "/sources/github", "/drive-client"):
        for member in ("alice", "bob"):
            r = await api.get(member, path)
            assert r.status_code == 404, (path, member, r.text)
        r = await api.delegated("GET", path, EMAILS["alice"])
        assert r.status_code in (403, 404), (path, r.text)
    assert not [route for route in DELEGATE_ROUTES if "/sources/" in route]


async def test_never_set_boundaries_read_as_version_0(api: Api):
    r = await api.get("bob", "/boundaries")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "team": api.team,
        "version": 0,
        "boundaries": None,
        "updated_at": None,
        "updated_by": None,
    }


async def test_an_owner_sets_them_and_every_member_reads_them(api: Api):
    r = await put(api, "alice", {"version": 0, "boundaries": EXAMPLE})
    assert r.status_code == 200, r.text
    expected = {
        "team": api.team,
        "version": 1,
        "boundaries": EXAMPLE,
        "updated_at": "2026-09-23T12:00:00.000Z",
        "updated_by": "alice",
    }
    assert r.json() == expected
    for member in ("alice", "bob", "carol"):
        r = await api.get(member, "/boundaries")
        assert r.status_code == 200 and r.json() == expected
    api.clock.advance(60)
    changed = {"topic": "Changed"}
    r = await put(api, "alice", {"version": 1, "boundaries": changed})
    assert r.status_code == 200
    assert r.json()["version"] == 2 and r.json()["boundaries"] == changed
    assert r.json()["updated_at"] == "2026-09-23T12:01:00.000Z"
    assert (await api.get("bob", "/boundaries")).json()["version"] == 2


async def test_a_stale_version_is_409(api: Api):
    assert (await put(api, "alice", {"version": 0, "boundaries": EXAMPLE})).status_code == 200
    for stale in (0, 2, 7):
        r = await put(api, "alice", {"version": stale, "boundaries": {**EXAMPLE, "topic": "Other"}})
        assert r.status_code == 409 and r.json()["error"] == "version_conflict", stale
    assert (await api.get("bob", "/boundaries")).json()["boundaries"]["topic"] == EXAMPLE["topic"]


async def test_concurrent_puts_of_one_version_store_one(api: Api):
    async def attempt(i: int) -> int:
        payload = {"version": 0, "boundaries": {**EXAMPLE, "topic": f"Topic {i}"}}
        return (await put(api, "alice", payload)).status_code

    codes = await asyncio.gather(*(attempt(i) for i in range(4)))
    assert sorted(codes) == [200, 409, 409, 409]
    assert (await api.get("bob", "/boundaries")).json()["version"] == 1


async def test_a_member_who_is_not_an_owner_gets_403(api: Api):
    r = await put(api, "bob", {"version": 0, "boundaries": EXAMPLE})
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    # Before the body is looked at: a bad body from a non-owner is still 403.
    r = await put(api, "bob", {"version": 0})
    assert r.status_code == 403
    assert (await api.get("bob", "/boundaries")).json()["version"] == 0
    refused = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_set"]
    assert [(e.actor, e.outcome, e.detail) for e in refused] == [
        ("bob", "refused", "403 forbidden"),
        ("bob", "refused", "403 forbidden"),
    ]


async def test_an_invalid_body_from_an_owner_is_400(api: Api):
    for payload in (
        {"version": 0, "boundaries": {**EXAMPLE, "unknown": 1}},
        {"version": 0, "boundaries": EXAMPLE, "unknown": 1},
        {"version": 0, "boundaries": {**EXAMPLE, "topic": ""}},
    ):
        r = await put(api, "alice", payload)
        assert r.status_code == 400 and r.json()["error"] == "invalid_body", payload
    r = await api.client.put(
        api.url("/boundaries"),
        headers={**auth("alice"), "Content-Type": "application/json"},
        content=b"{not json",
    )
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"
    assert (await api.get("bob", "/boundaries")).json()["version"] == 0


async def test_the_body_is_capped_like_every_other(api: Api):
    payload = {"version": 0, "boundaries": {**EXAMPLE, "topic": "x" * (300 * 1024)}}
    r = await put(api, "alice", payload)
    assert r.status_code == 413 and r.json()["error"] == "too_large"


async def test_outsiders_get_404_or_401(api: Api):
    # dave is a member of team other only: 404, as for the roster routes.
    r = await api.get("dave", "/boundaries")
    assert r.status_code == 404
    r = await put(api, "dave", {"version": 0, "boundaries": EXAMPLE})
    assert r.status_code == 404
    r = await api.client.get(api.url("/roster"), headers=auth("dave"))
    assert r.status_code == 404  # the same answer the roster gives
    # No credential at all: 401.
    r = await api.client.get(api.url("/boundaries"))
    assert r.status_code == 401
    r = await api.client.get(api.url("/boundaries"), headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    # A team that does not exist: 404 for a member of another team.
    r = await api.client.get("/v1/teams/nosuchteam/boundaries", headers=auth("alice"))
    assert r.status_code == 404


async def test_an_invited_member_is_not_a_member(api: Api):
    email = new_email()
    r = await api.client.post(
        api.url("/roster"), headers=auth("alice"), json={"member": "erin", "email": email}
    )
    assert r.status_code == 201, r.text
    erin = {"Authorization": f"Bearer {id_token(email, 'sub-erin-' + uuid.uuid4().hex)}"}
    r = await api.client.get(api.url("/boundaries"), headers=erin)
    assert r.status_code in (401, 404)
    r = await api.client.put(
        api.url("/boundaries"), headers=erin, json={"version": 0, "boundaries": EXAMPLE}
    )
    assert r.status_code in (401, 404)
    # Once accepted, a member reads them.
    sub = "sub-erin-" + uuid.uuid4().hex
    await accept_invitation(api.client, api.team, email, sub=sub)
    erin = {"Authorization": f"Bearer {id_token(email, sub)}"}
    assert (await api.client.get(api.url("/boundaries"), headers=erin)).status_code == 200


async def test_an_invited_owner_cannot_set_them(api: Api):
    email = new_email()
    r = await api.client.post(
        api.url("/roster"),
        headers=auth("alice"),
        json={"member": "olga", "email": email, "role": "owner"},
    )
    assert r.status_code == 201
    token = {"Authorization": f"Bearer {id_token(email, 'sub-olga-' + uuid.uuid4().hex)}"}
    r = await api.client.put(
        api.url("/boundaries"), headers=token, json={"version": 0, "boundaries": EXAMPLE}
    )
    assert r.status_code in (401, 404)
    assert (await api.get("bob", "/boundaries")).json()["version"] == 0


async def test_a_demoted_owner_is_refused_at_once(api: Api):
    r = await api.client.post(
        api.url("/roster"),
        headers=auth("alice"),
        json={"member": "olga", "email": (email := new_email()), "role": "owner"},
    )
    assert r.status_code == 201
    sub = "sub-olga-" + uuid.uuid4().hex
    await accept_invitation(api.client, api.team, email, sub=sub)
    olga = {"Authorization": f"Bearer {id_token(email, sub)}"}
    r = await api.client.put(
        api.url("/boundaries"), headers=olga, json={"version": 0, "boundaries": EXAMPLE}
    )
    assert r.status_code == 200
    r = await api.client.patch(
        api.url("/roster/olga"), headers=auth("alice"), json={"role": "member"}
    )
    assert r.status_code == 200
    r = await api.client.put(
        api.url("/boundaries"), headers=olga, json={"version": 1, "boundaries": EXAMPLE}
    )
    assert r.status_code == 403


async def test_a_read_only_delegate_reads_but_cannot_set(api: Api):
    r = await put(api, "alice", {"version": 0, "boundaries": EXAMPLE})
    assert r.status_code == 200
    r = await api.delegated("GET", "/boundaries", EMAILS["bob"])
    assert r.status_code == 200 and r.json()["version"] == 1
    r = await api.delegated(
        "PUT", "/boundaries", EMAILS["alice"], json={"version": 1, "boundaries": EXAMPLE}
    )
    assert r.status_code == 403
    assert (await api.get("bob", "/boundaries")).json()["version"] == 1


async def test_a_managing_delegate_sets_them_for_an_owner_only(managed: Api):
    api = managed
    payload = {"version": 0, "boundaries": EXAMPLE}
    r = await api.delegated("PUT", "/boundaries", EMAILS["bob"], json=payload)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    r = await api.delegated("PUT", "/boundaries", EMAILS["alice"], json=payload)
    assert r.status_code == 200, r.text
    assert r.json()["updated_by"] == "alice" and r.json()["version"] == 1
    # The delegate's own refusal goes to stdout, the owner's write to the audit.
    entries = [e for e in await api.store.list_audit(api.team) if e.outcome == "set"]
    assert [(e.actor, e.action, e.detail) for e in entries] == [
        ("alice", "boundaries_set", "version 1; via delegate")
    ]
    # Another team's delegate never reaches this team.
    r = await api.delegated("GET", "/boundaries", EMAILS["alice"], delegate="other")
    assert r.status_code in (403, 404)


async def test_the_audit_holds_the_version_and_never_the_text(api: Api):
    marker = "secret-topic-" + uuid.uuid4().hex
    boundaries = {"topic": marker}
    assert (await put(api, "alice", {"version": 0, "boundaries": boundaries})).status_code == 200
    entries = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_set"]
    assert [(e.actor, e.outcome, e.detail) for e in entries] == [("alice", "set", "version 1")]
    assert marker not in repr(await api.store.list_audit(api.team))


async def test_owner_writes_are_rate_limited(kind_clock: tuple[str, FakeClock]):
    kind, clock = kind_clock
    async with open_api(kind, clock, roster_mutations_per_hour=2) as api:
        for version in (0, 1):
            r = await put(api, "alice", {"version": version, "boundaries": EXAMPLE})
            assert r.status_code == 200, r.text
        r = await put(api, "alice", {"version": 2, "boundaries": EXAMPLE})
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        api.clock.advance(3600)
        assert (await put(api, "alice", {"version": 2, "boundaries": EXAMPLE})).status_code == 200


async def test_reads_are_rate_limited(kind_clock: tuple[str, FakeClock]):
    kind, clock = kind_clock
    async with open_api(kind, clock, reads_per_minute=3) as api:
        for _ in range(3):
            assert (await api.get("bob", "/boundaries")).status_code == 200
        r = await api.get("bob", "/boundaries")
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        # Another member's budget is their own.
        assert (await api.get("carol", "/boundaries")).status_code == 200


@pytest.fixture(params=["memory", "firestore"])
def kind_clock(request: pytest.FixtureRequest, clock: FakeClock) -> tuple[str, FakeClock]:
    return request.param, clock


async def test_deleting_a_created_team_removes_its_boundaries(api: Api):
    owner = new_email()
    team = new_id()
    sub = "sub-" + uuid.uuid4().hex
    headers = {"Authorization": f"Bearer {id_token(owner, sub)}"}
    r = await api.client.post(
        "/v1/teams",
        headers=headers,
        json={"id": team, "name": "Bounded", "owner_member_id": "olga"},
    )
    assert r.status_code == 201, r.text
    r = await api.client.put(
        f"/v1/teams/{team}/boundaries", headers=headers, json={"version": 0, "boundaries": EXAMPLE}
    )
    assert r.status_code == 200, r.text
    assert await api.store.get_boundaries(team) is not None
    r = await api.client.request(
        "DELETE", f"/v1/teams/{team}", headers=headers, json={"confirm": team}
    )
    assert r.status_code == 200 and r.json()["removal"] == "complete", r.text
    assert await api.store.get_boundaries(team) is None
    r = await api.client.get(f"/v1/teams/{team}/boundaries", headers=headers)
    assert r.status_code in (401, 404)
