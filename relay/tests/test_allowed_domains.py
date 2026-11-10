"""M10-SPEC §7.2: RELAY_ALLOWED_DOMAINS. When set, every Google identity that reaches the relay
must have a verified email whose domain is exactly one of the list, and an ``hd`` claim equal
to that domain; every email the relay is handed must be in one of them. Covered here, path by
path:

- the setting itself (parsing, startup errors) and the team file's seed members and admins
  (a startup error naming the member, never the email); delegates (service accounts) exempt;
- a Google ID token, through the real verifier, for the service URL and the gcloud audience;
- the same through the app's every route kind (team routes and account routes);
- a delegate's on-behalf-of email, on team routes and account routes;
- roster additions (invitations) and ``add_email``; team creation; accepting an invitation;
- the login callback (M5-SPEC §2);
- a device credential minted through an email outside the domains (before they were set).

Unset, everything behaves as before (the rest of the suite runs that way). Synthetic
identities only: example.com is the allowed domain, example.org and example.net are not."""

from __future__ import annotations

import json
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from relay.app import create_app
from relay.auth import GoogleVerifier, Unauthenticated
from relay.config import Settings, load_schema, parse_allowed_domains, parse_team_config
from relay.errors import ApiError, ConfigError
from relay.store_memory import MemoryStore
from relay.teams import parse_new_team

from .conftest import (
    DELEGATE_TOKENS,
    DELEGATES,
    EMAILS,
    SCHEMA_PATH,
    Api,
    DelegateVerifier,
    FakeClock,
    accept_invitation,
    auth,
    google_sub,
    id_token,
    no_cookie_jar,
    open_api,
    team_config_data,
    with_delegates,
)
from .fake_google import FakeGoogleProvider
from .login_helpers import (
    Chooser,
    bearer,
    continue_as,
    google,
    hidden_csrf,
    login,
    start,
    team_values,
)
from .login_helpers import token as redeem
from .test_google_verifier import AUDIENCE, Clock, FakeCertsEndpoint, make_token

pytestmark = pytest.mark.anyio

ALLOWED = frozenset({"example.com"})
GCLOUD_CLIENT = "32555940559.apps.googleusercontent.com"


def refused(r: httpx.Response) -> bool:
    return r.status_code == 403 and r.json()["error"] == "domain_not_allowed"


def new_email(domain: str = "example.com") -> str:
    return f"u{uuid.uuid4().hex[:16]}@{domain}"


def google_headers(email: str, hd: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {id_token(email, google_sub(email), hd)}"}


# The setting --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, frozenset()),
        ("", frozenset()),
        ("  ", frozenset()),
        ("example.com", frozenset({"example.com"})),
        ("example.com,example.org", frozenset({"example.com", "example.org"})),
        (" example.com , sub.example.org ", frozenset({"example.com", "sub.example.org"})),
    ],
)
def test_parse_allowed_domains(raw: str | None, expected: frozenset[str]):
    assert parse_allowed_domains(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "Example.com",
        "example.com,",
        ",example.com",
        "example.com,,example.org",
        "localhost",
        "10.0.0.1",
        "example.com.",
        "@example.com",
        "alice@example.com",
        "*.example.com",
        "example .com",
        "éxample.com",
    ],
)
def test_a_bad_allowed_domain_is_a_startup_error(raw: str, tmp_path: Path):
    with pytest.raises(ConfigError, match="RELAY_ALLOWED_DOMAINS"):
        parse_allowed_domains(raw)
    config = tmp_path / "team.yaml"
    config.write_text(json.dumps(team_config_data()))
    env = {
        "RELAY_TEAM_CONFIG": str(config),
        "RELAY_AUTH_MODE": "static",
        "RELAY_ALLOWED_DOMAINS": raw,
    }
    with pytest.raises(ConfigError, match="RELAY_ALLOWED_DOMAINS"):
        Settings.from_env(env)


def test_the_setting_reaches_the_team_config(tmp_path: Path):
    config = tmp_path / "team.yaml"
    config.write_text(json.dumps(with_delegates(team_config_data())))
    env = {"RELAY_TEAM_CONFIG": str(config), "RELAY_AUTH_MODE": "static"}
    assert Settings.from_env(env).team_config.allowed_domains == frozenset()
    env["RELAY_ALLOWED_DOMAINS"] = "example.com,example.org"
    tc = Settings.from_env(env).team_config
    assert tc.allowed_domains == {"example.com", "example.org"}
    assert tc.email_allowed("a@example.org") and not tc.email_allowed("a@sub.example.org")


def test_a_seed_member_outside_the_domains_is_a_startup_error_naming_the_member(tmp_path: Path):
    data = team_config_data()
    data["teams"][0]["members"][1]["principals"].append("google:bob@example.net")
    parse_team_config(data)  # unset: as before
    with pytest.raises(ConfigError) as caught:
        parse_team_config(data, ALLOWED)
    assert "'bob'" in str(caught.value) and "example.net" not in str(caught.value)
    config = tmp_path / "team.yaml"
    config.write_text(json.dumps(data))
    env = {
        "RELAY_TEAM_CONFIG": str(config),
        "RELAY_AUTH_MODE": "static",
        "RELAY_ALLOWED_DOMAINS": "example.com",
    }
    with pytest.raises(ConfigError, match="'bob'"):
        Settings.from_env(env)
    env["RELAY_ALLOWED_DOMAINS"] = "example.com,example.net"
    assert Settings.from_env(env).team_config.allowed_domains == {"example.com", "example.net"}


def test_a_subdomain_is_not_its_parent():
    data = team_config_data()
    data["teams"][0]["members"][2]["principals"] = ["google:carol@mail.example.com"]
    with pytest.raises(ConfigError, match="'carol'"):
        parse_team_config(data, ALLOWED)


def test_an_admin_outside_the_domains_is_a_startup_error():
    data = team_config_data()
    data["admins"] = ["google:admin@example.com", "google:root@example.org"]
    with pytest.raises(ConfigError) as caught:
        parse_team_config(data, ALLOWED)
    assert "admins.1" in str(caught.value) and "example.org" not in str(caught.value)
    data["admins"] = ["google:admin@example.com"]
    assert parse_team_config(data, ALLOWED).admins == {"admin@example.com"}


def test_delegates_are_the_operators_service_accounts_and_exempt():
    config = parse_team_config(with_delegates(team_config_data()), ALLOWED)
    assert set(config.delegates) == {DELEGATES["demo"], DELEGATES["other"]}


def test_token_only_seed_members_need_no_domain():
    data = team_config_data()
    data["teams"][0]["members"][1]["principals"] = data["teams"][0]["members"][1]["principals"][:1]
    assert parse_team_config(data, ALLOWED).teams["demo"].seeds[1].emails == ()


def test_the_identity_rule():
    tc = parse_team_config(team_config_data(), ALLOWED)
    assert tc.google_identity_allowed("a@example.com", "example.com")
    assert not tc.google_identity_allowed("a@example.com", None)
    assert not tc.google_identity_allowed("a@example.com", "example.org")
    assert not tc.google_identity_allowed("a@example.org", "example.org")
    assert not tc.google_identity_allowed("a@example.org", "example.com")
    unset = parse_team_config(team_config_data())
    assert unset.google_identity_allowed("a@example.net", None)


# A Google ID token through the real verifier, for both audiences ---------------------------------


@pytest.mark.parametrize("audience", [AUDIENCE, GCLOUD_CLIENT])
async def test_the_google_verifier_reads_hd(audience: str):
    endpoint = FakeCertsEndpoint()
    verifier = GoogleVerifier([AUDIENCE, GCLOUD_CLIENT], transport=endpoint, clock=Clock())
    verified = await verifier.verify(make_token(aud=audience, hd="example.com"))
    assert verified.hd == "example.com"
    assert (await verifier.verify(make_token(aud=audience, sub="1234"))).hd is None
    for bad in (["example.com"], 7, True, {"d": 1}):
        with pytest.raises(Unauthenticated) as caught:
            await verifier.verify(make_token(aud=audience, sub=uuid.uuid4().hex, hd=bad))
        assert caught.value.reason == "bad_hd"


@pytest.fixture
async def google_relay():
    data = with_delegates(
        {
            "teams": [
                {
                    "id": "demo",
                    "members": [
                        {"id": "alice", "role": "owner", "principals": ["google:alice@example.com"]}
                    ],
                },
                {
                    "id": "other",
                    "members": [
                        {"id": "dave", "role": "owner", "principals": ["google:dave@example.com"]}
                    ],
                },
            ]
        }
    )
    settings = Settings(
        team_config=parse_team_config(data, ALLOWED),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="google",
        audiences=(AUDIENCE, GCLOUD_CLIENT),
    )
    verifier = GoogleVerifier(
        [AUDIENCE, GCLOUD_CLIENT], transport=FakeCertsEndpoint(), clock=Clock()
    )
    app = create_app(settings, MemoryStore(), verifier=verifier)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as c:
        yield c


def _bearer(token: str, **headers: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", **headers}


@pytest.mark.parametrize("audience", [AUDIENCE, GCLOUD_CLIENT])
async def test_a_google_token_needs_the_domain_and_hd(google_relay: httpx.AsyncClient, audience):
    def tok(**claims: Any) -> str:
        return make_token(aud=audience, sub=uuid.uuid4().hex, **claims)

    ok = tok(email="alice@example.com", hd="example.com")
    r = await google_relay.get("/v1/teams/demo/me", headers=_bearer(ok))
    assert r.status_code == 200 and r.json()["member"] == "alice"
    for path in ("/v1/teams/demo/me", "/v1/me/teams"):
        for bad in (
            tok(email="alice@example.com"),  # a consumer account: no hd
            tok(email="alice@example.com", hd="example.org"),
            tok(email="alice@example.org", hd="example.org"),
            tok(email="alice@example.org", hd="example.com"),
            tok(email="alice@mail.example.com", hd="mail.example.com"),
        ):
            r = await google_relay.get(path, headers=_bearer(bad))
            assert refused(r), (path, r.text)
        # email_verified is required as before, whatever the domain.
        r = await google_relay.get(
            path,
            headers=_bearer(tok(email="alice@example.com", hd="example.com", email_verified=False)),
        )
        assert r.status_code == 401


async def test_the_delegates_own_token_has_no_hd_and_is_exempt(google_relay: httpx.AsyncClient):
    console = make_token(
        email=DELEGATES["demo"].removeprefix("google:"), sub="1" + uuid.uuid4().hex[:20]
    )
    r = await google_relay.get(
        "/v1/teams/demo/me",
        headers=_bearer(console, **{"X-Relay-On-Behalf-Of": "alice@example.com"}),
    )
    assert r.status_code == 200 and r.json()["member"] == "alice"
    r = await google_relay.get(
        "/v1/teams/demo/me",
        headers=_bearer(console, **{"X-Relay-On-Behalf-Of": "alice@example.org"}),
    )
    assert refused(r)


# Through the app: team routes, account routes, delegates ------------------------------------------


@pytest.fixture(params=["memory", "firestore"])
async def api(request: pytest.FixtureRequest, clock: FakeClock):
    def any_team(data: dict[str, Any]) -> None:
        data["delegates"][0]["scope"] = ["read", "manage-roster"]
        data["delegates"].append(
            {
                "principal": DELEGATES["any"],
                "team": "*",
                "scope": ["read", "manage-roster", "manage-teams"],
            }
        )

    async with open_api(request.param, clock, configure=any_team, allowed_domains=ALLOWED) as a:
        yield a


async def test_direct_tokens_on_team_routes(api: Api):
    r = await api.client.get(api.url("/me"), headers=google_headers(EMAILS["alice"], "example.com"))
    assert r.status_code == 200 and r.json()["member"] == "alice"
    r = await api.client.get(api.url("/me"), headers=google_headers(EMAILS["alice"], None))
    assert refused(r)
    r = await api.client.get(api.url("/me"), headers=google_headers(EMAILS["alice"], "example.org"))
    assert refused(r)
    # Static development tokens are not Google identities: unchanged.
    assert (await api.get("bob", "/me")).status_code == 200


async def test_direct_tokens_on_account_routes(api: Api):
    email = new_email()
    r = await api.client.get("/v1/me/teams", headers=google_headers(email, "example.com"))
    assert r.status_code == 200, r.text
    for outside, hd in ((email, None), (new_email("example.net"), "example.net")):
        r = await api.client.get("/v1/me/teams", headers=google_headers(outside, hd))
        assert refused(r)
        r = await api.client.post(
            "/v1/teams",
            json={"name": "Elsewhere", "owner_member_id": "o1"},
            headers=google_headers(outside, hd),
        )
        assert refused(r)
    r = await api.client.post(
        "/v1/teams",
        json={"name": "Ours", "id": "k" + uuid.uuid4().hex[:20], "owner_member_id": "o1"},
        headers=google_headers(new_email(), "example.com"),
    )
    assert r.status_code == 201, r.text


async def test_a_delegate_names_only_allowed_emails(api: Api):
    r = await api.delegated("GET", "/me", EMAILS["alice"])
    assert r.status_code == 200
    for outside in ("alice@example.net", "alice@mail.example.com"):
        r = await api.delegated("GET", "/me", outside)
        assert refused(r)
        headers = {
            "Authorization": f"Bearer {DELEGATE_TOKENS['any']}",
            "X-Relay-On-Behalf-Of": outside,
        }
        r = await api.client.get("/v1/me/teams", headers=headers)
        assert refused(r)
        r = await api.client.post(
            "/v1/teams",
            json={"name": "Elsewhere", "owner_member_id": "o1"},
            headers={**headers, "X-Relay-Client-IP-Hash": "0" * 64},
        )
        assert refused(r)


async def test_roster_adds_and_new_emails_must_be_in_the_domains(api: Api):
    for outside in ("erin@example.net", "erin@mail.example.com"):
        r = await api.post("alice", "/roster", {"member": "erin", "email": outside})
        assert refused(r), r.text
        r = await api.client.patch(
            api.url("/roster/bob"), headers=auth("alice"), json={"add_email": outside}
        )
        assert refused(r), r.text
        # Through the console's delegate for the owner, the same.
        r = await api.delegated("POST", "/roster", json={"member": "erin", "email": outside})
        assert refused(r), r.text
    r = await api.post("alice", "/roster", {"member": "erin", "email": new_email()})
    assert r.status_code == 201, r.text
    roster = (await api.get("alice", "/roster")).json()
    assert "erin" in {m["member"] for m in roster["members"]}


async def test_team_creation_and_invitations_check_the_email(api: Api):
    # The login's create page and its invitation buttons call these with the login's email.
    teams = api.app.state.service.teams
    body = parse_new_team({"name": "Elsewhere", "owner_member_id": "o1"})
    with pytest.raises(ApiError) as caught:
        await teams.create(email="o@example.net", sub="s1", body=body, ip_hash="0" * 32, via=None)
    assert caught.value.body()["error"] == "domain_not_allowed"
    with pytest.raises(ApiError) as caught:
        await teams.answer_invitation(
            api.team, email="o@example.net", sub="s1", accept=True, via=None
        )
    assert caught.value.body()["error"] == "domain_not_allowed"
    # An allowed invitee accepts as before.
    email = new_email()
    r = await api.post("alice", "/roster", {"member": "erin", "email": email})
    assert r.status_code == 201
    token = id_token(email, google_sub(email), "example.com")
    r = await api.client.post(
        f"/v1/me/invitations/{api.team}",
        json={"accept": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200 and r.json()["status"] == "active", r.text


# The login callback -------------------------------------------------------------------------------


async def test_the_login_callback_needs_the_domain_and_hd(api: Api):
    assert api.fake is not None
    for email, claims in (
        (EMAILS["alice"], {}),
        (EMAILS["alice"], {"hd": "example.org"}),
        ("mallory@example.net", {"hd": "example.net"}),
        ("mallory@example.net", {"hd": "example.com"}),
        (EMAILS["alice"], {"hd": ["example.com"]}),
    ):
        started = await start(api.client)
        r = await google(api.client, api.fake, started, email, claims=claims)
        assert r.status_code == 403, (email, claims, r.text)
        assert "organisation" in r.text and email not in r.text
    # email_verified still comes first.
    started = await start(api.client)
    r = await google(
        api.client,
        api.fake,
        started,
        EMAILS["alice"],
        email_verified=False,
        claims={"hd": "example.com"},
    )
    assert r.status_code == 403 and "not verified" in r.text
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["alice"], claims={"hd": "example.com"})
    assert r.status_code == 200, r.text
    assert api.team in team_values(r.text)
    assert hidden_csrf(r.text)


async def test_a_login_with_the_domain_mints_a_working_credential(api: Api):
    assert api.fake is not None
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["bob"], claims={"hd": "example.com"})
    assert r.status_code == 200, r.text
    chooser = Chooser(
        started=started, response=r, csrf=hidden_csrf(r.text), teams=team_values(r.text)
    )
    query = await continue_as(api.client, chooser, api.team)
    minted = await redeem(api.client, query["code"], started.verifier)
    assert minted.status_code == 200, minted.text
    r = await api.client.get(api.url("/me"), headers=bearer(minted.json()["credential"]))
    assert r.status_code == 200 and r.json()["member"] == "bob"


# A device credential minted through an email outside the domains ----------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_credential_minted_before_the_domains_were_set_stops(kind: str, clock: FakeClock):
    async with open_api(kind, clock) as api:  # no domains yet
        outside = new_email("example.org")
        r = await api.post("alice", "/roster", {"member": "erin", "email": outside})
        assert r.status_code == 201, r.text
        await accept_invitation(api.client, api.team, outside)
        erin = (await login(api, email=outside))["credential"]
        bob = (await login(api, "bob"))["credential"]
        for credential in (erin, bob):
            r = await api.client.get(api.url("/me"), headers=bearer(credential))
            assert r.status_code == 200, r.text
        # The same store, now behind a relay with RELAY_ALLOWED_DOMAINS=example.com.
        assert api.settings is not None and api.fake is not None
        settings = replace(
            api.settings, team_config=replace(api.settings.team_config, allowed_domains=ALLOWED)
        )
        app = create_app(
            settings,
            api.store,
            clock=api.clock,
            poll_interval=0.02,
            verifier=DelegateVerifier(),
            oauth=FakeGoogleProvider(api.fake),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=str(api.client.base_url),
            cookies=no_cookie_jar(),
        ) as client:
            r = await client.get(api.url("/me"), headers=bearer(erin))
            assert refused(r), r.text
            r = await client.get(api.url("/me"), headers=bearer(bob))
            assert r.status_code == 200 and r.json()["member"] == "bob"
