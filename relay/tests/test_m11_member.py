"""M11-SPEC §2, §3: a member's acceptance of the team's boundaries and the status their
background answerer reports, on both stores.

The store: an acceptance is written in one transaction with the team's boundaries and the
member's roster entry (a deleted team raises TeamGone); a status likewise with the member's
roster entry and the status it replaces; both leave with the member (a roster removal) and
with the team (the purge).

The endpoints: ``GET``/``PUT me/acceptance`` (the member itself, or a delegate: ``read`` to
read, ``member-self`` to accept, always for the viewer; no route names another member), the
version and ``not_set`` checks, the strict body, the audit (the version, never text), the write
budget; ``PUT me/status`` (the member itself only, never a delegate), its strict schema, the
relay's ``seen_at`` and the 20-second rule; ``GET members/status`` (``answering`` within 180 s,
``accepted_version``, active members only, and, local folders only since 13 Nov 2026, each
member's ``folder_count``: to an owner for everyone, to anyone else only their own; a status an
older plugin stored reads with a null count). The Firestore half needs the emulator
(scripts/test-relay.sh)."""

from __future__ import annotations

import copy
import json
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import pytest
from fastapi.routing import APIRoute

from relay.app import DELEGATE_ROUTES, MEMBER_SELF_MUTATIONS
from relay.errors import ApiError
from relay.store import (
    Acceptance,
    AcceptanceChange,
    AuditEntry,
    BoundariesChange,
    MemberStatus,
    Quota,
    QuotaExceeded,
    RosterChange,
    RosterEntry,
    StatusChange,
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
STAMP = "2026-09-23T12:00:00.000Z"
EXAMPLE = {"topic": "Example Org: our clients, products and engineering."}
STATUS: dict[str, Any] = {
    "daemon": {"version": "0.11.0", "started_at": "2026-09-23T11:59:00.000Z"},
    "claude": {"found": True, "signed_in": True},
    "folder_count": 5,
    "self_test": {"ok": True, "at": "2026-09-23T11:59:30.000Z", "reason": None},
}
# What a status entry of members/status shows: never the folder count.
SHOWN = {k: v for k, v in STATUS.items() if k != "folder_count"}
# A status an older plugin reported, as an earlier relay stored it (before 13 Nov 2026).
OLD_STATUS: dict[str, Any] = {
    "daemon": {"version": "0.10.0", "started_at": "2026-09-23T11:59:00.000Z"},
    "claude": {"found": True, "signed_in": True},
    "folders": {"repo_roots": 2, "clones": 37, "extra_folders": 0},
    "drive": {"connected": True},
    "self_test": {"ok": True, "at": "2026-09-23T11:59:30.000Z", "reason": None},
    "sources": {"boundaries_version": 1, "missing": ["repo:example-org/api"]},
}
FOLDER_COUNTS = json.loads(
    (REPO_ROOT / "schema" / "boundaries-vectors.json").read_text(encoding="utf-8")
)["folder_counts"]


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


def boundaries(version: int) -> TeamBoundaries:
    return TeamBoundaries(version=version, topic="Our work", updated_at=NOW, updated_by="owner1")


def put_boundaries(new: TeamBoundaries):
    def fn(current: TeamBoundaries | None, actor: RosterEntry | None) -> BoundariesChange[None]:
        return BoundariesChange(result=None, boundaries=new)

    return fn


def member_entry(member: str) -> RosterEntry:
    return RosterEntry(
        member=member,
        emails=[new_email()],
        role="member",
        added_by="owner1",
        added_at=NOW,
        updated_at=NOW,
    )


def audit_entry(team: str, actor: str, version: int) -> AuditEntry:
    return AuditEntry(
        time=NOW,
        team=team,
        actor=actor,
        action="boundaries_accepted",
        outcome="accepted",
        expire_at=NOW + timedelta(days=30),
        detail=f"version {version}",
    )


def accepting(team: str, member: str, version: int):
    """The service's rule in miniature: the boundaries are set, ``version`` is theirs, and the
    member is an active one."""

    def fn(
        current: TeamBoundaries | None, accepted: Acceptance | None, entry: RosterEntry | None
    ) -> AcceptanceChange[Acceptance]:
        if entry is None or not entry.active:
            raise ApiError(404, "not_found")
        if current is None:
            raise ApiError(409, "not_set")
        if current.version != version:
            raise ApiError(409, "version_conflict")
        new = Acceptance(version=version, accepted_at=NOW)
        return AcceptanceChange(
            result=new, acceptance=new, audit=[audit_entry(team, member, version)]
        )

    return fn


def reporting(status: dict[str, Any], seen: Any = NOW):
    def fn(current: MemberStatus | None, entry: RosterEntry | None) -> StatusChange[str]:
        if entry is None or not entry.active:
            raise ApiError(404, "not_found")
        return StatusChange(result="written", status=MemberStatus(status=status, seen_at=seen))

    return fn


async def team_with_member(store: Store, member: str = "member1") -> str:
    team, email = new_id(), new_email()
    await create(store, team, email)
    await store.mutate_roster(
        team, lambda state: RosterChange(result=None, put=[member_entry(member)]), NOW
    )
    return team


# The store: acceptances ---------------------------------------------------------------------


async def test_no_acceptance_reads_as_nothing(store: Store):
    assert await store.get_acceptances(new_id(), ["member1"]) == {}


async def test_an_acceptance_is_written_with_its_audit_and_read_back(store: Store):
    team = await team_with_member(store)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    written = await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    assert written == Acceptance(version=1, accepted_at=NOW)
    assert await store.get_acceptances(team, ["member1", "owner1"]) == {"member1": written}
    audit = [e for e in await store.list_audit(team) if e.action == "boundaries_accepted"]
    assert [(e.actor, e.detail) for e in audit] == [("member1", "version 1")]


async def test_the_function_sees_the_boundaries_the_acceptance_and_the_entry(store: Store):
    team = await team_with_member(store)
    seen: list[Any] = []

    def peek(current, accepted, entry):
        seen.append(
            (
                current.version if current else None,
                accepted.version if accepted else None,
                entry.member if entry else None,
            )
        )
        return AcceptanceChange(result=None)

    await store.set_acceptance(team, "member1", peek)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    await store.set_acceptance(team, "member1", peek)
    await store.set_acceptance(team, "nobody", peek)
    assert seen == [(None, None, "member1"), (1, 1, "member1"), (1, None, None)]


async def test_a_refused_acceptance_writes_nothing(store: Store):
    team = await team_with_member(store)
    with pytest.raises(ApiError) as exc:
        await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    assert exc.value.code == "not_set"
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(2)))
    with pytest.raises(ApiError) as exc:
        await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    assert exc.value.code == "version_conflict"
    assert await store.get_acceptances(team, ["member1"]) == {}
    assert [e for e in await store.list_audit(team) if e.action == "boundaries_accepted"] == []


async def test_the_quota_is_counted_only_on_a_write(store: Store):
    team = await team_with_member(store)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    quota = Quota(key="member1.acceptance.0", limit=1, expire_at=NOW + timedelta(hours=2))
    await store.set_acceptance(team, "member1", lambda *_: AcceptanceChange(result=None), [quota])
    await store.set_acceptance(team, "member1", accepting(team, "member1", 1), [quota])
    with pytest.raises(QuotaExceeded):
        await store.set_acceptance(team, "member1", accepting(team, "member1", 1), [quota])


async def test_a_deleted_team_takes_no_acceptance_and_no_status(store: Store):
    team = await team_with_member(store)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    await store.delete_team(team, deleting())
    with pytest.raises(TeamGone):
        await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    with pytest.raises(TeamGone):
        await store.set_member_status(team, "member1", reporting(STATUS))
    assert await store.get_acceptances(team, ["member1"]) == {}
    assert await store.get_member_statuses(team, ["member1"]) == {}


# The store: statuses ------------------------------------------------------------------------


async def test_a_status_is_overwritten_and_read_back(store: Store):
    team = await team_with_member(store)
    assert await store.get_member_statuses(team, ["member1"]) == {}
    assert await store.set_member_status(team, "member1", reporting(STATUS)) == "written"
    changed = copy.deepcopy(STATUS)
    changed["folder_count"] = 6
    later = NOW + timedelta(seconds=60)
    await store.set_member_status(team, "member1", reporting(changed, later))
    assert await store.get_member_statuses(team, ["member1", "owner1"]) == {
        "member1": MemberStatus(status=changed, seen_at=later)
    }


async def test_the_status_function_sees_the_status_it_replaces(store: Store):
    team = await team_with_member(store)
    seen: list[Any] = []

    def peek(current, entry):
        seen.append((current.seen_at if current else None, entry.member if entry else None))
        return StatusChange(result=None)

    await store.set_member_status(team, "member1", peek)
    await store.set_member_status(team, "member1", reporting(STATUS))
    await store.set_member_status(team, "member1", peek)
    await store.set_member_status(team, "nobody", peek)
    assert seen == [(None, "member1"), (NOW, "member1"), (None, None)]
    assert await store.get_member_statuses(team, ["nobody"]) == {}


# Leaving -----------------------------------------------------------------------------------


async def test_a_removed_member_takes_their_acceptance_and_status_along(store: Store):
    team = await team_with_member(store)
    await team_member_two(store, team)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    for member in ("member1", "member2"):
        await store.set_acceptance(team, member, accepting(team, member, 1))
        await store.set_member_status(team, member, reporting(STATUS))
    await store.mutate_roster(
        team, lambda state: RosterChange(result=None, remove=["member1"]), NOW
    )
    both = ["member1", "member2"]
    assert set(await store.get_acceptances(team, both)) == {"member2"}
    assert set(await store.get_member_statuses(team, both)) == {"member2"}


async def team_member_two(store: Store, team: str) -> None:
    await store.mutate_roster(
        team, lambda state: RosterChange(result=None, put=[member_entry("member2")]), NOW
    )


async def test_the_purge_removes_acceptances_and_statuses(store: Store):
    team = await team_with_member(store)
    await store.set_boundaries(team, "owner1", put_boundaries(boundaries(1)))
    await store.set_acceptance(team, "member1", accepting(team, "member1", 1))
    await store.set_member_status(team, "member1", reporting(STATUS))
    await store.delete_team(team, deleting())
    calls = 0
    while not await store.purge_team(team, 1):
        calls += 1
        assert calls < 50
    assert await store.get_acceptances(team, ["member1"]) == {}
    assert await store.get_member_statuses(team, ["member1"]) == {}
    assert await store.team_has_documents(team) is True  # the record itself stays
    assert (await store.get_teams([team]))[team].purge_complete is True


# The endpoints: acceptance ------------------------------------------------------------------


async def put_acceptance(api: Api, member: str, body: Any) -> Any:
    return await api.client.put(api.url("/me/acceptance"), headers=auth(member), json=body)


async def set_team_boundaries(api: Api, version: int) -> None:
    """The owner's PUT, from ``version - 1``."""
    r = await api.client.put(
        api.url("/boundaries"),
        headers=auth("alice"),
        json={"version": version - 1, "boundaries": {**EXAMPLE, "topic": f"Topic {version}"}},
    )
    assert r.status_code == 200, r.text


async def test_never_accepted_reads_as_version_0(api: Api):
    r = await api.get("bob", "/me/acceptance")
    assert r.status_code == 200, r.text
    assert r.json() == {"version": 0, "accepted_at": None}


async def test_accepting_before_the_boundaries_are_set_is_409_not_set(api: Api):
    for version in (0, 1):
        r = await put_acceptance(api, "bob", {"version": version})
        assert (r.status_code, r.json()["error"]) == (409, "not_set")
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 0


async def test_a_member_accepts_the_current_version_for_themselves(api: Api):
    await set_team_boundaries(api, 1)
    r = await put_acceptance(api, "bob", {"version": 1})
    assert r.status_code == 200, r.text
    assert r.json() == {"version": 1, "accepted_at": STAMP}
    assert (await api.get("bob", "/me/acceptance")).json() == {"version": 1, "accepted_at": STAMP}
    # Only bob's: nobody else has accepted anything.
    for member in ("alice", "carol"):
        assert (await api.get(member, "/me/acceptance")).json() == {
            "version": 0,
            "accepted_at": None,
        }


async def test_only_the_current_version_can_be_accepted(api: Api):
    await set_team_boundaries(api, 1)
    await set_team_boundaries(api, 2)
    for version in (0, 1, 3):
        r = await put_acceptance(api, "bob", {"version": version})
        assert (r.status_code, r.json()["error"]) == (409, "version_conflict"), version
    assert (await put_acceptance(api, "bob", {"version": 2})).status_code == 200
    await set_team_boundaries(api, 3)
    # A later version leaves the earlier acceptance as it was.
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 2


async def test_accepting_the_same_version_again_changes_nothing(api: Api):
    await set_team_boundaries(api, 1)
    assert (await put_acceptance(api, "bob", {"version": 1})).status_code == 200
    api.clock.advance(120)
    r = await put_acceptance(api, "bob", {"version": 1})
    assert r.status_code == 200 and r.json() == {"version": 1, "accepted_at": STAMP}
    entries = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_accepted"]
    assert len(entries) == 1


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"version": True},
        {"version": 1.0},
        {"version": "1"},
        {"version": None},
        {"version": -1},
        {"version": 2**31},
        {"version": 1, "member": "carol"},
        {"version": 1, "accepted_at": "2026-09-23T12:00:00Z"},
        [],
        None,
        "1",
    ],
)
async def test_an_invalid_body_is_400(api: Api, body: Any):
    await set_team_boundaries(api, 1)
    r = await put_acceptance(api, "bob", body)
    # No body at all (``None``) is not JSON.
    assert r.status_code == 400 and r.json()["error"] in ("invalid_body", "invalid_json"), r.text
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 0


async def test_the_audit_holds_the_version_only(api: Api):
    await set_team_boundaries(api, 1)
    assert (await put_acceptance(api, "bob", {"version": 1})).status_code == 200
    entries = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_accepted"]
    assert [(e.actor, e.outcome, e.detail) for e in entries] == [("bob", "accepted", "version 1")]
    # A refusal is filed too (by its code only).
    await put_acceptance(api, "carol", {"version": 7})
    refused = [
        e
        for e in await api.store.list_audit(api.team)
        if e.action == "boundaries_accepted" and e.outcome == "refused"
    ]
    assert [(e.actor, e.detail) for e in refused] == [("carol", "409 version_conflict")]


async def test_acceptances_count_against_the_members_write_budget(
    kind_clock: tuple[str, FakeClock],
):
    kind, clock = kind_clock
    async with open_api(kind, clock, roster_mutations_per_hour=2) as api:
        for version in (1, 2, 3):
            await api.store.set_boundaries(api.team, "alice", put_boundaries(boundaries(version)))
            r = await put_acceptance(api, "bob", {"version": version})
            if version < 3:
                assert r.status_code == 200, r.text
            else:
                assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        # Another member's budget is their own.
        assert (await put_acceptance(api, "carol", {"version": 3})).status_code == 200
        api.clock.advance(3600)
        assert (await put_acceptance(api, "bob", {"version": 3})).status_code == 200


@pytest.fixture(params=["memory", "firestore"])
def kind_clock(request: pytest.FixtureRequest, clock: FakeClock) -> tuple[str, FakeClock]:
    return request.param, clock


async def test_no_route_accepts_for_another_member(api: Api):
    """M11-SPEC §2: an owner cannot accept for anyone; the only acceptance route is the
    caller's own."""
    await set_team_boundaries(api, 1)
    acceptance_routes = {
        r.path for r in api.app.routes if isinstance(r, APIRoute) and "acceptance" in r.path
    }
    assert acceptance_routes == {"/v1/teams/{team}/me/acceptance"}
    for path in ("/members/bob/acceptance", "/roster/bob/acceptance", "/acceptance"):
        r = await api.client.put(api.url(path), headers=auth("alice"), json={"version": 1})
        assert r.status_code in (404, 405), path
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 0


async def test_outsiders_and_invited_members_cannot_accept(api: Api):
    await set_team_boundaries(api, 1)
    r = await put_acceptance(api, "dave", {"version": 1})
    assert r.status_code == 404
    r = await api.client.get(api.url("/me/acceptance"))
    assert r.status_code == 401
    email = new_email()
    r = await api.client.post(
        api.url("/roster"), headers=auth("alice"), json={"member": "erin", "email": email}
    )
    assert r.status_code == 201, r.text
    erin = {"Authorization": f"Bearer {id_token(email, 'sub-erin-' + uuid.uuid4().hex)}"}
    r = await api.client.put(api.url("/me/acceptance"), headers=erin, json={"version": 1})
    assert r.status_code in (401, 404)


# Delegates ---------------------------------------------------------------------------------


def _member_self(data: dict[str, Any]) -> None:
    data["delegates"][0]["scope"] = ["read", "member-self"]


@asynccontextmanager
async def _console(kind: str, clock: FakeClock, **limits: int) -> AsyncIterator[Api]:
    async with open_api(kind, clock, configure=_member_self, **limits) as api:
        yield api


@pytest.fixture(params=["memory", "firestore"])
async def console(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with _console(request.param, clock) as api:
        yield api


async def test_a_read_only_delegate_reads_the_acceptance_but_cannot_accept(api: Api):
    await set_team_boundaries(api, 1)
    r = await api.delegated("GET", "/me/acceptance", EMAILS["bob"])
    assert r.status_code == 200 and r.json() == {"version": 0, "accepted_at": None}
    r = await api.delegated("PUT", "/me/acceptance", EMAILS["bob"], json={"version": 1})
    assert r.status_code == 403
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 0


async def test_a_member_self_delegate_accepts_for_the_viewer_only(console: Api):
    api = console
    await set_team_boundaries(api, 1)
    r = await api.delegated("PUT", "/me/acceptance", EMAILS["bob"], json={"version": 1})
    assert r.status_code == 200, r.text
    assert r.json() == {"version": 1, "accepted_at": STAMP}
    assert (await api.get("bob", "/me/acceptance")).json()["version"] == 1
    assert (await api.get("carol", "/me/acceptance")).json()["version"] == 0
    entries = [
        e
        for e in await api.store.list_audit(api.team)
        if e.action == "boundaries_accepted" and e.outcome == "accepted"
    ]
    assert [(e.actor, e.detail) for e in entries] == [("bob", "version 1; via delegate")]
    # Another team's delegate never reaches this team.
    r = await api.delegated(
        "PUT", "/me/acceptance", EMAILS["carol"], delegate="other", json={"version": 1}
    )
    assert r.status_code in (403, 404)
    assert (await api.get("carol", "/me/acceptance")).json()["version"] == 0


async def test_a_member_self_delegate_reaches_nothing_else(console: Api):
    """Walks the app's route table: with ``member-self`` a delegate reaches the reads, the
    viewer's acceptance and the viewer's questions, and nothing else (never ``me/status``)."""
    api = console
    rid = await api.ask("alice", to=["bob"])
    assert MEMBER_SELF_MUTATIONS == {
        ("PUT", "/v1/teams/{team}/me/acceptance"),
        ("POST", "/v1/teams/{team}/requests"),
    }
    routes = [
        r for r in api.app.routes if isinstance(r, APIRoute) and r.path.startswith("/v1/teams/")
    ]
    for route in routes:
        path = (
            route.path.removeprefix("/v1/teams/{team}")
            .replace("{member}", "alice")
            .replace("{stream}", "inbox")
            .replace("{request_id}", rid)
            .replace("{credential_id}", "self")
        )
        for method in sorted(route.methods):
            kwargs = {} if method == "GET" else {"json": {}}
            r = await api.delegated(method, path, EMAILS["alice"], **kwargs)
            if method == "GET" and route.path in DELEGATE_ROUTES:
                assert r.status_code == 200, (method, route.path, r.text)
            elif (method, route.path) in MEMBER_SELF_MUTATIONS:
                # Reached: the empty body is what is refused.
                assert r.status_code in (400, 422), (method, route.path, r.text)
            else:
                assert r.status_code == 403, (method, route.path, r.text)


async def test_status_is_never_written_by_a_delegate(console: Api):
    api = console
    r = await api.delegated("PUT", "/me/status", EMAILS["bob"], json=STATUS)
    assert r.status_code == 403
    assert await api.store.get_member_statuses(api.team, ["bob"]) == {}


def test_the_new_reads_are_delegate_reads():
    assert {
        "/v1/teams/{team}/me/acceptance",
        "/v1/teams/{team}/members/status",
        "/v1/teams/{team}/me/requests",
    } <= DELEGATE_ROUTES
    assert "/v1/teams/{team}/me/status" not in DELEGATE_ROUTES


# The endpoints: status ----------------------------------------------------------------------


async def put_status(api: Api, member: str, body: Any) -> Any:
    return await api.client.put(api.url("/me/status"), headers=auth(member), json=body)


async def members_status(api: Api, member: str = "alice") -> dict[str, Any]:
    r = await api.get(member, "/members/status")
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_member_reports_and_every_member_reads_it(api: Api):
    r = await put_status(api, "bob", STATUS)
    assert r.status_code == 200, r.text
    # The answer: the status as stored, with the caller's own count.
    assert r.json() == {**STATUS, "seen_at": STAMP}

    def expected(bob_count: int | None) -> dict[str, Any]:
        return {
            "members": [
                {
                    "member": "alice",
                    "status": None,
                    "answering": False,
                    "accepted_version": 0,
                    "folder_count": None,
                },
                {
                    "member": "bob",
                    "status": {**SHOWN, "seen_at": STAMP},
                    "answering": True,
                    "accepted_version": 0,
                    "folder_count": bob_count,
                },
                {
                    "member": "carol",
                    "status": None,
                    "answering": False,
                    "accepted_version": 0,
                    "folder_count": None,
                },
            ],
            "boundaries_version": 0,
        }

    # alice is an owner: bob's count; bob: his own; carol (a member): not bob's.
    assert await members_status(api, "alice") == expected(5)
    assert await members_status(api, "bob") == expected(5)
    assert await members_status(api, "carol") == expected(None)


async def test_an_owner_sees_every_count_and_a_member_only_their_own(api: Api):
    assert (await put_status(api, "alice", {**STATUS, "folder_count": 0})).status_code == 200
    assert (await put_status(api, "bob", {**STATUS, "folder_count": 20})).status_code == 200
    assert (await put_status(api, "carol", {**STATUS, "folder_count": 1})).status_code == 200

    def counts(body: dict[str, Any]) -> dict[str, int | None]:
        return {m["member"]: m["folder_count"] for m in body["members"]}

    assert counts(await members_status(api, "alice")) == {"alice": 0, "bob": 20, "carol": 1}
    assert counts(await members_status(api, "bob")) == {"alice": None, "bob": 20, "carol": None}
    assert counts(await members_status(api, "carol")) == {"alice": None, "bob": None, "carol": 1}
    # A delegate reads as the member it names: an owner sees all, a member only their own.
    r = await api.delegated("GET", "/members/status", EMAILS["alice"])
    assert counts(r.json()) == {"alice": 0, "bob": 20, "carol": 1}
    r = await api.delegated("GET", "/members/status", EMAILS["carol"])
    assert counts(r.json()) == {"alice": None, "bob": None, "carol": 1}
    # The status groups never carry a count, a folder or a path.
    for body in (await members_status(api, "alice"), await members_status(api, "carol")):
        for entry in body["members"]:
            assert set(entry["status"]) == {"daemon", "claude", "self_test", "seen_at"}


async def test_a_status_an_older_plugin_stored_reads_with_a_null_count(api: Api):
    """Written by an earlier relay (folders, drive and sources groups, no count): still listed,
    its groups but those dropped, the count null even for an owner."""

    def fn(current: MemberStatus | None, entry: RosterEntry | None) -> StatusChange[None]:
        return StatusChange(result=None, status=MemberStatus(status=OLD_STATUS, seen_at=NOW))

    await api.store.set_member_status(api.team, "bob", fn)
    for member in ("alice", "bob"):
        bob = (await members_status(api, member))["members"][1]
        assert bob["member"] == "bob" and bob["folder_count"] is None
        assert bob["answering"] is True
        assert bob["status"] == {
            "daemon": OLD_STATUS["daemon"],
            "claude": OLD_STATUS["claude"],
            "self_test": OLD_STATUS["self_test"],
            "seen_at": STAMP,
        }
    # The member's plugin reports again: the new count replaces the old status whole.
    api.clock.advance(20)
    assert (await put_status(api, "bob", STATUS)).status_code == 200
    stored = (await api.store.get_member_statuses(api.team, ["bob"]))["bob"].status
    assert stored == STATUS
    assert (await members_status(api, "alice"))["members"][1]["folder_count"] == 5


@pytest.mark.parametrize("count", FOLDER_COUNTS["valid"])
async def test_every_valid_folder_count_vector_is_stored(api: Api, count: Any):
    r = await put_status(api, "bob", {**STATUS, "folder_count": count})
    assert r.status_code == 200, r.text
    assert r.json()["folder_count"] == count
    stored = (await api.store.get_member_statuses(api.team, ["bob"]))["bob"].status
    assert type(stored["folder_count"]) is int and stored["folder_count"] == count
    assert (await members_status(api, "alice"))["members"][1]["folder_count"] == count


@pytest.mark.parametrize("count", FOLDER_COUNTS["invalid"], ids=repr)
async def test_every_invalid_folder_count_vector_is_400(api: Api, count: Any):
    r = await put_status(api, "bob", {**STATUS, "folder_count": count})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), r.text
    assert r.json()["detail"].startswith("folder_count: ")
    assert await api.store.get_member_statuses(api.team, ["bob"]) == {}


@pytest.mark.parametrize(
    "extra",
    [
        {"folders": {"repo_roots": 2, "clones": 37, "extra_folders": 0}},
        {"drive": {"connected": True}},
        {"sources": {"boundaries_version": 1, "missing": []}},
    ],
)
async def test_an_older_plugins_body_is_400_unknown_field(api: Api, extra: dict[str, Any]):
    r = await put_status(api, "bob", {**STATUS, **extra})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), r.text
    assert r.json()["detail"].endswith("unknown field")
    # The whole older body (no count): refused too.
    r = await put_status(api, "bob", OLD_STATUS)
    assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), r.text
    assert await api.store.get_member_statuses(api.team, ["bob"]) == {}


async def test_the_status_carries_the_accepted_and_current_versions(api: Api):
    await set_team_boundaries(api, 1)
    assert (await put_acceptance(api, "carol", {"version": 1})).status_code == 200
    await set_team_boundaries(api, 2)
    body = await members_status(api)
    assert body["boundaries_version"] == 2
    assert {m["member"]: m["accepted_version"] for m in body["members"]} == {
        "alice": 0,
        "bob": 0,
        "carol": 1,
    }


async def test_answering_means_seen_in_the_last_180_seconds(api: Api):
    assert (await put_status(api, "bob", STATUS)).status_code == 200
    api.clock.advance(180)
    bob = (await members_status(api))["members"][1]
    assert bob["answering"] is True
    api.clock.advance(1)
    bob = (await members_status(api))["members"][1]
    assert bob["answering"] is False and bob["status"]["seen_at"] == STAMP


async def test_one_write_per_member_per_20_seconds(api: Api):
    assert (await put_status(api, "bob", STATUS)).status_code == 200
    api.clock.advance(19.999)
    r = await put_status(api, "bob", STATUS)
    assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
    # Another member is not held back.
    assert (await put_status(api, "carol", STATUS)).status_code == 200
    api.clock.advance(0.001)
    r = await put_status(api, "bob", STATUS)
    assert r.status_code == 200 and r.json()["seen_at"] == "2026-09-23T12:00:20.000Z"


async def test_a_status_write_is_not_audited(api: Api):
    before = await api.store.list_audit(api.team)
    assert (await put_status(api, "bob", STATUS)).status_code == 200
    api.clock.advance(1)
    assert (await put_status(api, "bob", STATUS)).status_code == 429
    assert await api.store.list_audit(api.team) == before


async def test_times_are_normalised_to_the_relays_form(api: Api):
    body = copy.deepcopy(STATUS)
    body["daemon"]["started_at"] = "2026-09-23T14:00:00+02:00"
    body["self_test"]["at"] = "2026-09-23T11:59:30.123456789z"
    r = await put_status(api, "bob", body)
    assert r.status_code == 200, r.text
    assert r.json()["daemon"]["started_at"] == "2026-09-23T12:00:00.000Z"
    assert r.json()["self_test"]["at"] == "2026-09-23T11:59:30.123Z"


def _with(path: str, value: Any) -> dict[str, Any]:
    body = copy.deepcopy(STATUS)
    *parents, last = path.split(".")
    node: Any = body
    for key in parents:
        node = node[key]
    node[last] = value
    return body


def _without(path: str) -> dict[str, Any]:
    body = copy.deepcopy(STATUS)
    *parents, last = path.split(".")
    node: Any = body
    for key in parents:
        node = node[key]
    del node[last]
    return body


VALID_EDGES = [
    _with("daemon.version", ""),
    _with("daemon.version", "v" * 32),
    _with("folder_count", 0),
    _with("folder_count", 20),
    _with("self_test.reason", "r" * 200),
    _with("self_test.reason", "claude auth status failed\nexit 1"),
    _with("self_test.ok", False),
    _with("claude.found", False),
]


@pytest.mark.parametrize("body", VALID_EDGES)
async def test_the_limits_are_inclusive(api: Api, body: dict[str, Any]):
    r = await put_status(api, "bob", body)
    assert r.status_code == 200, r.text
    assert {k: v for k, v in r.json().items() if k != "seen_at"} == body


INVALID = [
    _with("daemon.version", "v" * 33),
    _with("daemon.version", "1.0\x00"),
    _with("daemon.version", "1.0‮"),
    _with("daemon.version", 11),
    _with("daemon.started_at", "yesterday"),
    _with("daemon.started_at", "2026-09-23T12:00:00"),
    _with("daemon.started_at", "2026-13-01T00:00:00Z"),
    _with("daemon.started_at", "2026-09-23 12:00:00Z"),
    _with("daemon.started_at", "2026-09-23T12:00:00Z" + " " * 30),
    _with("daemon.started_at", 1758628800),
    _with("claude.found", 1),
    _with("claude.signed_in", "true"),
    _with("claude.signed_in", None),
    _with("folder_count", 21),
    _with("folder_count", -1),
    _with("folder_count", True),
    _with("folder_count", 2.0),
    _with("folder_count", "5"),
    _with("folder_count", None),
    _with("folder_count", [5]),
    _with("self_test.ok", None),
    _with("self_test.at", "now"),
    _with("self_test.reason", "r" * 201),
    _with("self_test.reason", "bell\x07"),
    _with("self_test.reason", 3),
    _with("daemon.path", "/Users/someone"),  # e1-guard: allow (synthetic test path)
    _with("folders", ["code"]),
    _with("drive", {"connected": True}),
    _with("question", "What is the deploy log?"),
    _without("daemon"),
    _without("daemon.started_at"),
    _without("claude.signed_in"),
    _without("folder_count"),
    _without("self_test.reason"),
    _with("seen_at", "2026-09-23T12:00:00Z"),
]


@pytest.mark.parametrize("body", [*INVALID, [], None, "status"])
async def test_an_invalid_status_is_400(api: Api, body: Any):
    r = await put_status(api, "bob", body)
    assert r.status_code == 400 and r.json()["error"] in ("invalid_body", "invalid_json"), r.text
    assert await api.store.get_member_statuses(api.team, ["bob"]) == {}


async def test_a_refusal_never_echoes_the_input(api: Api):
    marker = "secret-" + uuid.uuid4().hex
    for body in (_with("daemon.version", marker), _with(marker, 1), _with("self_test.at", marker)):
        r = await put_status(api, "bob", body)
        assert r.status_code == 400 and marker not in r.text


async def test_only_active_members_are_listed(api: Api):
    email = new_email()
    r = await api.client.post(
        api.url("/roster"), headers=auth("alice"), json={"member": "erin", "email": email}
    )
    assert r.status_code == 201, r.text
    assert [m["member"] for m in (await members_status(api))["members"]] == [
        "alice",
        "bob",
        "carol",
    ]
    sub = "sub-erin-" + uuid.uuid4().hex
    await accept_invitation(api.client, api.team, email, sub=sub)
    erin = {"Authorization": f"Bearer {id_token(email, sub)}"}
    r = await api.client.put(api.url("/me/status"), headers=erin, json=STATUS)
    assert r.status_code == 200, r.text
    listed = (await members_status(api))["members"]
    assert [m["member"] for m in listed] == ["alice", "bob", "carol", "erin"]
    assert listed[3]["answering"] is True


async def test_the_status_reads_are_rate_limited(kind_clock: tuple[str, FakeClock]):
    kind, clock = kind_clock
    async with open_api(kind, clock, reads_per_minute=2) as api:
        for _ in range(2):
            assert (await api.get("bob", "/members/status")).status_code == 200
        r = await api.get("bob", "/members/status")
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        assert (await api.get("carol", "/members/status")).status_code == 200
        for _ in range(2):
            assert (await api.get("bob", "/me/acceptance")).status_code == 200
        r = await api.get("bob", "/me/acceptance")
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")


async def test_a_read_only_delegate_reads_the_team_status(api: Api):
    assert (await put_status(api, "bob", STATUS)).status_code == 200
    r = await api.delegated("GET", "/members/status", EMAILS["carol"])
    assert r.status_code == 200 and r.json()["members"][1]["answering"] is True
    r = await api.delegated("PUT", "/me/status", EMAILS["carol"], json=STATUS)
    assert r.status_code == 403


async def test_outsiders_get_404_or_401(api: Api):
    assert (await put_status(api, "dave", STATUS)).status_code == 404
    assert (await api.get("dave", "/members/status")).status_code == 404
    assert (await api.client.get(api.url("/members/status"))).status_code == 401
    assert (await api.client.put(api.url("/me/status"), json=STATUS)).status_code == 401


# Leaving, over HTTP ----------------------------------------------------------------------------


async def test_a_member_removed_from_the_roster_leaves_no_acceptance_or_status(api: Api):
    await set_team_boundaries(api, 1)
    email = new_email()
    r = await api.client.post(
        api.url("/roster"), headers=auth("alice"), json={"member": "erin", "email": email}
    )
    assert r.status_code == 201, r.text
    sub = "sub-erin-" + uuid.uuid4().hex
    await accept_invitation(api.client, api.team, email, sub=sub)
    erin = {"Authorization": f"Bearer {id_token(email, sub)}"}
    r = await api.client.put(api.url("/me/acceptance"), headers=erin, json={"version": 1})
    assert r.status_code == 200, r.text
    r = await api.client.put(api.url("/me/status"), headers=erin, json=STATUS)
    assert r.status_code == 200, r.text
    assert set(await api.store.get_acceptances(api.team, ["erin"])) == {"erin"}
    assert set(await api.store.get_member_statuses(api.team, ["erin"])) == {"erin"}
    r = await api.client.delete(api.url("/roster/erin"), headers=auth("alice"))
    assert r.status_code == 200, r.text
    assert await api.store.get_acceptances(api.team, ["erin"]) == {}
    assert await api.store.get_member_statuses(api.team, ["erin"]) == {}
    assert [m["member"] for m in (await members_status(api))["members"]] == [
        "alice",
        "bob",
        "carol",
    ]


async def test_deleting_a_created_team_removes_acceptances_and_statuses(api: Api):
    owner, team = new_email(), new_id()
    sub = "sub-" + uuid.uuid4().hex
    headers = {"Authorization": f"Bearer {id_token(owner, sub)}"}
    r = await api.client.post(
        "/v1/teams", headers=headers, json={"id": team, "name": "Joined", "owner_member_id": "olga"}
    )
    assert r.status_code == 201, r.text
    base = f"/v1/teams/{team}"
    r = await api.client.put(
        base + "/boundaries", headers=headers, json={"version": 0, "boundaries": EXAMPLE}
    )
    assert r.status_code == 200, r.text
    r = await api.client.put(base + "/me/acceptance", headers=headers, json={"version": 1})
    assert r.status_code == 200, r.text
    r = await api.client.put(base + "/me/status", headers=headers, json=STATUS)
    assert r.status_code == 200, r.text
    r = await api.client.request("DELETE", base, headers=headers, json={"confirm": team})
    assert r.status_code == 200 and r.json()["removal"] == "complete", r.text
    assert await api.store.get_acceptances(team, ["olga"]) == {}
    assert await api.store.get_member_statuses(team, ["olga"]) == {}
