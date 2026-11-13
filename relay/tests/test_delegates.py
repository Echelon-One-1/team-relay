"""Read-only delegates (M3-SPEC §2): the team file's ``delegates:``, X-Relay-On-Behalf-Of,
the four reads a delegate may make as the member it names, and everything it may not."""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from fastapi.routing import APIRoute

from relay.app import DELEGATE_ROUTES, ON_BEHALF_HEADER
from relay.config import Delegate, load_team_config, normalise_email, parse_team_config
from relay.errors import ConfigError

from .conftest import (
    DELEGATE_TOKENS,
    DELEGATES,
    EMAILS,
    EXAMPLE_CONFIG,
    MANIFEST,
    TOKENS,
    Api,
    FakeClock,
    auth,
    open_api,
    team_config_data,
    with_delegates,
)

pytestmark = pytest.mark.anyio

CONSOLE = "google:console@example-project.iam.gserviceaccount.com"


def _config(delegates: list[dict[str, Any]]) -> dict[str, Any]:
    data = team_config_data()
    data["delegates"] = delegates
    return data


def _logs(out: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in out.splitlines() if line.strip()]


# The team file -----------------------------------------------------------------------------


def test_a_team_file_without_delegates_has_none():
    config = parse_team_config(team_config_data())
    assert config.delegates == {}
    assert config.delegate(DELEGATES["demo"]) is None


def test_the_example_team_config_still_loads():
    config = load_team_config(EXAMPLE_CONFIG)
    assert [s.id for s in config.teams["demo"].seeds] == ["alice", "bob", "carol"]


def test_a_delegate_is_parsed_and_lowercased():
    data = _config(
        [{"principal": "google:Console@Example-Project.IAM.gserviceaccount.com", "team": "demo",
          "scope": "read"}]
    )  # fmt: skip
    config = parse_team_config(data)
    expected = Delegate(principal=CONSOLE, team="demo", scopes=frozenset({"read"}))
    assert config.delegates == {CONSOLE: expected}
    assert config.delegate(CONSOLE) == expected
    assert not expected.manages_roster
    # A delegate is never a member: no seed holds its email.
    assert all(
        "console@example-project.iam.gserviceaccount.com" not in seed.emails
        for team in config.teams.values()
        for seed in team.seeds
    )


def test_delegates_for_two_teams():
    config = parse_team_config(with_delegates(team_config_data()))
    assert {p: d.team for p, d in config.delegates.items()} == {
        DELEGATES["demo"]: "demo",
        DELEGATES["other"]: "other",
    }


@pytest.mark.parametrize(
    "delegates, message",
    [
        # principal must be google:<email>
        ([{"principal": "token:sha256:" + "a" * 64, "team": "demo", "scope": "read"}],
         "principal must be 'google:<email>'"),
        ([{"principal": "console@example.com", "team": "demo", "scope": "read"}],
         "principal must be 'google:<email>'"),
        ([{"principal": "google:console", "team": "demo", "scope": "read"}],
         "principal must be 'google:<email>'"),
        ([{"principal": "google:", "team": "demo", "scope": "read"}],
         "principal must be 'google:<email>'"),
        # the team must exist
        ([{"principal": CONSOLE, "team": "nosuchteam", "scope": "read"}], "is not a team"),
        # scope has one value
        ([{"principal": CONSOLE, "team": "demo", "scope": "write"}], "delegates.0.scope"),
        ([{"principal": CONSOLE, "team": "demo", "scope": "READ"}], "delegates.0.scope"),
        ([{"principal": CONSOLE, "team": "demo", "scope": ["write"]}], "delegates.0.scope"),
        # M6-SPEC §3: a list must hold read, once each
        ([{"principal": CONSOLE, "team": "demo", "scope": []}], "must include 'read'"),
        ([{"principal": CONSOLE, "team": "demo", "scope": ["manage-roster"]}],
         "must include 'read'"),
        ([{"principal": CONSOLE, "team": "demo", "scope": ["read", "read"]}], "listed twice"),
        ([{"principal": CONSOLE, "team": "demo", "scope": "manage-roster"}],
         "delegates.0.scope"),
        ([{"principal": CONSOLE, "team": "demo"}], "delegates.0.scope"),
        ([{"principal": CONSOLE, "scope": "read"}], "delegates.0.team"),
        ([{"team": "demo", "scope": "read"}], "delegates.0.principal"),
        ([{"principal": CONSOLE, "team": "demo", "scope": "read", "member": "alice"}],
         "delegates.0.member"),
        # not a member principal, in any case
        ([{"principal": "google:alice@example.com", "team": "demo", "scope": "read"}],
         "also a member's"),
        ([{"principal": "google:DAVE@Example.com", "team": "demo", "scope": "read"}],
         "also a member's"),
        # duplicates, in any case and across teams
        ([{"principal": CONSOLE, "team": "demo", "scope": "read"},
          {"principal": CONSOLE, "team": "demo", "scope": "read"}], "listed twice"),
        ([{"principal": CONSOLE, "team": "demo", "scope": "read"},
          {"principal": CONSOLE.upper().replace("GOOGLE:", "google:"), "team": "other",
           "scope": "read"}], "listed twice"),
        # the list itself
        ({"principal": CONSOLE, "team": "demo", "scope": "read"}, "delegates"),
        ([{"principal": f"google:c{i}@example.com", "team": "demo", "scope": "read"}
          for i in range(11)], "delegates"),
    ],
)  # fmt: skip
def test_bad_delegates_are_a_startup_error(delegates: Any, message: str):
    with pytest.raises(ConfigError) as exc:
        parse_team_config(_config(delegates))
    assert message in str(exc.value)


def test_a_bad_delegate_error_does_not_echo_the_principal():
    for delegates in (
        [{"principal": "google:alice@example.com", "team": "demo", "scope": "read"}],
        [{"principal": CONSOLE, "team": "demo", "scope": "read"}] * 2,
    ):
        with pytest.raises(ConfigError) as exc:
            parse_team_config(_config(delegates))
        assert "alice@example.com" not in str(exc.value) and "console@" not in str(exc.value)


@pytest.mark.parametrize(
    "email, member",
    [
        ("alice@example.com", "alice"),
        ("ALICE@Example.COM", "alice"),
        ("carol@example.com", "carol"),
        # not a member of the delegate's team
        ("dave@example.com", None),
        ("mallory@example.com", None),
        # not an email, or not only one
        ("", None),
        ("alice", None),
        ("google:alice@example.com", None),
        ("alice@example.com ", None),
        (" alice@example.com", None),
        ("alice@example.com\n", None),
        ("alice@example.com,bob@example.com", None),
        ("alice@@example.com", None),
        ("a" * 320 + "@example.com", None),
    ],
)
async def test_resolve_on_behalf(api: Api, email: str, member: str | None):
    """The header resolves through the delegate's team roster (M6-SPEC §1)."""
    if member is None:
        assert normalise_email(email) is None or email.lower() not in {
            EMAILS[m] for m in ("alice", "bob", "carol")
        }
    if "\n" in email:
        return  # not a header value an HTTP client can send; refused as an email above
    r = await api.delegated("GET", "/me", email)
    if member is None:
        # Not an email: 401. A well-formed email that is on no roster: 403 not_a_member.
        expected = 401 if normalise_email(email) is None else 403
        assert r.status_code == expected, r.text
    else:
        assert r.status_code == 200, r.text
        assert (r.json()["team"], r.json()["member"]) == (api.team, member)


def test_a_delegate_scope_list_with_manage_roster():
    data = _config([{"principal": CONSOLE, "team": "demo", "scope": ["read", "manage-roster"]}])
    delegate = parse_team_config(data).delegate(CONSOLE)
    assert delegate is not None and delegate.manages_roster
    assert delegate.scopes == frozenset({"read", "manage-roster"})


async def test_a_delegate_resolves_only_its_own_team(api: Api):
    r = await api.delegated("GET", "/me", EMAILS["dave"], delegate="other")
    assert r.status_code == 404  # dave's team is "other", the URL's team is api.team
    r = await api.client.get("/v1/teams/other/me", headers={**_other_delegate(EMAILS["dave"])})
    assert r.status_code == 200 and r.json()["member"] == "dave"
    r = await api.client.get("/v1/teams/other/me", headers={**_other_delegate(EMAILS["alice"])})
    assert r.status_code == 403  # alice is not on team other's roster
    assert r.json()["error"] == "not_a_member"


def _other_delegate(email: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {DELEGATE_TOKENS['other']}", ON_BEHALF_HEADER: email}


# The four reads, as the member named -------------------------------------------------------


async def test_me_is_the_member_named(api: Api):
    for member in ("alice", "bob"):
        r = await api.delegated("GET", "/me", EMAILS[member])
        assert r.status_code == 200, r.text
        assert r.json() == (await api.get(member, "/me")).json()
        assert r.json()["member"] == member


async def test_directory_and_activity_are_the_members_own(api: Api):
    await api.publish("bob")
    rid = await api.ask("alice", to="*")
    await api.reply("bob", rid)
    for member in ("alice", "bob", "carol"):
        for path in ("/directory", "/activity"):
            mine = await api.get(member, path)
            theirs = await api.delegated("GET", path, EMAILS[member])
            assert theirs.status_code == 200, theirs.text
            assert theirs.json() == mine.json()


async def test_a_request_is_masked_as_for_the_member_named(api: Api):
    rid = await api.ask("alice", to="*")
    await api.reply("bob", rid, "Only alice and bob see this.")

    as_alice = await api.delegated("GET", f"/requests/{rid}", EMAILS["alice"])
    assert as_alice.status_code == 200
    assert set(as_alice.json()["recipients"]) == {"bob", "carol"}

    as_carol = await api.delegated("GET", f"/requests/{rid}", EMAILS["carol"])
    assert as_carol.status_code == 200
    assert set(as_carol.json()["recipients"]) == {"carol"}
    assert as_carol.json() == (await api.get("carol", f"/requests/{rid}")).json()

    entry = next(
        e
        for e in (await api.delegated("GET", "/activity", EMAILS["carol"])).json()["requests"]
        if e["request_id"] == rid
    )
    assert entry["recipients"]["bob"]["answer_preview"] is None
    assert entry["recipients"]["carol"]["answer_preview"] is None
    entry = next(
        e
        for e in (await api.delegated("GET", "/activity", EMAILS["bob"])).json()["requests"]
        if e["request_id"] == rid
    )
    assert entry["recipients"]["bob"]["answer_preview"] == "Only alice and bob see this."


async def test_a_non_participant_is_a_non_participant_through_the_delegate(api: Api):
    rid = await api.ask("alice", to=["bob"], question="Only for bob.")
    r = await api.delegated("GET", f"/requests/{rid}", EMAILS["carol"])
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await api.delegated("GET", f"/requests/{rid}", EMAILS["bob"])
    assert r.status_code == 200 and r.json()["question"] == "Only for bob."
    entry = next(
        e
        for e in (await api.delegated("GET", "/activity", EMAILS["carol"])).json()["requests"]
        if e["request_id"] == rid
    )
    assert entry["participant"] is False and entry["question"] is None


@pytest.fixture(params=["memory", "firestore"])
async def budget_api(request: pytest.FixtureRequest, clock: FakeClock):
    async with open_api(request.param, clock, reads_per_minute=3) as opened:
        yield opened


async def test_the_read_budget_is_the_member_named(budget_api: Api, capsys):
    api = budget_api
    # Three reads as alice, through the delegate and directly: her budget is spent.
    assert (await api.delegated("GET", "/directory", EMAILS["alice"])).status_code == 200
    assert (await api.delegated("GET", "/activity", EMAILS["alice"])).status_code == 200
    assert (await api.get("alice", "/activity")).status_code == 200
    r = await api.delegated("GET", "/directory", EMAILS["alice"])
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert (await api.get("alice", "/directory")).status_code == 429
    # /me and /requests/{id} are not budgeted, for a member or through a delegate.
    assert (await api.delegated("GET", "/me", EMAILS["alice"])).status_code == 200
    # Bob's budget is his own, whoever reads it.
    assert (await api.delegated("GET", "/directory", EMAILS["bob"])).status_code == 200
    assert (await api.get("bob", "/activity")).status_code == 200

    refused = [e for e in _logs(capsys.readouterr().out) if e["event"] == "read_refused"]
    assert [(e["member"], e.get("delegate")) for e in refused] == [
        ("alice", DELEGATES["demo"]),
        ("alice", None),
    ]

    api.clock.advance(61)
    assert (await api.delegated("GET", "/directory", EMAILS["alice"])).status_code == 200


# No audit, no presence, logged -------------------------------------------------------------


async def test_delegated_reads_are_not_audited_and_move_no_presence(api: Api):
    rid = await api.ask("alice", to=["bob"])
    audit_before = await api.store.list_audit(api.team)
    for member in ("alice", "bob"):
        for path in ("/me", "/directory", "/activity", f"/requests/{rid}"):
            r = await api.delegated("GET", path, EMAILS[member])
            assert r.status_code == 200, (path, r.text)
        # A stream read would move presence; it is refused before it can.
        r = await api.delegated("GET", "/streams/inbox", EMAILS[member], params={"wait": "0"})
        assert r.status_code == 403
    assert await api.store.list_audit(api.team) == audit_before

    directory = await api.directory("carol")
    for member in ("alice", "bob"):
        assert directory[member]["last_seen"] is None
        assert directory[member]["sessions"] == {
            "working": {"last_seen": None},
            "answering": {"last_seen": None},
        }


async def test_delegated_reads_are_logged_with_delegate_and_member(api: Api, capsys):
    capsys.readouterr()
    r = await api.delegated("GET", "/directory", EMAILS["bob"])
    assert r.status_code == 200
    out = capsys.readouterr().out
    lines = [e for e in _logs(out) if e["event"] == "delegated_read"]
    assert len(lines) == 1
    line = lines[0]
    assert line["delegate"] == DELEGATES["demo"]
    assert line["member"] == "bob" and line["team"] == api.team
    assert line["path"] == f"/v1/teams/{api.team}/directory"
    # Neither credential nor the viewer's email is logged.
    assert DELEGATE_TOKENS["demo"] not in out and EMAILS["bob"] not in out


# Everything else is 403 --------------------------------------------------------------------


def _forbidden_calls(rid: str) -> list[tuple[str, str, Any]]:
    reply = {"idempotency_key": "reply-" + uuid.uuid4().hex, "text": "Via the console."}
    return [
        ("GET", "/streams/inbox", None),
        ("GET", "/streams/replies", None),
        ("POST", "/streams/inbox/cursor", {"acked_seq": 1}),
        ("POST", "/streams/replies/cursor", {"acked_seq": 1}),
        ("PUT", "/members/alice/manifest", MANIFEST),
        ("PUT", "/members/bob/manifest", MANIFEST),
        (
            "POST",
            "/requests",
            {
                "idempotency_key": "key-" + uuid.uuid4().hex,
                "kind": "question",
                "to": ["bob"],
                "question": "Sent by the console?",
            },
        ),  # fmt: skip
        ("POST", f"/requests/{rid}/ack", None),
        ("POST", f"/requests/{rid}/reply", reply),
        ("POST", f"/requests/{rid}/progress", {"text": "Working.", "pct": 10}),
        ("POST", f"/requests/{rid}/events", {"tool": "Bash", "status": "ok", "duration_ms": 5}),
    ]


async def test_everything_but_the_four_reads_is_forbidden_and_changes_nothing(api: Api, capsys):
    rid = await api.ask("alice", to=["bob"])
    audit_before = await api.store.list_audit(api.team)
    feed_before = await api.activity("carol")
    capsys.readouterr()

    for member in ("alice", "bob"):
        for method, path, body in _forbidden_calls(rid):
            kwargs = {} if body is None else {"json": body}
            r = await api.delegated(method, path, EMAILS[member], **kwargs)
            assert r.status_code == 403, (member, method, path, r.text)
            assert r.json() == {"error": "forbidden", "detail": "A delegate may only read."}

    lines = [e for e in _logs(capsys.readouterr().out) if e["event"] == "delegate_refused"]
    assert len(lines) == 2 * len(_forbidden_calls(rid))
    assert all(e["delegate"] == DELEGATES["demo"] and e["status"] == 403 for e in lines)
    assert {e["member"] for e in lines} == {"alice", "bob"}

    # Not audited (the member named did not attempt them), and nothing moved.
    assert await api.store.list_audit(api.team) == audit_before
    feed_after = await api.activity("carol")
    assert feed_after["requests"] == feed_before["requests"]
    status = (await api.get("alice", f"/requests/{rid}")).json()
    assert status["recipients"]["bob"]["status"] == "pending"
    assert status["progress"] == []
    directory = await api.directory("carol")
    assert directory["alice"]["manifest"] is None and directory["bob"]["manifest"] is None
    assert directory["bob"]["sessions"]["answering"]["last_seen"] is None
    # Bob's inbox still holds the question, unread by anyone.
    assert [m["request_id"] for m in (await api.stream("bob", "inbox"))["messages"]] == [rid]


async def test_every_route_but_the_four_reads_is_forbidden(api: Api):
    """Walks the app's own route table, so a route added later is refused unless it is
    added to DELEGATE_ROUTES on purpose."""
    rid = await api.ask("alice", to=["bob"])
    routes = [
        r for r in api.app.routes if isinstance(r, APIRoute) and r.path.startswith("/v1/teams/")
    ]
    assert DELEGATE_ROUTES <= {r.path for r in routes}
    for route in routes:
        path = (
            route.path.removeprefix("/v1/teams/{team}")
            .replace("{member}", "alice")
            .replace("{stream}", "inbox")
            .replace("{request_id}", rid)
        )
        for method in sorted(route.methods):
            kwargs = {} if method == "GET" else {"json": {}}
            r = await api.delegated(method, path, EMAILS["alice"], **kwargs)
            if method == "GET" and route.path in DELEGATE_ROUTES:
                assert r.status_code == 200, (method, route.path, r.text)
            else:
                assert r.status_code == 403, (method, route.path, r.text)


async def test_head_and_other_methods_on_the_reads_are_not_served(api: Api):
    for method in ("HEAD", "POST", "PUT", "DELETE", "PATCH"):
        r = await api.delegated(method, "/me", EMAILS["alice"])
        assert r.status_code in (403, 405), (method, r.status_code)


async def test_another_teams_url_is_404_and_not_audited(api: Api):
    for method, path in (("GET", "/v1/teams/other/me"), ("POST", "/v1/teams/other/requests")):
        r = await api.client.request(
            method,
            path,
            headers={**_headers(EMAILS["alice"])},
            json={} if method == "POST" else None,
        )
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
    # Other-team refusals of a member's mutations are filed under the member's team; a
    # delegate's are not filed at all.
    assert await api.store.list_audit(api.team) == []


def _headers(on_behalf: str | None, team: str = "demo") -> dict[str, str]:
    headers = {"Authorization": f"Bearer {DELEGATE_TOKENS[team]}"}
    if on_behalf is not None:
        headers[ON_BEHALF_HEADER] = on_behalf
    return headers


# The header rules --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "on_behalf, reason",
    [
        (None, "missing_on_behalf"),
        ("", "unknown_on_behalf"),
        ("alice", "unknown_on_behalf"),
        ("google:alice@example.com", "unknown_on_behalf"),
        ("alice@example.com,bob@example.com", "unknown_on_behalf"),
    ],
)
async def test_a_delegate_without_a_member_of_its_team_is_401(
    api: Api, capsys, on_behalf: str | None, reason: str
):
    capsys.readouterr()
    for method, path in (("GET", "/me"), ("GET", "/directory"), ("POST", "/requests")):
        kwargs = {"json": {}} if method == "POST" else {}
        r = await api.delegated(method, path, on_behalf, **kwargs)
        assert r.status_code == 401, (on_behalf, path)
        assert r.json() == {"error": "unauthenticated"}
    out = capsys.readouterr().out
    lines = [e for e in _logs(out) if e["event"] == "auth_rejected"]
    assert len(lines) == 3
    assert all(e["reason"] == reason and e["delegate"] == DELEGATES["demo"] for e in lines)
    if on_behalf:
        assert on_behalf not in out
    assert DELEGATE_TOKENS["demo"] not in out
    assert await api.store.list_audit(api.team) == []


@pytest.mark.parametrize(
    "on_behalf",
    ["mallory@example.com", EMAILS["dave"]],  # nobody; a member of another team
)
async def test_a_delegate_naming_a_non_member_is_403_not_a_member(api: Api, capsys, on_behalf: str):
    capsys.readouterr()
    for method, path in (("GET", "/me"), ("GET", "/directory"), ("POST", "/requests")):
        kwargs = {"json": {}} if method == "POST" else {}
        r = await api.delegated(method, path, on_behalf, **kwargs)
        assert r.status_code == 403, (on_behalf, path)
        assert r.json()["error"] == "not_a_member"
    out = capsys.readouterr().out
    lines = [e for e in _logs(out) if e["event"] == "auth_rejected"]
    assert len(lines) == 3 and all(e["reason"] == "not_a_member" for e in lines)
    assert on_behalf not in out
    assert await api.store.list_audit(api.team) == []


async def test_a_repeated_on_behalf_header_is_401(api: Api, capsys):
    capsys.readouterr()
    r = await api.client.get(
        api.url("/me"),
        headers=[
            ("Authorization", f"Bearer {DELEGATE_TOKENS['demo']}"),
            (ON_BEHALF_HEADER, EMAILS["alice"]),
            (ON_BEHALF_HEADER, EMAILS["alice"]),
        ],
    )
    assert r.status_code == 401 and r.json() == {"error": "unauthenticated"}
    [line] = [e for e in _logs(capsys.readouterr().out) if e["event"] == "auth_rejected"]
    assert line["reason"] == "repeated_on_behalf"


async def test_the_on_behalf_email_is_case_insensitive(api: Api):
    r = await api.delegated("GET", "/me", "Bob@EXAMPLE.com")
    assert r.status_code == 200 and r.json()["member"] == "bob"


async def test_another_teams_delegate_cannot_name_this_teams_member(api: Api):
    r = await api.delegated("GET", "/me", EMAILS["alice"], delegate="other")
    assert r.status_code == 403 and r.json()["error"] == "not_a_member"
    # It can name its own member, and then this team's URL is someone else's team: 404.
    r = await api.delegated("GET", "/me", EMAILS["dave"], delegate="other")
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await api.client.get("/v1/teams/other/me", headers=_headers(EMAILS["dave"], "other"))
    assert r.status_code == 200 and r.json()["member"] == "dave"


@pytest.mark.parametrize("value", [EMAILS["alice"], EMAILS["bob"], "", "nobody@example.com"])
async def test_a_member_sending_on_behalf_is_400_and_changes_nothing(api: Api, capsys, value: str):
    capsys.readouterr()
    extra = {ON_BEHALF_HEADER: value}
    r = await api.client.get(api.url("/me"), headers={**auth("alice"), **extra})
    assert r.status_code == 400 and r.json()["error"] == "bad_request"
    r = await api.client.get(api.url("/directory"), headers={**auth("alice"), **extra})
    assert r.status_code == 400
    body = {"idempotency_key": "key-" + uuid.uuid4().hex, "kind": "question", "to": ["bob"],
            "question": "Who am I?"}  # fmt: skip
    r = await api.client.post(api.url("/requests"), headers={**auth("alice"), **extra}, json=body)
    assert r.status_code == 400 and r.json()["error"] == "bad_request"
    # On another team's URL too: the header is refused before the team is looked at.
    r = await api.client.get("/v1/teams/other/me", headers={**auth("alice"), **extra})
    assert r.status_code == 400

    lines = [e for e in _logs(capsys.readouterr().out) if e["event"] == "on_behalf_refused"]
    assert len(lines) == 4 and all(e["member"] == "alice" for e in lines)
    assert await api.store.list_audit(api.team) == []
    assert (await api.activity("alice"))["requests"] == []
    # Without the header, the same member is served as before.
    assert (await api.get("alice", "/me")).json()["member"] == "alice"


async def test_member_tokens_still_work_beside_delegates(api: Api):
    for member in ("alice", "bob", "carol"):
        r = await api.client.get(
            api.url("/me"), headers={"Authorization": f"Bearer {TOKENS[member]}"}
        )
        assert r.status_code == 200 and r.json()["member"] == member
