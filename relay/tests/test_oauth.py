"""The relay's Google sign-in client (M5-SPEC §2 step 3, §5): the fixed endpoints, the token
exchange, the ID token's verification (RS256 over the JWKS, iss, aud, azp, exp, iat), the
JWKS cache; the OAuth client file and RELAY_PUBLIC_URL; and the fake-OAuth launcher the
plugin's e2e runs. Throwaway keys and synthetic identities only; nothing reaches the
network."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from relay.app import create_app
from relay.config import (
    OAuthClient,
    Settings,
    load_oauth_client,
    load_schema,
    parse_public_url,
    parse_team_config,
)
from relay.errors import ConfigError
from relay.oauth import (
    GOOGLE_AUTHORIZATION_ENDPOINT,
    GOOGLE_JWKS_URL,
    GOOGLE_TOKEN_ENDPOINT,
    GoogleOAuthProvider,
    HttpResponse,
    OAuthError,
    pkce_challenge,
)
from relay.store_memory import MemoryStore

from .conftest import SCHEMA_PATH, TOKENS, principal, team_config_data
from .fake_google import CLIENT_ID, CLIENT_SECRET, FakeGoogle, b64url
from .login_helpers import hidden_csrf, start_query

pytestmark = pytest.mark.anyio

NOW = 1_790_000_000.0


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> float:
        return self.now


def _provider(fake: FakeGoogle, transport: Any = None) -> GoogleOAuthProvider:
    return GoogleOAuthProvider(
        OAuthClient(client_id=fake.client_id, client_secret=fake.client_secret),
        transport=transport or fake.transport,
        clock=fake.clock,
    )


def _claims(fake: FakeGoogle, **changes: Any) -> dict[str, Any]:
    now = int(fake.clock())
    claims = {
        "iss": "https://accounts.google.com",
        "aud": fake.client_id,
        "azp": fake.client_id,
        "email": "alice@example.com",
        "email_verified": True,
        "nonce": "n",
        "iat": now,
        "exp": now + 3600,
    }
    claims.update(changes)
    return {k: v for k, v in claims.items() if v is not None}


@pytest.fixture
def clock() -> Clock:  # type: ignore[override]
    return Clock()


@pytest.fixture
def fake(clock: Clock) -> FakeGoogle:
    return FakeGoogle(clock=clock)


# The fixed endpoints ------------------------------------------------------------------------


def test_googles_endpoints_are_fixed_in_code():
    assert GOOGLE_AUTHORIZATION_ENDPOINT == "https://accounts.google.com/o/oauth2/v2/auth"
    assert GOOGLE_TOKEN_ENDPOINT == "https://oauth2.googleapis.com/token"
    assert GOOGLE_JWKS_URL == "https://www.googleapis.com/oauth2/v3/certs"
    provider = GoogleOAuthProvider(OAuthClient("id", "secret"))
    assert provider.authorization_endpoint == GOOGLE_AUTHORIZATION_ENDPOINT
    assert provider.token_endpoint == GOOGLE_TOKEN_ENDPOINT
    assert provider.jwks_url == GOOGLE_JWKS_URL


def test_the_authorization_url():
    provider = GoogleOAuthProvider(OAuthClient("id.apps.googleusercontent.com", "secret"))
    url = provider.authorization_url(
        redirect_uri="https://relay.example.com/v1/login/callback",
        state="S" * 43,
        nonce="N" * 43,
        code_challenge="C" * 43,
    )
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == GOOGLE_AUTHORIZATION_ENDPOINT
    assert {k: v for k, (v,) in parse_qs(parts.query).items()} == {
        "client_id": "id.apps.googleusercontent.com",
        "redirect_uri": "https://relay.example.com/v1/login/callback",
        "response_type": "code",
        "scope": "openid email",
        "state": "S" * 43,
        "nonce": "N" * 43,
        "code_challenge": "C" * 43,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    assert "secret" not in url


def test_pkce_challenge_is_rfc_7636_s256():
    # RFC 7636 Appendix B.
    assert (
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    )


# The token exchange ----------------------------------------------------------------------------


async def test_the_exchange_sends_the_code_the_secret_and_the_verifier(fake: FakeGoogle):
    seen: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def transport(method, url, headers, body):
        seen.append((method, url, dict(headers), body))
        return fake.transport(method, url, headers, body)

    verifier = "V" * 43
    params = {
        "nonce": "n",
        "code_challenge": pkce_challenge(verifier),
        "redirect_uri": "https://r/cb",
    }
    code = fake.authorize(params, "alice@example.com")
    id_token = await _provider(fake, transport).exchange(
        code=code, redirect_uri="https://r/cb", code_verifier=verifier
    )
    method, url, headers, body = seen[0]
    assert (method, url) == ("POST", GOOGLE_TOKEN_ENDPOINT)
    assert headers["Content-Type"] == "application/x-www-form-urlencoded"
    form = {k: v for k, (v,) in parse_qs((body or b"").decode()).items()}
    assert form == {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": "https://r/cb",
        "code_verifier": verifier,
    }
    assert id_token.count(".") == 2


@pytest.mark.parametrize(
    "response, reason",
    [
        (HttpResponse(400, {}, b'{"error": "invalid_grant"}'), "token_status_400"),
        (HttpResponse(500, {}, b""), "token_status_500"),
        (HttpResponse(200, {}, b"not json"), "token_not_json"),
        (HttpResponse(200, {}, b"[]"), "no_id_token"),
        (HttpResponse(200, {}, b'{"id_token": 5}'), "no_id_token"),
        (HttpResponse(200, {}, b'{"access_token": "x"}'), "no_id_token"),
    ],
)
async def test_a_failed_exchange(fake: FakeGoogle, response: HttpResponse, reason: str):
    provider = _provider(fake, lambda *a: response)
    with pytest.raises(OAuthError) as exc:
        await provider.exchange(code="c", redirect_uri="https://r/cb", code_verifier="V" * 43)
    assert exc.value.reason == reason


async def test_an_unreachable_google_never_echoes_the_error(fake: FakeGoogle):
    def transport(*args):
        raise RuntimeError(f"connection refused; secret={CLIENT_SECRET}")

    with pytest.raises(OAuthError) as exc:
        await _provider(fake, transport).exchange(
            code="c", redirect_uri="https://r/cb", code_verifier="V" * 43
        )
    assert exc.value.reason == "google_unreachable" and CLIENT_SECRET not in str(exc.value)


# The ID token ----------------------------------------------------------------------------------


async def test_a_valid_id_token(fake: FakeGoogle):
    claims = await _provider(fake).verify_id_token(fake.sign(_claims(fake)))
    assert claims["email"] == "alice@example.com" and claims["nonce"] == "n"


@pytest.mark.parametrize(
    "changes, reason",
    [
        ({"iss": "https://evil.example"}, "wrong_issuer"),
        ({"iss": None}, "wrong_issuer"),
        ({"aud": "other-client"}, "wrong_audience"),
        ({"aud": [CLIENT_ID]}, "wrong_audience"),
        ({"aud": None}, "wrong_audience"),
        ({"azp": "other-client"}, "wrong_azp"),
        ({"exp": int(NOW)}, "expired"),
        ({"exp": int(NOW) - 1}, "expired"),
        ({"exp": True}, "bad_times"),
        ({"exp": "9999999999"}, "bad_times"),
        ({"exp": None}, "bad_times"),
        ({"iat": None}, "bad_times"),
        ({"iat": int(NOW) + 61}, "issued_in_the_future"),
    ],
)
async def test_the_claims_are_checked(fake: FakeGoogle, changes: dict[str, Any], reason: str):
    with pytest.raises(OAuthError) as exc:
        await _provider(fake).verify_id_token(fake.sign(_claims(fake, **changes)))
    assert exc.value.reason == reason


async def test_a_small_clock_skew_is_accepted(fake: FakeGoogle):
    await _provider(fake).verify_id_token(fake.sign(_claims(fake, iat=int(NOW) + 60)))
    await _provider(fake).verify_id_token(fake.sign(_claims(fake, azp=None)))  # azp optional


async def test_the_signature_and_the_header_are_checked(fake: FakeGoogle):
    provider = _provider(fake)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    good = fake.sign(_claims(fake))
    head, payload, _ = good.split(".")
    forged_payload = b64url(json.dumps(_claims(fake, email="mallory@example.com")).encode())
    cases = {
        "bad_signature": [
            fake.sign(_claims(fake), key=other_key),
            f"{head}.{forged_payload}.{good.split('.')[2]}",
        ],
        "wrong_alg": [
            fake.sign(_claims(fake), header={"alg": "none"}),
            fake.sign(_claims(fake), header={"alg": "HS256"}),
            fake.sign(_claims(fake), header={"alg": "RS512"}),
        ],
        "no_kid": [
            fake.sign(_claims(fake), header={"kid": None}),
            fake.sign(_claims(fake), header={"kid": 5}),
        ],
        "malformed_id_token": [
            "",
            "a.b",
            "a.b.c.d",
            "!!.!!.!!",
            f"{b64url(b'[]')}.{payload}.sig",
            "x" * 5000,
        ],
    }
    for reason, tokens in cases.items():
        for token in tokens:
            with pytest.raises(OAuthError) as exc:
                await provider.verify_id_token(token)
            assert exc.value.reason == reason, (reason, token[:40])


async def test_the_jwks_is_cached_and_an_unknown_kid_refetches_at_most_every_5_minutes(
    fake: FakeGoogle, clock: Clock
):
    provider = _provider(fake)
    for _ in range(3):
        await provider.verify_id_token(fake.sign(_claims(fake)))
    assert fake.jwks_calls == 1
    unknown = fake.sign(_claims(fake), header={"kid": "rotated"})
    with pytest.raises(OAuthError) as exc:
        await provider.verify_id_token(unknown)
    assert exc.value.reason == "unknown_kid" and fake.jwks_calls == 1  # too soon to refetch
    clock.now += 300
    with pytest.raises(OAuthError):
        await provider.verify_id_token(unknown)
    assert fake.jwks_calls == 2
    clock.now += 3600  # the cached set expires (max-age=3600)
    await provider.verify_id_token(fake.sign(_claims(fake)))
    assert fake.jwks_calls == 3


@pytest.mark.parametrize(
    "response",
    [
        HttpResponse(500, {}, b"{}"),
        HttpResponse(200, {}, b"not json"),
        HttpResponse(200, {}, b'{"keys": {}}'),
        HttpResponse(200, {}, b'{"keys": []}'),
        HttpResponse(200, {}, b'{"keys": [{"kty": "EC", "kid": "k"}]}'),
        HttpResponse(200, {}, b'{"keys": [{"kty": "RSA", "kid": "k", "n": "!", "e": "AQAB"}]}'),
    ],
)
async def test_an_unusable_jwks_is_refused(fake: FakeGoogle, response: HttpResponse):
    provider = _provider(fake, lambda *a: response)
    with pytest.raises(OAuthError) as exc:
        await provider.verify_id_token(fake.sign(_claims(fake)))
    assert exc.value.reason in ("jwks_unavailable", "jwks_invalid")


# The OAuth client file and the public URL -------------------------------------------------


def test_the_oauth_client_file(tmp_path: Path):
    path = tmp_path / "client.json"
    path.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret", "x": 1}))
    client = load_oauth_client(path)
    assert (client.client_id, client.client_secret) == ("id.example", "s3cret")
    assert "s3cret" not in repr(client)


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        "[]",
        json.dumps({"client_id": "id"}),
        json.dumps({"client_secret": "s3cret-value"}),
        json.dumps({"client_id": "", "client_secret": "s3cret-value"}),
        json.dumps({"client_id": "id", "client_secret": "has space s3cret-value"}),
        json.dumps({"web": {"client_id": "id", "client_secret": "s3cret-value"}}),
    ],
)
def test_a_bad_oauth_client_file_is_a_startup_error(tmp_path: Path, content: str):
    path = tmp_path / "client.json"
    path.write_text(content)
    with pytest.raises(ConfigError) as exc:
        load_oauth_client(path)
    assert "s3cret-value" not in str(exc.value)
    with pytest.raises(ConfigError, match="cannot read"):
        load_oauth_client(tmp_path / "missing.json")


@pytest.mark.parametrize(
    "raw, env, expected",
    [
        ("https://relay.example.com", {}, "https://relay.example.com"),
        ("https://relay.example.com/", {}, "https://relay.example.com"),
        ("https://relay.example.com:8443", {}, "https://relay.example.com:8443"),
        ("https://relay.example.com", {"K_SERVICE": "r"}, "https://relay.example.com"),
        ("http://127.0.0.1:8090", {}, "http://127.0.0.1:8090"),
        ("http://localhost:8090", {}, "http://localhost:8090"),
    ],
)
def test_the_public_url(raw: str, env: dict[str, str], expected: str):
    assert parse_public_url(raw, env) == expected


@pytest.mark.parametrize(
    "raw, env",
    [
        ("http://relay.example.com", {}),
        ("http://127.0.0.1:8090", {"K_SERVICE": "r"}),
        ("ftp://relay.example.com", {}),
        ("relay.example.com", {}),
        ("https://relay.example.com/v1", {}),
        ("https://relay.example.com?x=1", {}),
        ("https://relay.example.com#f", {}),
        ("https://user:pw@relay.example.com", {}),
        ("https://", {}),
        ("https://relay.example.com:99999", {}),
        ("https://[::1]:8443", {}),
    ],
)
def test_a_bad_public_url_is_a_startup_error(raw: str, env: dict[str, str]):
    with pytest.raises(ConfigError, match="RELAY_PUBLIC_URL"):
        parse_public_url(raw, env)


def _config_file(tmp_path: Path) -> str:
    path = tmp_path / "team.yaml"
    path.write_text(json.dumps(team_config_data()))
    return str(path)


def _client_file(tmp_path: Path) -> str:
    path = tmp_path / "client.json"
    path.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret"}))
    return str(path)


def test_the_login_settings_go_together_and_are_required_on_cloud_run(tmp_path: Path):
    base = {"RELAY_TEAM_CONFIG": _config_file(tmp_path), "RELAY_AUDIENCE": "https://r.example"}
    assert Settings.from_env(base).login_enabled is False
    both = {
        **base,
        "RELAY_PUBLIC_URL": "https://r.example/",
        "RELAY_OAUTH_CLIENT_FILE": _client_file(tmp_path),
    }
    settings = Settings.from_env(both)
    assert settings.public_url == "https://r.example"
    assert settings.oauth_client == OAuthClient("id.example", "s3cret")
    for name in ("RELAY_PUBLIC_URL", "RELAY_OAUTH_CLIENT_FILE"):
        with pytest.raises(ConfigError, match="go together"):
            Settings.from_env({k: v for k, v in both.items() if k != name})
    with pytest.raises(ConfigError, match="required on Cloud Run"):
        Settings.from_env({**base, "K_SERVICE": "team-relay"})
    # M10-SPEC §5: a public URL that is not a run.app one says how many hops Google adds.
    on_cloud_run = {**both, "K_SERVICE": "team-relay", "RELAY_FORWARDED_FOR_HOPS": "1"}
    assert Settings.from_env(on_cloud_run).login_enabled


def test_the_app_builds_googles_provider_from_the_settings_only():
    base = dict(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
        public_url="https://r.example",
    )
    with pytest.raises(ConfigError, match="OAuth client"):
        create_app(Settings(**base), MemoryStore())  # type: ignore[arg-type]
    create_app(
        Settings(**base, oauth_client=OAuthClient("id.example", "s3cret")),  # type: ignore[arg-type]
        MemoryStore(),
    )


# The fake OAuth launcher (tests/fake_oauth_app.py) ----------------------------------------


def _launcher_config(tmp_path: Path) -> str:
    data = team_config_data()
    path = tmp_path / "team.yaml"
    path.write_text(json.dumps(data))
    return str(path)


async def test_the_launcher_runs_the_whole_flow_headlessly(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    from .fake_oauth_app import build_app

    app = build_app(_launcher_config(tmp_path), 8090, "alice@example.com")
    base = "http://127.0.0.1:8090"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=base) as c:
        query, verifier, state = start_query(port=51000)
        r = await c.get("/v1/login/start", params=query)
        assert r.status_code == 302
        cookie = re.match(r"trl=([^;]+)", r.headers["set-cookie"]).group(1)  # type: ignore[union-attr]
        authorize = r.headers["location"]
        assert authorize.startswith(f"{base}/__fake_google/authorize?")
        r = await c.get(authorize + "&email=Bob@Example.com")  # the override
        assert r.status_code == 302
        assert r.headers["location"].startswith(f"{base}/v1/login/callback?")
        r = await c.get(r.headers["location"], headers={"Cookie": f"trl={cookie}"})
        assert r.status_code == 200 and "bob@example.com" in r.text
        r = await c.post(
            "/v1/login/choose",
            content=f"csrf={hidden_csrf(r.text)}&team=demo&action=continue",
            headers={
                "Cookie": f"trl={cookie}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        assert r.status_code == 303
        location = urlsplit(r.headers["location"])
        assert (location.scheme, location.netloc, location.path) == (
            "http",
            "127.0.0.1:51000",
            "/callback",
        )
        got = {k: v for k, (v,) in parse_qs(location.query).items()}
        assert got["state"] == state
        r = await c.post("/v1/login/token", json={"code": got["code"], "code_verifier": verifier})
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["team"], body["member"], body["relay_url"]) == ("demo", "bob", base)
        r = await c.get(
            "/v1/teams/demo/me", headers={"Authorization": f"Bearer {body['credential']}"}
        )
        assert r.json()["member"] == "bob"
        # The file's static tokens work as in static mode.
        r = await c.get("/v1/teams/demo/me", headers={"Authorization": f"Bearer {TOKENS['alice']}"})
        assert r.json()["member"] == "alice"
        assert principal(TOKENS["alice"]).startswith("token:")


async def test_the_launcher_authorize_page(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    from .fake_oauth_app import build_app

    app = build_app(_launcher_config(tmp_path), 8091, None)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8091"
    ) as c:
        query, _, _ = start_query()
        r = await c.get("/v1/login/start", params=query)
        cookie = re.match(r"trl=([^;]+)", r.headers["set-cookie"]).group(1)  # type: ignore[union-attr]
        authorize = r.headers["location"]
        assert (await c.get(authorize)).status_code == 400  # no email anywhere
        evil = authorize.replace("redirect_uri=", "redirect_uri=https%3A%2F%2Fevil.example")
        assert (await c.get(evil)).status_code == 400  # only this relay's callback
        r = await c.get(authorize + "&email=alice@example.com&email_verified=false")
        assert r.status_code == 302
        r = await c.get(r.headers["location"], headers={"Cookie": f"trl={cookie}"})
        assert r.status_code == 403 and "not verified" in r.text


def test_the_launcher_refuses_cloud_run(tmp_path: Path, monkeypatch):
    from .fake_oauth_app import build_app

    monkeypatch.setenv("K_SERVICE", "team-relay")
    with pytest.raises(ConfigError, match="Cloud Run"):
        build_app(_launcher_config(tmp_path), 8090, None)


async def test_the_launcher_mints_google_id_tokens_for_the_account_routes(
    tmp_path: Path, monkeypatch
):
    """M9: the e2e needs Google identities (creating a team, /v1/me/teams, an admin, the
    any-team delegate); the launcher mints fake-signed ID tokens and accepts them."""
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    from .fake_oauth_app import build_app

    data = team_config_data()
    data["admins"] = ["google:root@example.com"]
    data["delegates"] = [
        {
            "principal": "google:console@example-project.iam.gserviceaccount.com",
            "team": "*",
            "scope": ["read", "manage-roster", "manage-teams"],
        }
    ]
    path = tmp_path / "team.yaml"
    path.write_text(json.dumps(data))
    app = build_app(str(path), 8092, None)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8092"
    ) as c:

        async def token_for(email: str) -> dict[str, str]:
            r = await c.get("/__fake_google/id_token", params={"email": email})
            assert r.status_code == 200
            return {"Authorization": f"Bearer {r.json()['id_token']}"}

        assert (await c.get("/__fake_google/id_token")).status_code == 400
        erin = await token_for("Erin@Example.com")
        r = await c.post(
            "/v1/teams",
            json={"id": "erins", "name": "Erin's", "owner_member_id": "erin"},
            headers=erin,
        )
        assert r.status_code == 201, r.text
        r = await c.get("/v1/me/teams", headers=erin)
        assert [t["team"] for t in r.json()["teams"]] == ["erins"]
        r = await c.get("/v1/teams/erins/me", headers=erin)
        assert r.json()["role"] == "owner"
        console = await token_for("console@example-project.iam.gserviceaccount.com")
        r = await c.get(
            "/v1/teams/erins/roster",
            headers={**console, "X-Relay-On-Behalf-Of": "erin@example.com"},
        )
        assert r.status_code == 200
        r = await c.get("/v1/admin/teams", headers=await token_for("root@example.com"))
        assert "erins" in [t["id"] for t in r.json()["teams"]]
        # A tampered token is refused; static tokens still work.
        bad = erin["Authorization"][:-4] + "AAAA"
        assert (await c.get("/v1/me/teams", headers={"Authorization": bad})).status_code == 401
        r = await c.get("/v1/teams/demo/me", headers={"Authorization": f"Bearer {TOKENS['bob']}"})
        assert r.json()["member"] == "bob"
