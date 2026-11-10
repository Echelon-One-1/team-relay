"""The login flow (M5-SPEC §2, gates in §8) against the fake Google provider, on both stores:
the valid flow; state and cookie mismatches; a replayed Google code; a bad nonce; an
unverified email; an account on no team; CSRF missing or wrong; a team you are not in; code
reuse revoking; a wrong verifier; expired login, code and credential; the loopback as the
only redirect target; the rate limits; the pages' CSP and escaping."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import timedelta
from typing import Any

import httpx
import pytest
from starlette.datastructures import Headers as StarletteHeaders

from relay.app import create_app
from relay.config import Settings, load_schema, parse_team_config
from relay.login import client_ip
from relay.pages import CSP, STYLESHEET_HREF, chooser_page, message_page
from relay.store import LoginChoice
from relay.store_memory import MemoryStore

from .conftest import (
    EMAILS,
    PUBLIC_URL,
    SCHEMA_PATH,
    TOKENS,
    Api,
    FakeClock,
    accept_invitation,
    auth,
    open_api,
    principal,
    team_config_data,
)
from .fake_google import CLIENT_ID
from .login_helpers import (
    DEVICE,
    LISTENER_PORT,
    bearer,
    callback,
    challenge_of,
    choose,
    continue_as,
    cookie_from,
    google,
    hidden_csrf,
    login,
    loopback,
    set_cookie_header,
    start,
    start_query,
    to_chooser,
    token,
)

pytestmark = pytest.mark.anyio


def _logs(out: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in out.splitlines() if line.strip().startswith("{")]


# The valid flow ------------------------------------------------------------------------------


async def test_the_whole_flow_yields_a_working_credential(api: Api, capsys):
    started = await start(api.client)
    # Step 2: the cookie, and the redirect to Google with the relay's own PKCE and nonce.
    cookie_header = set_cookie_header(started.response).lower()
    for attribute in ("httponly", "secure", "samesite=lax", "path=/v1/login", "max-age=600"):
        assert attribute in cookie_header
    location = started.response.headers["location"]
    assert location.startswith("https://accounts.fake.example/o/oauth2/v2/auth?")
    params = started.params
    assert params["client_id"] == CLIENT_ID
    assert params["redirect_uri"] == f"{PUBLIC_URL}/v1/login/callback"
    assert params["response_type"] == "code"
    assert params["scope"] == "openid email"
    assert params["state"] == started.cookie  # Google's state is the login id
    assert params["code_challenge_method"] == "S256"
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", params["code_challenge"])
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", params["nonce"])
    assert params["prompt"] == "select_account"
    # Neither the plugin's state nor its challenge goes to Google.
    assert started.state not in location and challenge_of(started.verifier) not in location

    # Step 3–4: Google approves; the chooser shows the account, the device, the warning and
    # the one team, preselected.
    r = await google(api.client, api.fake, started, EMAILS["alice"])
    assert r.status_code == 200, r.text
    assert r.headers["content-security-policy"] == CSP
    assert "alice@example.com" in r.text and DEVICE in r.text
    assert (
        re.sub(r"<[^>]+>", "", r.text).count(
            "Only continue if you just ran /team-relay:login in your own Claude Code."
        )
        == 1
    )
    assert re.search(rf'value="{api.team}" checked required', r.text)
    assert ">alice<" in r.text  # the member id the account is on that team

    # Step 5: the one-time code goes to the plugin's listener, and only there.
    reply = await choose(
        api.client,
        started.cookie,
        {"csrf": hidden_csrf(r.text), "team": api.team, "action": "continue"},
    )
    target, query = loopback(reply)
    assert target == f"http://127.0.0.1:{LISTENER_PORT}/callback"
    assert query["state"] == started.state
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", query["code"])
    assert "max-age=0" in set_cookie_header(reply).lower()  # the cookie is cleared

    # Step 7: the token.
    r = await token(api.client, query["code"], started.verifier)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == {"credential", "team", "member", "email", "relay_url", "expires_at"}
    assert re.fullmatch(r"trc_[A-Za-z0-9_-]{43}", body["credential"])
    assert (body["team"], body["member"], body["relay_url"]) == (api.team, "alice", PUBLIC_URL)
    # M5-SPEC §9.3: who the member became, by the Google account they signed in with.
    assert body["email"] == "alice@example.com"
    assert body["expires_at"] == "2026-12-22T12:00:00.000Z"  # 90 days

    # The credential is alice on this team.
    r = await api.client.get(api.url("/me"), headers=bearer(body["credential"]))
    assert r.status_code == 200 and r.json()["member"] == "alice"

    out = capsys.readouterr().out
    assert body["credential"] not in out and query["code"] not in out
    assert started.cookie not in out and "alice@example.com" not in out
    events = [line["event"] for line in _logs(out)]
    assert {"login_started", "login_chosen", "login_completed"} <= set(events)


async def test_the_credential_creation_is_audited_without_the_secret(api: Api):
    body = await login(api, "bob")
    entries = [e for e in await api.store.list_audit(api.team) if e.action == "credential.create"]
    assert len(entries) == 1
    entry = entries[0]
    assert (entry.actor, entry.member, entry.outcome) == ("bob", "bob", "created")
    key = hashlib.sha256(body["credential"].encode()).hexdigest()
    assert entry.detail == f"credential {key[:16]}"
    assert body["credential"] not in repr(entry) and key not in repr(entry)


async def test_the_store_keeps_only_hashes(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    login_key = hashlib.sha256(chooser.started.cookie.encode()).hexdigest()
    seen: dict[str, Any] = {}

    def peek(doc):
        from relay.store import LoginChange

        seen["doc"] = doc
        return LoginChange(result=None)

    await api.store.mutate_login(login_key, peek)
    doc = seen["doc"]
    assert doc is not None and doc.step == "choose" and doc.email == "alice@example.com"
    assert doc.csrf_sha256 == hashlib.sha256(chooser.csrf.encode()).hexdigest()
    assert chooser.csrf not in repr(doc)
    assert doc.expire_at == api.clock.current + timedelta(minutes=10)
    # Nothing is stored under the login id itself.
    await api.store.mutate_login(chooser.started.cookie, peek)
    assert seen["doc"] is None


# Step 1–2: /v1/login/start ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"port": "80"},
        {"port": "1023"},
        {"port": "65536"},
        {"port": "08080"},
        {"port": "8080x"},
        {"port": ""},
        {"state": "short"},
        {"state": "x" * 129},
        {"state": "a b" * 20},
        {"code_challenge": "A" * 42},
        {"code_challenge": "A" * 44},
        {"code_challenge": "=" * 43},
        {"code_challenge_method": "plain"},
        {"code_challenge_method": "s256"},
        {"device": ""},
        {"device": "x" * 65},
        {"device": "<script>"},
        {"device": "host\nname"},
    ],
)
async def test_start_refuses_bad_parameters(api: Api, change: dict[str, str]):
    query, _, _ = start_query()
    query.update(change)
    r = await api.client.get("/v1/login/start", params=query)
    assert r.status_code == 400
    assert "location" not in r.headers and cookie_from(r) is None
    assert r.headers["content-security-policy"] == CSP


async def test_start_refuses_missing_and_repeated_parameters(api: Api):
    query, _, _ = start_query()
    for name in query:
        partial = {k: v for k, v in query.items() if k != name}
        r = await api.client.get("/v1/login/start", params=partial)
        assert r.status_code == 400, name
    r = await api.client.get(
        "/v1/login/start", params=[*query.items(), ("port", str(LISTENER_PORT + 1))]
    )
    assert r.status_code == 400
    r = await api.client.get("/v1/login/start")
    assert r.status_code == 400  # the smoke check of M5-SPEC §5


async def test_login_pages_are_404_when_login_is_not_configured():
    settings = Settings(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
    )
    app = create_app(settings, MemoryStore())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as c:
        query, _, _ = start_query()
        for method, path in (
            ("GET", "/v1/login/start"),
            ("GET", "/v1/login/callback"),
            ("POST", "/v1/login/choose"),
            ("POST", "/v1/login/token"),
            ("GET", "/v1/login/style.css"),
        ):
            r = await c.request(method, path, params=query)
            assert r.status_code == 404 and r.json() == {"error": "not_found"}


# Step 3: the callback -------------------------------------------------------------------------


async def test_callback_needs_the_cookie_that_matches_state(api: Api):
    started = await start(api.client)
    code = api.fake.authorize(started.params, EMAILS["alice"])
    other = await start(api.client)
    for kwargs in (
        {"cookie": None},  # no cookie: not this browser
        {"cookie": other.cookie},  # another login's cookie
        {"state": other.params["state"]},  # another login's state
        {"state": None},
        {"cookie": "x" * 43},
    ):
        r = await callback(api.client, started, code, **kwargs)
        assert r.status_code == 400, kwargs
        assert "did not start in this browser" in r.text
    assert api.fake.token_calls == 0  # refused before Google was asked
    # The login is still waiting: the right cookie and state still work.
    r = await callback(api.client, started, code)
    assert r.status_code == 200, r.text


async def test_a_replayed_callback_finds_the_login_used(api: Api):
    started = await start(api.client)
    code = api.fake.authorize(started.params, EMAILS["alice"])
    assert (await callback(api.client, started, code)).status_code == 200
    r = await callback(api.client, started, code)
    assert r.status_code == 400 and "expired or was already used" in r.text
    assert api.fake.token_calls == 1


async def test_a_replayed_google_code_is_refused(api: Api):
    """A code Google already redeemed (for another login) fails at Google's token endpoint;
    the login is closed."""
    first = await start(api.client)
    code = api.fake.authorize(first.params, EMAILS["alice"])
    assert (await callback(api.client, first, code)).status_code == 200
    second = await start(api.client)
    r = await callback(api.client, second, code)
    assert r.status_code == 400 and "Sign-in with Google did not complete" in r.text
    r = await callback(api.client, second, api.fake.authorize(second.params, EMAILS["alice"]))
    assert r.status_code == 400 and "expired or was already used" in r.text  # closed


async def test_google_error_closes_the_login(api: Api):
    started = await start(api.client)
    r = await callback(api.client, started, None, extra={"error": "access_denied"})
    assert r.status_code == 400 and "cancelled" in r.text
    r = await google(api.client, api.fake, started, EMAILS["alice"])
    assert r.status_code == 400


@pytest.mark.parametrize(
    "grant, title",
    [
        ({"claims": {"nonce": "not-the-nonce"}}, "did not complete"),
        ({"drop": ("nonce",)}, "did not complete"),
        ({"email_verified": False}, "email is not verified"),
        ({"email_verified": "true"}, "email is not verified"),
        ({"drop": ("email_verified",)}, "email is not verified"),
        ({"drop": ("email",)}, "did not complete"),
        ({"claims": {"email": "not an email"}}, "did not complete"),
        ({"claims": {"aud": "someone-else.apps.googleusercontent.com"}}, "did not complete"),
        ({"claims": {"azp": "someone-else.apps.googleusercontent.com"}}, "did not complete"),
        ({"claims": {"iss": "https://evil.example"}}, "did not complete"),
        ({"claims": {"exp": 1}}, "did not complete"),
        ({"header": {"alg": "HS256"}}, "did not complete"),
        ({"header": {"kid": "unknown-kid"}}, "did not complete"),
    ],
)
async def test_the_id_token_is_checked(api: Api, grant: dict[str, Any], title: str):
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["alice"], **grant)
    assert r.status_code in (400, 403), r.text
    assert title in r.text
    assert 'name="csrf"' not in r.text
    # The login is closed: the same browser cannot go on with another code.
    r = await google(api.client, api.fake, started, EMAILS["alice"])
    assert r.status_code == 400


async def test_an_account_on_no_team(api: Api, capsys):
    """M9-SPEC §3: no longer the end of the flow: the page offers to create a team."""
    started = await start(api.client)
    r = await google(api.client, api.fake, started, "Mallory@Example.com")
    assert r.status_code == 200
    assert "You're not on a team yet" in r.text
    assert "Ask a team owner to add" in r.text and "mallory@example.com" in r.text
    assert 'action="/v1/login/create"' in r.text
    assert 'name="team" value=""' in r.text  # no team to choose: the create form's field
    assert 'type="radio"' not in r.text
    assert "mallory@example.com" not in capsys.readouterr().out  # never logged


async def test_a_verified_email_is_matched_lower_cased(api: Api):
    chooser = await to_chooser(api.client, api.fake, "ALICE@Example.COM")
    assert "alice@example.com" in chooser.response.text


# Step 4–5: the chooser and its POST --------------------------------------------------------


async def test_csrf_missing_or_wrong_is_refused(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    cookie = chooser.started.cookie
    for fields in (
        {"team": api.team, "action": "continue"},
        {"csrf": "", "team": api.team},
        {"csrf": "A" * 43, "team": api.team},
        {"csrf": chooser.csrf[:-1] + ("A" if chooser.csrf[-1] != "A" else "B"), "team": api.team},
    ):
        r = await choose(api.client, cookie, fields)
        assert r.status_code == 403, fields
        assert "location" not in r.headers
    # Still choosing: the right token works.
    await continue_as(api.client, chooser, api.team)


async def test_the_chooser_post_needs_the_cookie_and_a_same_origin_form(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    fields = {"csrf": chooser.csrf, "team": api.team, "action": "continue"}
    assert (await choose(api.client, None, fields)).status_code == 400
    other = await to_chooser(api.client, api.fake, EMAILS["alice"])
    r = await choose(api.client, other.started.cookie, fields)  # another login's cookie
    assert r.status_code == 403
    for origin in ("https://evil.example", "null", PUBLIC_URL + ":443", "http://relay.example.com"):
        r = await choose(api.client, chooser.started.cookie, fields, headers={"Origin": origin})
        assert r.status_code == 403, origin
    r = await api.client.post(
        "/v1/login/choose",
        json=fields,
        headers={"Cookie": f"trl={chooser.started.cookie}"},
    )
    assert r.status_code == 400  # not a form
    for bad in ("csrf=a&csrf=b&team=x", "evil=1&csrf=a", "%ff=1", "a" * 5000):
        r = await api.client.post(
            "/v1/login/choose",
            content=bad,
            headers={
                "Cookie": f"trl={chooser.started.cookie}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        assert r.status_code == 400, bad
    r = await choose(api.client, chooser.started.cookie, fields, headers={"Origin": PUBLIC_URL})
    assert r.status_code == 303


async def test_choosing_a_team_you_are_not_in_is_refused(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    for team in ("other", "nosuchteam", "", api.team.upper()):
        r = await choose(
            api.client,
            chooser.started.cookie,
            {"csrf": chooser.csrf, "team": team, "action": "continue"},
        )
        assert r.status_code == 400, team
        assert "location" not in r.headers
    await continue_as(api.client, chooser, api.team)


async def test_a_choice_is_made_once(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    await continue_as(api.client, chooser, api.team)
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert r.status_code == 400 and "location" not in r.headers


async def test_cancel_closes_the_login_and_tells_only_the_listener(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    r = await choose(api.client, chooser.started.cookie, {"csrf": chooser.csrf, "action": "cancel"})
    target, query = loopback(r)
    assert target == f"http://127.0.0.1:{LISTENER_PORT}/callback"
    assert query == {"error": "access_denied", "state": chooser.started.state}
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert r.status_code == 400


async def test_a_member_removed_while_choosing_gets_no_code(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["carol"])
    r = await api.client.delete(api.url("/roster/carol"), headers=auth("alice"))
    assert r.status_code == 409  # carol is a seed member; take bob's route instead
    r = await api.client.post(
        api.url("/roster"),
        headers=auth("alice"),
        json={"member": "erin", "email": "erin@example.com"},
    )
    assert r.status_code == 201, r.text
    await accept_invitation(api.client, api.team, "erin@example.com")
    chooser = await to_chooser(api.client, api.fake, "erin@example.com")
    r = await api.client.delete(api.url("/roster/erin"), headers=auth("alice"))
    assert r.status_code == 200, r.text
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert r.status_code == 403 and "location" not in r.headers


# The redirect target ---------------------------------------------------------------------------


@pytest.mark.parametrize("port", [1024, 8080, 65535])
async def test_the_only_redirect_target_is_the_loopback_listener(api: Api, port: int):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"], port=port)
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert r.headers["location"].startswith(f"http://127.0.0.1:{port}/callback?")


async def test_no_parameter_can_move_the_redirect(api: Api):
    """Hosts, schemes and paths are not parameters: whatever start is sent, the chooser's
    redirect is http://127.0.0.1:<port>/callback."""
    for extra in (
        {"redirect_uri": "https://evil.example/callback"},
        {"host": "evil.example"},
        {"callback": "https://evil.example"},
    ):
        query, verifier, _ = start_query()
        r = await api.client.get("/v1/login/start", params={**query, **extra})
        assert r.status_code == 302
        assert "evil" not in r.headers["location"]
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert re.fullmatch(
        rf"http://127\.0\.0\.1:{LISTENER_PORT}/callback\?code=[A-Za-z0-9_-]{{43}}&state=[A-Za-z0-9_-]+",
        r.headers["location"],
    )


# Step 7: the token -----------------------------------------------------------------------------


async def test_code_reuse_revokes_the_credential_it_minted(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    query = await continue_as(api.client, chooser, api.team)
    first = await token(api.client, query["code"], chooser.started.verifier)
    assert first.status_code == 200
    credential = first.json()["credential"]
    assert (await api.client.get(api.url("/me"), headers=bearer(credential))).status_code == 200
    again = await token(api.client, query["code"], chooser.started.verifier)
    assert again.status_code == 400 and again.json() == {"error": "invalid_grant"}
    r = await api.client.get(api.url("/me"), headers=bearer(credential))
    assert r.status_code == 401  # at once on this instance
    audit = [e for e in await api.store.list_audit(api.team) if e.action == "credential.revoke"]
    assert [(e.actor, e.member) for e in audit] == [("relay", "alice")]
    assert "reused" in (audit[0].detail or "")


async def test_a_wrong_verifier_burns_the_code(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    query = await continue_as(api.client, chooser, api.team)
    other = "B" * 43
    r = await token(api.client, query["code"], other)
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant"}
    r = await token(api.client, query["code"], chooser.started.verifier)
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant"}


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        {},
        {"code": "A" * 43},
        {"code_verifier": "A" * 43},
        {"code": "A" * 42, "code_verifier": "A" * 43},
        {"code": "A" * 43, "code_verifier": "A" * 42},
        {"code": "A" * 43, "code_verifier": "A" * 129},
        {"code": "A" * 43, "code_verifier": "A" * 43, "extra": 1},
        {"code": 1, "code_verifier": "A" * 43},
    ],
)
async def test_a_malformed_token_request_is_400(api: Api, body: Any):
    r = await api.client.post("/v1/login/token", json=body)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


async def test_an_unknown_code_is_invalid_grant(api: Api):
    r = await token(api.client, "A" * 43, "B" * 43)
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant"}
    r = await api.client.post("/v1/login/token", content=b"{not json")
    assert r.status_code == 400


# Expiry -----------------------------------------------------------------------------------------


async def test_an_expired_login(api: Api):
    started = await start(api.client)
    api.clock.advance(600)
    r = await google(api.client, api.fake, started, EMAILS["alice"])
    assert r.status_code == 400 and "expired" in r.text
    # Expiring between the chooser and the POST.
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    api.clock.advance(600)
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": api.team, "action": "continue"},
    )
    assert r.status_code == 400 and "location" not in r.headers


async def test_an_expired_code(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    query = await continue_as(api.client, chooser, api.team)
    api.clock.advance(120)
    r = await token(api.client, query["code"], chooser.started.verifier)
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant"}


async def test_a_code_is_good_just_before_it_expires(api: Api):
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    query = await continue_as(api.client, chooser, api.team)
    api.clock.advance(119)
    r = await token(api.client, query["code"], chooser.started.verifier)
    assert r.status_code == 200


async def test_an_expired_credential(api: Api):
    body = await login(api, "alice")
    api.clock.advance(90 * 86400)
    r = await api.client.get(api.url("/me"), headers=bearer(body["credential"]))
    assert r.status_code == 401


# Multi-team principals (M5-SPEC §4) -----------------------------------------------------------


def _alice_in_two_teams(data: dict[str, Any]) -> None:
    data["teams"][1]["id"] = "o" + uuid.uuid4().hex[:20]
    data["teams"][1]["members"].append(
        {"id": "alicia", "principals": [f"google:{EMAILS['alice']}"]}
    )
    data["delegates"] = []


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_principal_on_two_teams_chooses_one(kind: str, clock: FakeClock):
    async with open_api(kind, clock, configure=_alice_in_two_teams) as api:
        other = api.settings.team_config.team_ids()[1]
        chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
        assert chooser.teams == [api.team, other]
        assert ">alicia<" in chooser.response.text and ">alice<" in chooser.response.text
        # M6-SPEC §7.5: with more than one team, none is preselected; the member picks.
        assert " checked" not in chooser.response.text
        assert chooser.response.text.count(" required>") == 2
        query = await continue_as(api.client, chooser, other)
        body = (await token(api.client, query["code"], chooser.started.verifier)).json()
        assert (body["team"], body["member"]) == (other, "alicia")
        cred = bearer(body["credential"])
        r = await api.client.get(f"/v1/teams/{other}/me", headers=cred)
        assert r.status_code == 200 and r.json()["member"] == "alicia"
        r = await api.client.get(api.url("/me"), headers=cred)
        assert r.status_code == 404  # the credential is for one team only
        # Her static token is alice in the first team only: 404 in the second.
        r = await api.client.get(f"/v1/teams/{other}/me", headers=auth("alice"))
        assert r.status_code == 404


# Rate limits ------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_login_rate_limits_are_per_ip(kind: str, clock: FakeClock):
    async with open_api(
        kind,
        clock,
        login_starts_per_minute=3,
        login_pages_per_minute=4,
        login_tokens_per_minute=2,
    ) as api:
        ip = f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        async with api.instance(client_ip=ip) as (c, _):
            query, _, _ = start_query()
            for _ in range(3):
                assert (await c.get("/v1/login/start", params=query)).status_code == 302
            r = await c.get("/v1/login/start", params=query)
            assert r.status_code == 429 and "location" not in r.headers
            for _ in range(4):
                r = await c.get("/v1/login/callback")
                assert r.status_code == 400
            assert (await c.get("/v1/login/callback")).status_code == 429
            r = await c.post(
                "/v1/login/choose",
                content="csrf=x",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert r.status_code == 429  # callback and choose share one budget
            for _ in range(2):
                assert (await token(c, "A" * 43, "B" * 43)).status_code == 400
            r = await token(c, "A" * 43, "B" * 43)
            assert r.status_code == 429 and r.json()["error"] == "rate_limited"
        # Another address has its own budget.
        async with api.instance(client_ip=ip + "0" if len(ip) < 15 else "10.9.9.9") as (c2, _):
            assert (await c2.get("/v1/login/start", params=query)).status_code == 302
        # A new minute starts from zero.
        clock.advance(60)
        async with api.instance(client_ip=ip) as (c, _):
            assert (await c.get("/v1/login/start", params=query)).status_code == 302


class _Req:
    def __init__(self, headers: list[tuple[str, str]], peer: str | None) -> None:
        self.headers = StarletteHeaders(
            raw=[(k.encode("latin-1"), v.encode("latin-1")) for k, v in headers]
        )
        self.client = type("C", (), {"host": peer})() if peer is not None else None


@pytest.mark.parametrize(
    "headers, peer, on_cloud_run, expected",
    [
        # Off Cloud Run: the socket peer; the header is ignored.
        ([("x-forwarded-for", "1.2.3.4")], "127.0.0.1", False, "127.0.0.1"),
        ([], "192.0.2.7", False, "192.0.2.7"),
        # On Cloud Run: the right-most entry, the one Google's front end appended.
        ([("x-forwarded-for", "203.0.113.9")], "169.254.1.1", True, "203.0.113.9"),
        ([("x-forwarded-for", "6.6.6.6, 203.0.113.9")], "169.254.1.1", True, "203.0.113.9"),
        ([("x-forwarded-for", "6.6.6.6"), ("x-forwarded-for", "203.0.113.9")], None, True,
         "203.0.113.9"),
        ([], "169.254.1.1", True, "unknown"),
        ([("x-forwarded-for", "not-an-ip")], None, True, "unknown"),
        # IPv6 counts per /64.
        ([("x-forwarded-for", "2001:db8:1:2:3:4:5:6")], None, True, "2001:db8:1:2::/64"),
        ([("x-forwarded-for", "2001:db8:1:2:ffff::1")], None, True, "2001:db8:1:2::/64"),
    ],
)  # fmt: skip
def test_client_ip(headers, peer, on_cloud_run, expected):
    assert client_ip(_Req(headers, peer), on_cloud_run, 1) == expected  # type: ignore[arg-type]


# The pages ------------------------------------------------------------------------------------


async def test_every_login_page_has_the_strict_headers(api: Api):
    started = await start(api.client)
    responses = [
        started.response,
        await api.client.get("/v1/login/start"),
        await google(api.client, api.fake, started, EMAILS["alice"]),
        await callback(api.client, started, "x", cookie=None),
    ]
    for r in responses:
        assert r.headers["content-security-policy"] == CSP
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["referrer-policy"] == "same-origin"
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["x-content-type-options"] == "nosniff"
    for r in responses[1:]:
        assert "<script" not in r.text.lower() and " on" not in re.sub(r"\s+", " ", "")
        assert re.search(r"\son[a-z]+=", r.text) is None
        assert f'href="{STYLESHEET_HREF}"' in r.text
        assert re.fullmatch(r"/v1/login/style\.css\?v=[0-9a-f]{12}", STYLESHEET_HREF)
    css = await api.client.get("/v1/login/style.css")
    assert css.status_code == 200 and css.headers["content-type"].startswith("text/css")
    assert "url(" not in css.text and "@import" not in css.text
    assert "default-src 'none'" in CSP and "script-src" not in CSP
    assert "form-action 'self' http://127.0.0.1:*" in CSP
    assert "frame-ancestors 'none'" in CSP


def test_the_pages_escape_everything():
    hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>'
    html = chooser_page(
        email=hostile,
        device=hostile,
        choices=[LoginChoice(team=hostile, member=hostile)],
        csrf=hostile,
        action="/v1/login/choose",
    )
    assert "<script>" not in html and "<img" not in html
    # email, device, the team (value and label), the member, the CSRF token
    assert html.count("&lt;script&gt;") == 6 and "&quot;&gt;" in html
    page = message_page(hostile, [hostile])
    assert "<script>" not in page and "<img" not in page


async def test_a_static_token_is_not_a_credential(api: Api):
    """``trc_`` bearer tokens take the credential path only: the static verifier (which
    would hash anything) never sees them."""
    r = await api.client.get(api.url("/me"), headers={"Authorization": "Bearer trc_" + "A" * 43})
    assert r.status_code == 401
    assert principal(TOKENS["alice"]).startswith("token:sha256:")
