"""M10-SPEC §1: a team's boundaries, on both stores. The store primitive (read, a versioned
write in one transaction with the actor's roster entry, TeamGone, the quota, the purge), the
body's validation, and the endpoints: who may read, who may write (owners; a delegate with
manage-roster for an owner), the version check, the audit (no text), the rate limit, and that
deleting a team removes them. The Firestore half needs the emulator (scripts/test-relay.sh)."""

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

from relay.boundaries import parse_set_body
from relay.errors import ApiError
from relay.store import (
    AuditEntry,
    BoundariesChange,
    DriveBoundary,
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

EXAMPLE = {
    "topic": (
        "Example Org: our clients and their delivery, our products and tools, engineering, "
        "playbook, pipeline and team work."
    ),
    "github_orgs": ["Example-Org"],
    "drives": [{"domain": "example.com", "shared_drive": "Example Team Drive"}],
    "member_folders": False,
}


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


TEAM_DRIVE = DriveBoundary(domain="example.com", shared_drive="Example Team Drive")


def doc(version: int, topic: str = "Our work", by: str = "owner1") -> TeamBoundaries:
    return TeamBoundaries(
        version=version,
        topic=topic,
        github_orgs=["Example-Org", "acme"],
        drives=[TEAM_DRIVE],
        member_folders=True,
        updated_at=NOW + timedelta(seconds=version),
        updated_by=by,
        org_since={"example-org": 1, "acme": version},
        drive_since={TEAM_DRIVE: 1},
        member_folders_since=version,
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
    version, parsed = parse_set_body(body())
    assert version == 0
    assert parsed.topic == EXAMPLE["topic"]
    assert parsed.github_orgs == ["Example-Org"]
    assert parsed.drives == [DriveBoundary("example.com", "Example Team Drive")]
    assert parsed.member_folders is False


def test_the_topic_is_trimmed_and_lists_are_deduplicated():
    _, parsed = parse_set_body(
        body(
            topic="  Our clients  ",
            github_orgs=["Example-Org", "example-org", "acme", "ACME", "b"],
            drives=[
                {"domain": "example.com", "shared_drive": "Team"},
                {"domain": "example.com", "shared_drive": "Team"},
                {"domain": "example.com", "shared_drive": "Other"},
                {"domain": "example.org", "shared_drive": "Team"},
            ],
        )
    )
    assert parsed.topic == "Our clients"
    assert parsed.github_orgs == ["Example-Org", "acme", "b"]  # first spelling kept
    assert parsed.drives == [
        DriveBoundary("example.com", "Team"),
        DriveBoundary("example.com", "Other"),
        DriveBoundary("example.org", "Team"),
    ]


def test_limits_hold_after_deduplication():
    orgs = [f"org{i}" for i in range(10)]
    _, parsed = parse_set_body(body(github_orgs=orgs))
    assert parsed.github_orgs == orgs
    _, parsed = parse_set_body(body(github_orgs=[], drives=[]))
    assert parsed.github_orgs == [] and parsed.drives == []
    _, parsed = parse_set_body(body(topic="x" * 500))
    assert len(parsed.topic) == 500
    _, parsed = parse_set_body(body(github_orgs=["a" * 39, "A1-b", "9"]))
    assert parsed.github_orgs == ["a" * 39, "A1-b", "9"]
    long_domain = ".".join(["a" * 63] * 3) + "." + "b" * 61  # 253 characters
    assert len(long_domain) == 253
    _, parsed = parse_set_body(body(drives=[{"domain": long_domain, "shared_drive": "x" * 100}]))
    assert parsed.drives[0].domain == long_domain


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
    {"topic": "bidi ‮ override"},
    {"topic": "nul \x00"},
    {"topic": 5},
    {"topic": None},
    {"github_orgs": "Example-Org"},
    {"github_orgs": [f"org{i}" for i in range(11)]},
    {"github_orgs": [f"org{i % 3}" for i in range(11)]},  # capped before de-duplication
    {"github_orgs": ["-leading"]},
    {"github_orgs": [""]},
    {"github_orgs": ["a" * 40]},
    {"github_orgs": ["under_score"]},
    {"github_orgs": ["dot.ted"]},
    {"github_orgs": ["trailing\n"]},
    {"github_orgs": ["ünïcode"]},
    {"github_orgs": [1]},
    {"drives": {"domain": "example.com", "shared_drive": "x"}},
    {"drives": [{"domain": "example.com", "shared_drive": f"d{i}"} for i in range(11)]},
    {"drives": [{"domain": "example.com"}]},
    {"drives": [{"shared_drive": "x"}]},
    {"drives": [{"domain": "example.com", "shared_drive": "x", "id": "y"}]},
    {"drives": [{"domain": "Example.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "example", "shared_drive": "x"}]},
    {"drives": [{"domain": "example.com.", "shared_drive": "x"}]},
    {"drives": [{"domain": ".example.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "example..com", "shared_drive": "x"}]},
    {"drives": [{"domain": "-example.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "example-.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "example_org.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "10.0.0.1", "shared_drive": "x"}]},
    {"drives": [{"domain": "a" * 64 + ".com", "shared_drive": "x"}]},
    {"drives": [{"domain": ".".join(["a" * 63] * 4), "shared_drive": "x"}]},  # 255
    {"drives": [{"domain": "example.com\n", "shared_drive": "x"}]},
    {"drives": [{"domain": "user@example.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "éxample.com", "shared_drive": "x"}]},
    {"drives": [{"domain": "example.com", "shared_drive": ""}]},
    {"drives": [{"domain": "example.com", "shared_drive": "   "}]},
    {"drives": [{"domain": "example.com", "shared_drive": "x" * 101}]},
    {"drives": [{"domain": "example.com", "shared_drive": "a/b"}]},
    {"drives": [{"domain": "example.com", "shared_drive": ".."}]},
    {"drives": [{"domain": "example.com", "shared_drive": "."}]},
    {"drives": [{"domain": "example.com", "shared_drive": "new\nline"}]},
    {"drives": [{"domain": "example.com", "shared_drive": "nul\x00"}]},
    {"drives": [{"domain": "example.com", "shared_drive": "bidi‮"}]},
    {"drives": [{"domain": "example.com", "shared_drive": 7}]},
    {"member_folders": "yes"},
    {"member_folders": 1},
    {"member_folders": None},
]


@pytest.mark.parametrize("change", BAD_BOUNDARIES)
def test_invalid_boundaries_are_400(change: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_set_body(body(**change))
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")


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
        {"version": 0, "boundaries": {**EXAMPLE, "secret": "x"}},
        {"version": 0, "boundaries": {k: v for k, v in EXAMPLE.items() if k != "topic"}},
        {"version": 0, "boundaries": {k: v for k, v in EXAMPLE.items() if k != "member_folders"}},
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
        {"github_orgs": [marker + "!"]},
        {"drives": [{"domain": marker + ".COM", "shared_drive": "x"}]},
        {"drives": [{"domain": "a.com", "shared_drive": marker + "/"}]},
    ):
        with pytest.raises(ApiError) as caught:
            parse_set_body(body(**change))
        assert marker not in str(caught.value.body())
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": 0, "boundaries": EXAMPLE, marker: 1})
    assert marker not in str(caught.value.body())


# M10-SPEC §7.5: the shared vectors ----------------------------------------------------------------

VECTORS_PATH = REPO_ROOT / "schema" / "boundaries-vectors.json"


def _vectors() -> dict[str, Any]:
    raw = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    # Each placeholder's value, as the file's "placeholders" texts say.
    placeholders = {
        "TOPIC_501": "a" * 501,
        "DOMAIN_253": f"{'a' * 63}.{'b' * 63}.{'c' * 63}.{'d' * 57}.com",
        "DOMAIN_254": f"{'a' * 63}.{'b' * 63}.{'c' * 63}.{'d' * 58}.com",
        "LABEL_63_DOMAIN": f"{'a' * 63}.example.com",
        "LABEL_64_DOMAIN": f"{'a' * 64}.example.com",
        "DRIVE_100": "d" * 100,
        "DRIVE_101": "d" * 101,
    }
    assert len(placeholders["DOMAIN_253"]) == 253 and len(placeholders["DOMAIN_254"]) == 254
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
    topics = [case["boundaries"]["topic"] for case in VECTORS["invalid"]]
    assert "a" * 501 in topics and "TOPIC_501" not in topics
    text = json.dumps([VECTORS["valid"], VECTORS["invalid"]])
    assert not any(f'"{name}"' in text for name in VECTORS["placeholders"])


@pytest.mark.parametrize("boundaries", VECTORS["valid"])
def test_every_valid_vector_is_accepted(boundaries: dict[str, Any]):
    _, parsed = parse_set_body({"version": 0, "boundaries": boundaries})
    assert parsed.topic == boundaries["topic"].strip()
    assert parsed.member_folders is boundaries["member_folders"]


@pytest.mark.parametrize("case", VECTORS["invalid"], ids=lambda case: case["why"])
def test_every_invalid_vector_is_400(case: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")


@pytest.mark.parametrize("version", VECTORS["versions"]["valid"])
def test_every_valid_version_vector_is_accepted(version: Any):
    assert parse_set_body({"version": version, "boundaries": VECTORS["valid"][0]})[0] == version


@pytest.mark.parametrize("version", VECTORS["versions"]["invalid"], ids=repr)
def test_every_invalid_version_vector_is_400(version: Any):
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": version, "boundaries": VECTORS["valid"][0]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")


def test_a_topic_keeps_its_inner_newlines_and_tabs():
    _, parsed = parse_set_body(body(topic="\n  Clients:\n\t- one\n\t- two\n\t"))
    assert parsed.topic == "Clients:\n\t- one\n\t- two"


async def test_the_vectors_hold_over_http(api: Api):
    version = 0
    for boundaries in VECTORS["valid"]:
        r = await put(api, "alice", {"version": version, "boundaries": boundaries})
        assert r.status_code == 200, (boundaries, r.text)
        version += 1
        assert r.json()["version"] == version
    for case in VECTORS["invalid"]:
        r = await put(api, "alice", {"version": version, "boundaries": case["boundaries"]})
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), case["why"]
    for bad in VECTORS["versions"]["invalid"]:
        r = await put(api, "alice", {"version": bad, "boundaries": VECTORS["valid"][0]})
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), bad
    assert (await api.get("bob", "/boundaries")).json()["version"] == version


# M10-SPEC §7.2: drives only in the relay's own domains --------------------------------------------


def test_with_allowed_domains_every_drive_domain_must_be_one():
    allowed = frozenset({"example.com", "example.org"})
    drives = [
        {"domain": "example.com", "shared_drive": "A"},
        {"domain": "example.org", "shared_drive": "B"},
    ]
    _, parsed = parse_set_body(body(drives=drives), allowed)
    assert [d.domain for d in parsed.drives] == ["example.com", "example.org"]
    for domain in ("sub.example.com", "example.net", "com.example.com", "xample.com"):
        bad = [*drives, {"domain": domain, "shared_drive": "C"}]
        with pytest.raises(ApiError) as caught:
            parse_set_body(body(drives=bad), allowed)
        assert (caught.value.status, caught.value.code) == (400, "domain_not_allowed")
        assert domain not in str(caught.value.body())
    # Unset: any domain, as before.
    assert parse_set_body(body(drives=[{"domain": "example.net", "shared_drive": "C"}]))


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_drive_outside_the_allowed_domains_is_400(kind: str, clock: FakeClock):
    allowed = frozenset({"example.com"})
    async with open_api(kind, clock, allowed_domains=allowed) as api:
        bad = {**EXAMPLE, "drives": [{"domain": "example.org", "shared_drive": "D"}]}
        r = await put(api, "alice", {"version": 0, "boundaries": bad})
        assert (r.status_code, r.json()["error"]) == (400, "domain_not_allowed")
        assert (await api.get("bob", "/boundaries")).json()["version"] == 0
        r = await put(api, "alice", {"version": 0, "boundaries": EXAMPLE})
        assert r.status_code == 200, r.text


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_drive_saved_before_the_allowed_domains_were_set_is_never_handed_out(
    kind: str, clock: FakeClock
):
    """Boundaries saved while RELAY_ALLOWED_DOMAINS was unset may hold a drive of another
    domain; once it is set, GET leaves that drive out (the rest is as stored)."""
    allowed = frozenset({"example.com"})
    async with open_api(kind, clock, allowed_domains=allowed) as api:
        saved = TeamBoundaries(
            version=4,
            topic="Our work",
            github_orgs=["Example-Org"],
            drives=[
                DriveBoundary(domain="example.org", shared_drive="Other Domain Drive"),
                DriveBoundary(domain="example.com", shared_drive="Example Team Drive"),
                DriveBoundary(domain="sub.example.com", shared_drive="Sub Drive"),
            ],
            member_folders=True,
            updated_at=NOW,
            updated_by="alice",
            org_since={"example-org": 2},
            drive_since={
                DriveBoundary(domain="example.org", shared_drive="Other Domain Drive"): 1,
                DriveBoundary(domain="example.com", shared_drive="Example Team Drive"): 3,
                DriveBoundary(domain="sub.example.com", shared_drive="Sub Drive"): 4,
            },
            member_folders_since=4,
        )
        stored = await api.store.set_boundaries(
            api.team, "alice", setting(api.team, 0, saved, owner_only=False)
        )
        assert stored == "set"
        for member in ("alice", "bob"):
            r = await api.get(member, "/boundaries")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["version"] == 4
            assert body["boundaries"] == {
                "topic": "Our work",
                "github_orgs": ["Example-Org"],
                "drives": [{"domain": "example.com", "shared_drive": "Example Team Drive"}],
                "member_folders": True,
            }
            assert body["since"] == {
                "github_orgs": {"example-org": 2},
                "drives": [
                    {"domain": "example.com", "shared_drive": "Example Team Drive", "since": 3}
                ],
                "member_folders": 4,
            }
            assert "example.org" not in r.text and "Sub Drive" not in r.text
        # The store keeps what was saved: only what is handed out is narrowed.
        assert await api.store.get_boundaries(api.team) == saved
    # Unset: every drive, as stored.
    async with open_api(kind, clock) as api:
        await api.store.set_boundaries(
            api.team, "alice", setting(api.team, 0, saved, owner_only=False)
        )
        r = await api.get("bob", "/boundaries")
        assert [d["domain"] for d in r.json()["boundaries"]["drives"]] == [
            "example.org",
            "example.com",
            "sub.example.com",
        ]


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


async def test_never_set_boundaries_read_as_version_0(api: Api):
    r = await api.get("bob", "/boundaries")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "team": api.team,
        "version": 0,
        "boundaries": None,
        "since": None,
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
        "since": {
            "github_orgs": {"example-org": 1},
            "drives": [{"domain": "example.com", "shared_drive": "Example Team Drive", "since": 1}],
            "member_folders": None,
        },
        "updated_at": "2026-09-23T12:00:00.000Z",
        "updated_by": "alice",
    }
    assert r.json() == expected
    for member in ("alice", "bob", "carol"):
        r = await api.get(member, "/boundaries")
        assert r.status_code == 200 and r.json() == expected
    api.clock.advance(60)
    changed = {**EXAMPLE, "member_folders": True, "github_orgs": ["Example-Org", "acme"]}
    r = await put(api, "alice", {"version": 1, "boundaries": changed})
    assert r.status_code == 200
    assert r.json()["version"] == 2 and r.json()["boundaries"] == changed
    assert r.json()["updated_at"] == "2026-09-23T12:01:00.000Z"
    assert (await api.get("bob", "/boundaries")).json()["version"] == 2


async def test_since_says_in_which_version_each_item_was_last_added(api: Api):
    """M10-SPEC §7.1: an item keeps the version it was added in while it stays (whatever else
    changes, and whatever the org's case); dropped and added back, it gets the version that
    added it back. Member folders likewise while allowed."""
    other = {"domain": "example.com", "shared_drive": "Other Drive"}
    steps: list[tuple[dict[str, Any], dict[str, Any]]] = [
        (
            EXAMPLE,
            {"github_orgs": {"example-org": 1}, "drives": [1], "member_folders": None},
        ),
        (
            {**EXAMPLE, "topic": "Changed", "github_orgs": ["example-org", "acme"]},
            {"github_orgs": {"example-org": 1, "acme": 2}, "drives": [1], "member_folders": None},
        ),
        (
            {**EXAMPLE, "github_orgs": ["acme"], "drives": [], "member_folders": True},
            {"github_orgs": {"acme": 2}, "drives": [], "member_folders": 3},
        ),
        (
            {
                **EXAMPLE,
                "github_orgs": ["ACME", "Example-Org"],
                "drives": [other, *EXAMPLE["drives"]],
                "member_folders": True,
            },
            {"github_orgs": {"acme": 2, "example-org": 4}, "drives": [4, 4], "member_folders": 3},
        ),
        (
            {**EXAMPLE, "github_orgs": ["acme", "Example-Org"], "member_folders": False},
            {"github_orgs": {"acme": 2, "example-org": 4}, "drives": [4], "member_folders": None},
        ),
        (
            {
                **EXAMPLE,
                "github_orgs": ["acme", "Example-Org"],
                "drives": [other, *EXAMPLE["drives"]],
                "member_folders": True,
            },
            {"github_orgs": {"acme": 2, "example-org": 4}, "drives": [6, 4], "member_folders": 6},
        ),
    ]
    for version, (boundaries, want) in enumerate(steps):
        r = await put(api, "alice", {"version": version, "boundaries": boundaries})
        assert r.status_code == 200, r.text
        since = r.json()["since"]
        drives = r.json()["boundaries"]["drives"]
        assert since["github_orgs"] == want["github_orgs"], version + 1
        assert since["drives"] == [
            {**d, "since": n} for d, n in zip(drives, want["drives"], strict=True)
        ], version + 1
        assert since["member_folders"] == want["member_folders"], version + 1
        assert (await api.get("bob", "/boundaries")).json()["since"] == since


async def test_since_is_computed_from_the_version_the_write_replaces(store: Store):
    """The service's function gets the stored version inside the writing transaction, so
    ``since`` is carried from exactly the version a write replaces (both stores)."""
    from relay.boundaries import Boundaries, carried_since

    team, email = new_id(), new_email()
    await create(store, team, email)
    plain = Boundaries(
        topic="T", github_orgs=["Example-Org"], drives=[TEAM_DRIVE], member_folders=False
    )
    dropped = Boundaries(topic="T", github_orgs=[], drives=[], member_folders=False)

    def write(expected: int, body: Boundaries):
        def fn(current: TeamBoundaries | None, actor: RosterEntry | None) -> BoundariesChange[str]:
            assert (current.version if current else 0) == expected
            since = carried_since(current, expected + 1, body)
            new = TeamBoundaries(
                version=expected + 1,
                topic=body.topic,
                github_orgs=body.github_orgs,
                drives=body.drives,
                member_folders=body.member_folders,
                updated_at=NOW,
                updated_by="owner1",
                org_since=since.orgs,
                drive_since=since.drives,
                member_folders_since=since.member_folders,
            )
            return BoundariesChange(result="set", boundaries=new)

        return fn

    await store.set_boundaries(team, "owner1", write(0, plain))
    await store.set_boundaries(team, "owner1", write(1, plain))
    stored = await store.get_boundaries(team)
    assert stored is not None
    assert (stored.org_since, stored.drive_since) == ({"example-org": 1}, {TEAM_DRIVE: 1})
    await store.set_boundaries(team, "owner1", write(2, dropped))
    await store.set_boundaries(team, "owner1", write(3, plain))
    stored = await store.get_boundaries(team)
    assert stored is not None
    assert (stored.org_since, stored.drive_since) == ({"example-org": 4}, {TEAM_DRIVE: 4})
    assert stored.member_folders_since is None


async def test_a_document_saved_before_since_counts_each_item_from_its_own_version():
    """A Firestore document written before ``since`` was recorded: every item counts as added
    in that document's version, so no earlier acceptance covers it (M10-SPEC §7.1)."""
    if not emulator_host():
        pytest.skip("FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh")
    from relay.store_firestore import FirestoreStore

    fs = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-relay"))
    try:
        team = new_id()
        await fs._boundaries(team).set(  # noqa: SLF001 - an older document's exact shape
            {
                "version": 5,
                "topic": "T",
                "github_orgs": ["Example-Org"],
                "drives": [{"domain": "example.com", "shared_drive": "Example Team Drive"}],
                "member_folders": True,
                "updated_at": NOW,
                "updated_by": "owner1",
            }
        )
        stored = await fs.get_boundaries(team)
        assert stored is not None
        assert stored.org_since == {"example-org": 5}
        assert stored.drive_since == {TEAM_DRIVE: 5}
        assert stored.member_folders_since == 5
    finally:
        await fs.aclose()


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
    boundaries = {
        "topic": marker,
        "github_orgs": [marker[:30]],
        "drives": [{"domain": "example.com", "shared_drive": marker}],
        "member_folders": True,
    }
    assert (await put(api, "alice", {"version": 0, "boundaries": boundaries})).status_code == 200
    entries = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_set"]
    assert [(e.actor, e.outcome, e.detail) for e in entries] == [("alice", "set", "version 1")]
    assert marker not in repr(await api.store.list_audit(api.team))
    assert marker[:30] not in repr(await api.store.list_audit(api.team))


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
