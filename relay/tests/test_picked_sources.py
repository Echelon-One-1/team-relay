"""PICKERS-SPEC §2-§3: owner-picked sources on the relay, on both stores.

- The shared vectors' new sections: what the relay stores of a valid body (``normalised``),
  the legacy-drive rule (``legacy_drives``), item keys (``keys``, ``item_keys``), ``since``
  rules 1-4 from a document the M10 code stored (``since``, also over HTTP), and the status
  group (``sources``: ``valid``, ``invalid``, ``kept``).
- ACC-001 an owner saves repositories and folders; ACC-003 legacy drives are kept, never added;
  ACC-004 a document the M10 code stored reads unchanged and is acted on; ACC-005 since;
  ACC-006 the relay's allowlists (RELAY_GITHUB_ORGS, RELAY_ALLOWED_SHARED_DRIVES); ACC-009
  the status' ``sources``: optional, narrowed to the team's own items on write and read, every
  member's to an owner and only their own to anyone else.

The Firestore half needs the emulator (scripts/test-relay.sh)."""

from __future__ import annotations

import copy
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

import httpx
import pytest

from relay.app import DELEGATE_ROUTES, create_app
from relay.boundaries import (
    Boundaries,
    carried_since,
    drive_key,
    folder_key,
    item_keys,
    known_item_keys,
    legacy_drives_ok,
    org_key,
    parse_set_body,
    repo_key,
)
from relay.errors import ApiError
from relay.member_state import parse_status_body
from relay.store import (
    BoundariesChange,
    DriveBoundary,
    FolderBoundary,
    RepoBoundary,
    TeamBoundaries,
)

from .conftest import EMAILS, PUBLIC_URL, START, Api, DelegateVerifier, auth, no_cookie_jar
from .fake_google import FakeGoogleProvider
from .test_boundaries import VECTORS

pytestmark = pytest.mark.anyio

NOW = START
DRIVE_ID = "0AExampleDriveId0PVA"
OTHER_DRIVE_ID = "0AOtherDriveId00PVA0"
CLIENTS_ID = "1ExampleFolderClients0000000000a"
LEGACY = {"domain": "example.com", "shared_drive": "Old Name-Matched Drive"}
STATUS: dict[str, Any] = {
    "daemon": {"version": "0.12.0", "started_at": "2026-09-23T11:59:00.000Z"},
    "claude": {"found": True, "signed_in": True},
    "folders": {"repo_roots": 2, "clones": 37, "extra_folders": 0},
    "drive": {"connected": True},
    "self_test": {"ok": True, "at": "2026-09-23T11:59:30.000Z", "reason": None},
}


def folder(folder_id: str, name: str = "Clients", drive_id: str | None = DRIVE_ID, **kw: Any):
    return {
        "domain": kw.pop("domain", "example.com"),
        "drive_id": drive_id,
        "folder_id": folder_id,
        "folder_name": name,
        "drive_name": kw.pop("drive_name", "Example Team Drive"),
    }


def picked(**changes: Any) -> dict[str, Any]:
    return {
        "topic": "Example Org: our clients, products and engineering.",
        "github_orgs": [],
        "github_repos": [{"org": "example-org", "repo": "api", "id": 123456}],
        "drive_folders": [folder(DRIVE_ID, "Example Team Drive"), folder(CLIENTS_ID)],
        "drives": [],
        "member_folders": False,
        **changes,
    }


def stored_doc(raw: dict[str, Any], version: int, since: dict[str, Any] | None) -> TeamBoundaries:
    """A document as a store holds it, from a vector's ``boundaries`` and ``since`` (the M10
    shape included: no picked lists)."""
    drives = [DriveBoundary(d["domain"], d["shared_drive"]) for d in raw["drives"]]
    repos = [RepoBoundary(r["org"], r["repo"], r["id"]) for r in raw.get("github_repos", [])]
    folders = [FolderBoundary(**f) for f in raw.get("drive_folders", [])]
    since = since or {}
    return TeamBoundaries(
        version=version,
        topic=raw["topic"],
        github_orgs=list(raw["github_orgs"]),
        drives=drives,
        member_folders=raw["member_folders"],
        updated_at=NOW,
        updated_by="alice",
        org_since=dict(since.get("github_orgs", {})),
        drive_since={
            DriveBoundary(d["domain"], d["shared_drive"]): d["since"]
            for d in since.get("drives", [])
        },
        member_folders_since=since.get("member_folders"),
        github_repos=repos,
        drive_folders=folders,
        repo_since=dict(since.get("github_repos", {})),
        folder_since=dict(since.get("drive_folders", {})),
    )


def since_json(doc: TeamBoundaries, since: Any) -> dict[str, Any]:
    """``carried_since``'s answer in the JSON shape of the vectors."""
    return {
        "github_orgs": since.orgs,
        "github_repos": since.repos,
        "drive_folders": since.folders,
        "drives": [
            {"domain": d.domain, "shared_drive": d.shared_drive, "since": since.drives[d]}
            for d in doc.drives
        ],
        "member_folders": since.member_folders,
    }


def writing(new: TeamBoundaries):
    def fn(current, actor) -> BoundariesChange[None]:
        return BoundariesChange(result=None, boundaries=new)

    return fn


async def put(client: httpx.AsyncClient, team: str, member: str, payload: Any) -> httpx.Response:
    return await client.put(f"/v1/teams/{team}/boundaries", headers=auth(member), json=payload)


async def version_of(api: Api) -> int:
    return (await api.get("bob", "/boundaries")).json()["version"]


# The shared vectors -------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["normalised"], ids=lambda c: c["why"])
def test_the_relay_stores_what_the_vectors_say(case: dict[str, Any]):
    _, parsed = parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    expect = case["expect"]
    assert parsed.topic == expect["topic"]
    assert parsed.github_orgs == expect["github_orgs"]
    assert [vars(r) for r in parsed.github_repos] == expect["github_repos"]
    assert [vars(f) for f in parsed.drive_folders] == expect["drive_folders"]
    assert [vars(d) for d in parsed.drives] == expect["drives"]
    assert parsed.member_folders is expect["member_folders"]


@pytest.mark.parametrize("case", VECTORS["legacy_drives"], ids=lambda c: c["why"])
def test_legacy_drives_are_kept_never_added(case: dict[str, Any]):
    stored = (
        None
        if case["stored"] is None
        else [DriveBoundary(d["domain"], d["shared_drive"]) for d in case["stored"]]
    )
    sent = [DriveBoundary(d["domain"], d["shared_drive"]) for d in case["sent"]]
    assert legacy_drives_ok(stored, sent) is case["ok"]


@pytest.mark.parametrize("case", VECTORS["keys"], ids=lambda c: c["key"])
def test_every_item_key(case: dict[str, Any]):
    item = case["item"]
    key = {
        "org": lambda: org_key(item["org"]),
        "repo": lambda: repo_key(RepoBoundary(**item)),
        "folder": lambda: folder_key(item["folder_id"]),
        "drive": lambda: drive_key(DriveBoundary(**item)),
    }[case["kind"]]()
    assert key == case["key"]
    assert len(key) <= 400


@pytest.mark.parametrize("case", VECTORS["item_keys"])
def test_the_keys_of_a_document_as_stored(case: dict[str, Any]):
    # Keys are of the document as the relay stores it (normalised).
    raw = case["boundaries"]
    _, parsed = parse_set_body({"version": 0, "boundaries": raw})
    doc = stored_doc(
        {
            "topic": parsed.topic,
            "github_orgs": parsed.github_orgs,
            "github_repos": [vars(r) for r in parsed.github_repos],
            "drive_folders": [vars(f) for f in parsed.drive_folders],
            "drives": [vars(d) for d in parsed.drives],
            "member_folders": parsed.member_folders,
        },
        1,
        None,
    )
    assert known_item_keys(doc, case["keys"]) == case["keys"]
    assert item_keys(doc) == case["keys"]


def test_since_rules_1_to_4_from_an_m10_document():
    """ACC-005 on the vectors: each step's since computed from the document it replaces."""
    start = VECTORS["since"]["start"]
    current = stored_doc(start["boundaries"], start["version"], start["since"])
    for version, step in enumerate(VECTORS["since"]["steps"], start=start["version"] + 1):
        _, body = parse_set_body({"version": version - 1, "boundaries": step["boundaries"]})
        since = carried_since(current, version, body)
        current = TeamBoundaries(
            version=version,
            topic=body.topic,
            github_orgs=body.github_orgs,
            drives=body.drives,
            member_folders=body.member_folders,
            updated_at=NOW,
            updated_by="alice",
            org_since=since.orgs,
            drive_since=since.drives,
            member_folders_since=since.member_folders,
            github_repos=body.github_repos,
            drive_folders=body.drive_folders,
            repo_since=since.repos,
            folder_since=since.folders,
        )
        assert since_json(current, since) == step["since"], step["why"]


@pytest.mark.parametrize("sources", VECTORS["sources"]["valid"])
def test_every_valid_sources_vector_is_accepted(sources: dict[str, Any]):
    status = parse_status_body({**STATUS, "sources": sources})
    assert status["sources"] == sources


@pytest.mark.parametrize("case", VECTORS["sources"]["invalid"], ids=lambda c: c["why"])
def test_every_invalid_sources_vector_is_400(case: dict[str, Any]):
    with pytest.raises(ApiError) as caught:
        parse_status_body({**STATUS, "sources": case["sources"]})
    assert (caught.value.status, caught.value.code) == (400, "invalid_body")
    assert (caught.value.detail or "").startswith("sources")


def test_null_sources_are_400_and_absent_ones_are_absent():
    with pytest.raises(ApiError) as caught:
        parse_status_body({**STATUS, "sources": None})
    assert caught.value.code == "invalid_body"
    assert "sources" not in parse_status_body(STATUS)


@pytest.mark.parametrize("case", VECTORS["sources"]["kept"], ids=lambda c: c["why"])
def test_only_keys_of_the_current_items_are_kept(case: dict[str, Any]):
    _, parsed = parse_set_body({"version": 0, "boundaries": case["boundaries"]})
    doc = stored_doc(
        {
            "topic": parsed.topic,
            "github_orgs": parsed.github_orgs,
            "github_repos": [vars(r) for r in parsed.github_repos],
            "drive_folders": [vars(f) for f in parsed.drive_folders],
            "drives": [vars(d) for d in parsed.drives],
            "member_folders": parsed.member_folders,
        },
        1,
        None,
    )
    assert known_item_keys(doc, case["missing"]) == case["kept"]
    assert known_item_keys(None, case["missing"]) == []


# ACC-001: an owner saves repositories and folders -------------------------------------------


async def test_an_owner_saves_picked_sources_and_members_read_them(api: Api):
    r = await put(api.client, api.team, "alice", {"version": 0, "boundaries": picked()})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 1
    assert body["boundaries"] == picked()
    assert body["since"] == {
        "github_orgs": {},
        "github_repos": {"example-org/api": 1},
        "drive_folders": {DRIVE_ID: 1, CLIENTS_ID: 1},
        "drives": [],
        "member_folders": None,
    }
    for member in ("bob", "carol"):
        assert (await api.get(member, "/boundaries")).json() == body
    # A non-owner's PUT is 403, before the body is looked at.
    r = await put(api.client, api.team, "bob", {"version": 1, "boundaries": picked()})
    assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    assert await version_of(api) == 1


async def test_what_is_stored_is_normalised(api: Api):
    sent = picked(
        github_orgs=["Example-Org"],
        github_repos=[
            {"org": "EXAMPLE-ORG", "repo": "api", "id": 1},
            {"org": "other-org", "repo": "Tools", "id": None},
            {"org": "Other-Org", "repo": "tools", "id": 5},
        ],
        drive_folders=[folder(CLIENTS_ID), folder(CLIENTS_ID, "Renamed")],
    )
    r = await put(api.client, api.team, "alice", {"version": 0, "boundaries": sent})
    assert r.status_code == 200, r.text
    b = r.json()["boundaries"]
    assert b["github_orgs"] == ["Example-Org"]
    assert b["github_repos"] == [{"org": "other-org", "repo": "Tools", "id": None}]
    assert b["drive_folders"] == [folder(CLIENTS_ID)]
    assert r.json()["since"]["github_repos"] == {"other-org/tools": 1}


async def test_an_m10_shaped_body_is_400_over_http(api: Api):
    m10 = {k: v for k, v in picked().items() if k not in ("github_repos", "drive_folders")}
    r = await put(api.client, api.team, "alice", {"version": 0, "boundaries": m10})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_body")
    assert r.json()["detail"].startswith("boundaries.github_repos")


# ACC-003: legacy drives ---------------------------------------------------------------------


async def test_a_legacy_drive_cannot_be_added(api: Api):
    r = await put(
        api.client, api.team, "alice", {"version": 0, "boundaries": picked(drives=[LEGACY])}
    )
    assert (r.status_code, r.json()["error"]) == (400, "legacy_drive")
    assert r.json()["detail"] == (
        "boundaries.drives.0: Pick shared-drive folders instead of typing drive names."
    )
    assert LEGACY["shared_drive"] not in r.text
    assert await version_of(api) == 0
    # Refused (and audited as refused), never stored.
    refused = [e for e in await api.store.list_audit(api.team) if e.action == "boundaries_set"]
    assert [(e.outcome, e.detail) for e in refused] == [("refused", "400 legacy_drive")]


async def test_a_stored_legacy_drive_is_kept_with_its_since_and_can_be_removed(api: Api):
    m10 = {
        "topic": "T",
        "github_orgs": ["example-org"],
        "drives": [LEGACY],
        "member_folders": False,
    }
    since = {"github_orgs": {"example-org": 1}, "drives": [{**LEGACY, "since": 1}]}
    await api.store.set_boundaries(api.team, "alice", writing(stored_doc(m10, 1, since)))
    # Kept (another spelling of its name is a new one, refused).
    renamed = {**LEGACY, "shared_drive": "old name-matched drive"}
    r = await put(
        api.client, api.team, "alice", {"version": 1, "boundaries": picked(drives=[renamed])}
    )
    assert (r.status_code, r.json()["error"]) == (400, "legacy_drive")
    r = await put(
        api.client, api.team, "alice", {"version": 1, "boundaries": picked(drives=[LEGACY])}
    )
    assert r.status_code == 200, r.text
    assert r.json()["since"]["drives"] == [{**LEGACY, "since": 1}]
    r = await put(
        api.client, api.team, "alice", {"version": 2, "boundaries": picked(drives=[LEGACY])}
    )
    assert r.json()["since"]["drives"] == [{**LEGACY, "since": 1}]
    # Removed: gone, and it cannot come back.
    r = await put(api.client, api.team, "alice", {"version": 3, "boundaries": picked()})
    assert r.status_code == 200 and r.json()["boundaries"]["drives"] == []
    r = await put(
        api.client, api.team, "alice", {"version": 4, "boundaries": picked(drives=[LEGACY])}
    )
    assert (r.status_code, r.json()["error"]) == (400, "legacy_drive")


async def test_the_version_is_checked_before_legacy_drives(api: Api):
    r = await put(
        api.client, api.team, "alice", {"version": 3, "boundaries": picked(drives=[LEGACY])}
    )
    assert (r.status_code, r.json()["error"]) == (409, "version_conflict")


# ACC-004, ACC-005: from a document the M10 code stored -------------------------------------


async def test_an_m10_document_is_read_and_replaced_as_the_vectors_say(api: Api):
    start = VECTORS["since"]["start"]
    doc = stored_doc(start["boundaries"], start["version"], start["since"])
    await api.store.set_boundaries(api.team, "alice", writing(doc))
    r = await api.get("bob", "/boundaries")
    assert r.status_code == 200
    assert r.json()["version"] == 1
    assert r.json()["boundaries"] == {
        **start["boundaries"],
        "github_repos": [],
        "drive_folders": [],
    }
    assert r.json()["since"] == {**start["since"], "github_repos": {}, "drive_folders": {}}
    for version, step in enumerate(VECTORS["since"]["steps"], start=2):
        payload = {"version": version - 1, "boundaries": step["boundaries"]}
        r = await put(api.client, api.team, "alice", payload)
        assert r.status_code == 200, (step["why"], r.text)
        assert r.json()["version"] == version
        assert r.json()["since"] == step["since"], step["why"]
        assert (await api.get("carol", "/boundaries")).json()["since"] == step["since"]


async def test_an_acceptance_of_an_m10_version_still_stands(api: Api):
    start = VECTORS["since"]["start"]
    await api.store.set_boundaries(
        api.team, "alice", writing(stored_doc(start["boundaries"], 1, start["since"]))
    )
    r = await api.client.put(api.url("/me/acceptance"), headers=auth("bob"), json={"version": 1})
    assert r.status_code == 200, r.text
    # Narrowing the org to two of its repositories keeps the org's since (rule 2): bob's
    # acceptance of version 1 still covers every item of version 2.
    step = VECTORS["since"]["steps"][0]
    r = await put(api.client, api.team, "alice", {"version": 1, "boundaries": step["boundaries"]})
    since = r.json()["since"]
    assert max([*since["github_repos"].values(), *(d["since"] for d in since["drives"])]) <= 1


# ACC-006: the relay's allowlists ------------------------------------------------------------


@asynccontextmanager
async def relay_with(
    api: Api,
    *,
    orgs: frozenset[str] = frozenset(),
    drives: frozenset[str] = frozenset(),
    domains: frozenset[str] | None = None,
) -> AsyncIterator[httpx.AsyncClient]:
    """Another relay instance over ``api``'s store with RELAY_GITHUB_ORGS ``orgs``,
    RELAY_ALLOWED_SHARED_DRIVES ``drives`` (and RELAY_ALLOWED_DOMAINS ``domains``)."""
    assert api.settings is not None and api.fake is not None
    config = replace(
        api.settings.team_config,
        allowed_github_orgs=orgs,
        allowed_shared_drives=drives,
        **({"allowed_domains": domains} if domains is not None else {}),
    )
    app = create_app(
        replace(api.settings, team_config=config),
        api.store,
        clock=api.clock,
        poll_interval=0.02,
        verifier=DelegateVerifier(),
        oauth=FakeGoogleProvider(api.fake),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=PUBLIC_URL, cookies=no_cookie_jar()
    ) as c:
        yield c


def test_the_allowlists_refuse_other_orgs_and_drives():
    orgs, drives = frozenset({"example-org"}), frozenset({DRIVE_ID})
    ok = picked(github_orgs=["Example-ORG"], github_repos=[], drive_folders=[folder(CLIENTS_ID)])
    assert parse_set_body({"version": 0, "boundaries": ok}, frozenset(), orgs, drives)
    for bad, code, where in (
        (picked(github_orgs=["other-org"]), "org_not_allowed", "boundaries.github_orgs.0"),
        (
            picked(github_repos=[{"org": "other-org", "repo": "api", "id": 1}]),
            "org_not_allowed",
            "boundaries.github_repos.0.org",
        ),
        (
            picked(drive_folders=[folder(CLIENTS_ID, drive_id=OTHER_DRIVE_ID)]),
            "drive_not_allowed",
            "boundaries.drive_folders.0.drive_id",
        ),
        (
            # A pasted folder that is not one of the drives themselves.
            picked(drive_folders=[folder(CLIENTS_ID, drive_id=None)]),
            "drive_not_allowed",
            "boundaries.drive_folders.0.drive_id",
        ),
    ):
        with pytest.raises(ApiError) as caught:
            parse_set_body({"version": 0, "boundaries": bad}, frozenset(), orgs, drives)
        assert (caught.value.status, caught.value.code) == (400, code)
        assert (caught.value.detail or "").startswith(where + ":")
        assert "other-org" not in str(caught.value.body())
        assert OTHER_DRIVE_ID not in str(caught.value.body())


def test_a_pasted_whole_drive_in_the_allowlist_gets_its_drive_id():
    pasted = folder(DRIVE_ID, "Example Team Drive", drive_id=None, drive_name=None)
    _, parsed = parse_set_body(
        {"version": 0, "boundaries": picked(drive_folders=[pasted])},
        frozenset(),
        frozenset(),
        frozenset({DRIVE_ID}),
    )
    assert parsed.drive_folders == [
        FolderBoundary("example.com", DRIVE_ID, DRIVE_ID, "Example Team Drive", None)
    ]
    # Without the allowlist a pasted link stays unchecked (no drive id).
    _, parsed = parse_set_body({"version": 0, "boundaries": picked(drive_folders=[pasted])})
    assert parsed.drive_folders[0].drive_id is None


def test_a_folder_domain_must_be_an_allowed_domain():
    other = picked(drive_folders=[folder(CLIENTS_ID, domain="example.org")])
    with pytest.raises(ApiError) as caught:
        parse_set_body({"version": 0, "boundaries": other}, frozenset({"example.com"}))
    assert caught.value.code == "domain_not_allowed"
    assert (caught.value.detail or "").startswith("boundaries.drive_folders.0.domain:")


async def test_the_allowlists_hold_over_http(api: Api):
    async with relay_with(api, orgs=frozenset({"example-org"}), drives=frozenset({DRIVE_ID})) as c:
        r = await put(c, api.team, "alice", {"version": 0, "boundaries": picked(github_orgs=["x"])})
        assert (r.status_code, r.json()["error"]) == (400, "org_not_allowed")
        bad = picked(drive_folders=[folder(CLIENTS_ID, drive_id=OTHER_DRIVE_ID)])
        r = await put(c, api.team, "alice", {"version": 0, "boundaries": bad})
        assert (r.status_code, r.json()["error"]) == (400, "drive_not_allowed")
        pasted = folder(DRIVE_ID, "Example Team Drive", drive_id=None, drive_name=None)
        r = await put(
            c, api.team, "alice", {"version": 0, "boundaries": picked(drive_folders=[pasted])}
        )
        assert r.status_code == 200, r.text
        assert r.json()["boundaries"]["drive_folders"][0]["drive_id"] == DRIVE_ID


async def test_stored_entries_outside_the_allowlists_are_never_handed_out(api: Api):
    """Saved before the allowlists were set: GET (and the status filter) leave them out."""
    saved = picked(
        github_orgs=["example-org", "other-org"],
        github_repos=[
            {"org": "example-labs", "repo": "api", "id": 1},
            {"org": "Example-Labs", "repo": "web", "id": 2},
        ],
        drive_folders=[
            folder(CLIENTS_ID),
            folder("1OtherDriveFolder00000000000000e", "Other", drive_id=OTHER_DRIVE_ID),
            folder(OTHER_DRIVE_ID, "Pasted whole drive", drive_id=None, drive_name=None),
            folder(DRIVE_ID, "Pasted allowed drive", drive_id=None, drive_name=None),
            folder("1ExampleOrgFolder000000000000zz", "Org", domain="example.org"),
        ],
    )
    r = await put(api.client, api.team, "alice", {"version": 0, "boundaries": saved})
    assert r.status_code == 200, r.text
    orgs = frozenset({"example-org", "example-labs"})
    async with relay_with(
        api, orgs=frozenset({"example-org"}), drives=frozenset({DRIVE_ID}), domains=frozenset()
    ) as c:
        r = await c.get(api.url("/boundaries"), headers=auth("bob"))
        b, since = r.json()["boundaries"], r.json()["since"]
        assert b["github_orgs"] == ["example-org"]
        assert b["github_repos"] == []
        assert [f["folder_id"] for f in b["drive_folders"]] == [
            CLIENTS_ID,
            DRIVE_ID,
            "1ExampleOrgFolder000000000000zz",
        ]
        assert set(since["github_orgs"]) == {"example-org"}
        assert since["github_repos"] == {}
        assert set(since["drive_folders"]) == {
            CLIENTS_ID,
            DRIVE_ID,
            "1ExampleOrgFolder000000000000zz",
        }
        assert "other-org" not in r.text and OTHER_DRIVE_ID not in r.text
    async with relay_with(api, orgs=orgs, domains=frozenset({"example.com"})) as c:
        r = await c.get(api.url("/boundaries"), headers=auth("bob"))
        b = r.json()["boundaries"]
        assert [x["repo"] for x in b["github_repos"]] == ["api", "web"]
        assert "1ExampleOrgFolder000000000000zz" not in r.text
    # The store keeps what was saved.
    stored = await api.store.get_boundaries(api.team)
    assert stored is not None and len(stored.drive_folders) == 5


# ACC-009: the status' sources ---------------------------------------------------------------


async def put_status(client: httpx.AsyncClient, team: str, member: str, body: Any):
    return await client.put(f"/v1/teams/{team}/me/status", headers=auth(member), json=body)


async def members_status(client: httpx.AsyncClient, team: str, member: str) -> dict[str, Any]:
    r = await client.get(f"/v1/teams/{team}/members/status", headers=auth(member))
    assert r.status_code == 200, r.text
    return {m["member"]: m for m in r.json()["members"]}


async def test_sources_are_optional_and_narrowed_to_the_teams_items(api: Api):
    r = await put(api.client, api.team, "alice", {"version": 0, "boundaries": picked()})
    assert r.status_code == 200
    # An older plugin: no sources, stored and answered as none.
    assert (await put_status(api.client, api.team, "bob", STATUS)).status_code == 200
    assert (await members_status(api.client, api.team, "alice"))["bob"]["sources"] is None
    api.clock.advance(20)
    reported = {
        "boundaries_version": 1,
        "missing": [
            "repo:example-org/api",
            "/Users/someone/projects/secret",  # e1-guard: allow (synthetic test path)
            f"folder:{CLIENTS_ID}",
            "repo:example-org/web",
            "repo:example-org/api",
            "org:example-org",
        ],
    }
    r = await put_status(api.client, api.team, "bob", {**STATUS, "sources": reported})
    assert r.status_code == 200, r.text
    kept = {"boundaries_version": 1, "missing": ["repo:example-org/api", f"folder:{CLIENTS_ID}"]}
    assert r.json()["sources"] == kept
    stored = (await api.store.get_member_statuses(api.team, ["bob"]))["bob"]
    assert stored.status["sources"] == kept
    assert "secret" not in json.dumps(stored.status)
    listed = await members_status(api.client, api.team, "alice")
    assert listed["bob"]["sources"] == kept
    assert "sources" not in listed["bob"]["status"]


async def test_sources_are_filtered_again_on_read(api: Api):
    await put(api.client, api.team, "alice", {"version": 0, "boundaries": picked()})
    body = {**STATUS, "sources": {"boundaries_version": 1, "missing": [f"folder:{CLIENTS_ID}"]}}
    assert (await put_status(api.client, api.team, "bob", body)).status_code == 200
    # The owner removes the folder: it disappears from what anyone is shown.
    shorter = picked(drive_folders=[folder(DRIVE_ID, "Example Team Drive")])
    r = await put(api.client, api.team, "alice", {"version": 1, "boundaries": shorter})
    assert r.status_code == 200
    listed = await members_status(api.client, api.team, "alice")
    assert listed["bob"]["sources"] == {"boundaries_version": 1, "missing": []}


async def test_without_boundaries_no_key_is_kept(api: Api):
    body = {**STATUS, "sources": {"boundaries_version": 0, "missing": ["org:example-org"]}}
    r = await put_status(api.client, api.team, "bob", body)
    assert r.status_code == 200
    assert r.json()["sources"] == {"boundaries_version": 0, "missing": []}


async def test_owners_see_everyones_sources_and_others_only_their_own(api: Api):
    await put(api.client, api.team, "alice", {"version": 0, "boundaries": picked()})
    for member, key in (("bob", "repo:example-org/api"), ("carol", f"folder:{DRIVE_ID}")):
        body = {**STATUS, "sources": {"boundaries_version": 1, "missing": [key]}}
        assert (await put_status(api.client, api.team, member, body)).status_code == 200
    owner = await members_status(api.client, api.team, "alice")
    assert owner["bob"]["sources"]["missing"] == ["repo:example-org/api"]
    assert owner["carol"]["sources"]["missing"] == [f"folder:{DRIVE_ID}"]
    bob = await members_status(api.client, api.team, "bob")
    assert bob["bob"]["sources"]["missing"] == ["repo:example-org/api"]
    assert bob["carol"]["sources"] is None and bob["alice"]["sources"] is None
    # The rest of a member's entry is unchanged for everyone.
    assert bob["carol"]["status"] == owner["carol"]["status"]
    # Through the console: the delegate on behalf of an owner sees every member's, on behalf
    # of a member only that member's.
    assert "/v1/teams/{team}/members/status" in DELEGATE_ROUTES
    r = await api.delegated("GET", "/members/status", EMAILS["alice"])
    by = {m["member"]: m for m in r.json()["members"]}
    assert by["carol"]["sources"]["missing"] == [f"folder:{DRIVE_ID}"]
    r = await api.delegated("GET", "/members/status", EMAILS["carol"])
    by = {m["member"]: m for m in r.json()["members"]}
    assert by["bob"]["sources"] is None and by["carol"]["sources"] is not None


async def test_the_status_limits_hold_over_http(api: Api):
    many = ["org:example-org"] * 140
    body = {**STATUS, "sources": {"boundaries_version": 2**31 - 1, "missing": many}}
    assert (await put_status(api.client, api.team, "bob", body)).status_code == 200
    api.clock.advance(20)
    for case in VECTORS["sources"]["invalid"]:
        r = await api.client.put(
            api.url("/me/status"),
            headers={**auth("bob"), "Content-Type": "application/json"},
            content=json.dumps({**STATUS, "sources": case["sources"]}),
        )
        assert (r.status_code, r.json()["error"]) == (400, "invalid_body"), case["why"]
    r = await put_status(api.client, api.team, "bob", {**STATUS, "sources": None})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_body")


async def test_a_refused_key_is_never_echoed(api: Api):
    marker = "/Users/someone/" + "x" * 390  # e1-guard: allow (synthetic macOS home path in a test)
    body = {**STATUS, "sources": {"boundaries_version": 1, "missing": [marker + "\n"]}}
    r = await put_status(api.client, api.team, "bob", body)
    assert r.status_code == 400 and marker not in r.text


def test_status_copies_are_independent():
    status = parse_status_body(
        {**STATUS, "sources": {"boundaries_version": 1, "missing": ["org:a"]}}
    )
    clone = copy.deepcopy(status)
    clone["sources"]["missing"].append("org:b")
    assert status["sources"]["missing"] == ["org:a"]


def test_the_since_carried_ignores_legacy_drives_for_rules_2_and_3():
    """Rule 3 never applies to a legacy drive: a folder picked after one of the same name is
    new (decision Q3)."""
    current = stored_doc(
        {"topic": "T", "github_orgs": [], "drives": [LEGACY], "member_folders": False},
        1,
        {"drives": [{**LEGACY, "since": 1}]},
    )
    body = Boundaries(
        topic="T",
        github_orgs=[],
        drives=[],
        member_folders=False,
        github_repos=[],
        drive_folders=[
            FolderBoundary("example.com", DRIVE_ID, DRIVE_ID, LEGACY["shared_drive"], None)
        ],
    )
    assert carried_since(current, 2, body).folders == {DRIVE_ID: 2}


async def test_a_status_written_before_a_boundaries_change_is_read_against_the_new_one(api: Api):
    await put(api.client, api.team, "alice", {"version": 0, "boundaries": picked()})
    body = {**STATUS, "sources": {"boundaries_version": 1, "missing": ["repo:example-org/api"]}}
    assert (await put_status(api.client, api.team, "bob", body)).status_code == 200
    whole = picked(github_orgs=["example-org"], github_repos=[])
    await put(api.client, api.team, "alice", {"version": 1, "boundaries": whole})
    listed = await members_status(api.client, api.team, "alice")
    # The repository is no longer an item (the whole org is): its key is dropped.
    assert listed["bob"]["sources"]["missing"] == []


async def test_the_largest_valid_body_fully_escaped_fits_the_relays_cap(api: Api):
    """The console server admits PUT bodies up to 160 KiB; the relay's own cap (256 KiB) must
    admit the largest valid body even with every non-ASCII character escaped."""
    wide = "\U0001f600"  # twelve bytes once escaped as a surrogate pair
    orgs = [f"o{i}" + "x" * 37 for i in range(10)]
    body = {
        "version": await version_of(api),
        "boundaries": {
            "topic": wide * 500,
            "github_orgs": orgs,
            "github_repos": [
                {"org": f"r{i % 10}" + "y" * 37, "repo": f"{i:03d}" + "z" * 97, "id": 2**53 - 1 - i}
                for i in range(100)
            ],
            "drive_folders": [
                {
                    "domain": "example.com",
                    "drive_id": f"{i:02d}" + "D" * 198,
                    "folder_id": f"{i:02d}" + "F" * 198,
                    "folder_name": wide * 255,
                    "drive_name": wide * 100,
                }
                for i in range(20)
            ],
            "drives": [],
            "member_folders": True,
        },
    }
    text = json.dumps(body, ensure_ascii=True)
    assert 100 * 1024 < len(text) < 256 * 1024
    r = await api.client.put(
        api.url("/boundaries"),
        headers={**auth("alice"), "Content-Type": "application/json"},
        content=text,
    )
    assert r.status_code == 200, r.text
    got = (await api.get("bob", "/boundaries")).json()["boundaries"]
    assert (len(got["github_repos"]), len(got["drive_folders"])) == (100, 20)
