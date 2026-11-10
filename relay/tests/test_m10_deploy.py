"""M10-SPEC §5: one address, ``https://team.example.com``, with the console at ``/`` behind
IAP and the relay at ``/v1/*`` behind the same load balancer.

- Every cookie the relay sets or clears is scoped to a path under ``/v1/`` and names no
  ``Domain``, so it never meets IAP's cookies (checked over the whole login flow, its refusals
  and the API, and in the source).
- The relay works at that origin: the login's redirect URI and the chooser's Origin check.
- Behind the load balancer Google appends two ``X-Forwarded-For`` entries (the client's
  address, then the forwarding rule's), so the per-IP limits count the client's entry
  (``RELAY_FORWARDED_FOR_HOPS=2``); a public URL that is not a ``run.app`` one must say how
  many hops there are, on Cloud Run."""

from __future__ import annotations

import ast
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

import httpx
import pytest

from relay.app import create_app
from relay.config import Settings, parse_public_url
from relay.errors import ConfigError
from relay.login import COOKIE_PATH, client_ip

from .conftest import (
    EMAILS,
    Api,
    DelegateVerifier,
    FakeClock,
    google_sub,
    id_token,
    no_cookie_jar,
    open_api,
)
from .fake_google import FakeGoogleProvider
from .login_helpers import (
    callback,
    choose,
    continue_as,
    google,
    start,
    start_query,
    to_chooser,
    token,
)
from .test_deploy_config import _login_env, _write_config
from .test_login import _Req

pytestmark = pytest.mark.anyio

SHARED_ORIGIN = "https://team.example.com"
RELAY_SOURCE = Path(__file__).resolve().parent.parent / "relay"


# Cookies -----------------------------------------------------------------------------------------


class Recorder:
    """An ASGI wrapper that keeps every ``Set-Cookie`` the app sends."""

    def __init__(self, app: Any) -> None:
        self.app = app
        self.cookies: list[str] = []

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        async def capture(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                for name, value in message.get("headers", []):
                    if name.lower() == b"set-cookie":
                        self.cookies.append(value.decode("latin-1"))
            await send(message)

        await self.app(scope, receive, capture)


def _attributes(header: str) -> dict[str, str]:
    jar: SimpleCookie = SimpleCookie()
    jar.load(header)
    assert len(jar) == 1, header
    morsel = next(iter(jar.values()))
    return {k: v for k, v in morsel.items() if v != ""}


async def test_every_cookie_the_relay_sends_stays_under_v1(api: Api):
    assert api.fake is not None
    recorder = Recorder(api.app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=recorder),
        base_url=api.client.base_url,
        cookies=no_cookie_jar(),
    ) as client:
        # The whole flow: start (sets), Google's callback, the chooser's Continue (clears).
        chooser = await to_chooser(client, api.fake, EMAILS["alice"])
        query = await continue_as(client, chooser, api.team)
        assert (await token(client, query["code"], chooser.started.verifier)).status_code == 200
        # The refusals that clear it: a callback whose state is not the cookie's, Cancel.
        started = await start(client)
        r = await callback(client, started, "x", state="not-the-login")
        assert r.status_code == 400
        chooser = await to_chooser(client, api.fake, EMAILS["bob"])
        r = await choose(client, chooser.started.cookie, {"csrf": chooser.csrf, "action": "cancel"})
        assert r.status_code in (200, 303)
        # An account on no team: the create page, then a team created in the flow.
        newcomer = "newcomer-m10@example.com"
        started = await start(client)
        r = await google(client, api.fake, started, newcomer)
        assert r.status_code == 200
        # The API routes set nothing.
        r = await client.get(
            api.url("/me"), headers={"Authorization": "Bearer dev-token-alice-0001"}
        )
        assert r.status_code == 200
    assert recorder.cookies, "the flow set no cookie at all"
    assert any(
        _attributes(h).get("max-age") == "0" or "expires" in _attributes(h)
        for h in recorder.cookies
    )  # a clearing was seen too
    for header in recorder.cookies:
        attributes = _attributes(header)
        assert attributes.get("path", "").startswith("/v1/"), header
        assert "domain" not in attributes, header
        assert attributes.get("secure") is True and attributes.get("httponly") is True, header


def test_the_source_scopes_every_cookie_to_the_login_path():
    assert COOKIE_PATH.startswith("/v1/")
    calls = 0
    for path in sorted(RELAY_SOURCE.glob("*.py")):
        source = path.read_text()
        assert "set-cookie" not in source.lower().replace("set_cookie", ""), path.name
        for node in ast.walk(ast.parse(source)):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("set_cookie", "delete_cookie")
            ):
                calls += 1
                paths = [k.value for k in node.keywords if k.arg == "path"]
                assert len(paths) == 1, f"{path.name}:{node.lineno} names no path"
                value = paths[0]
                assert isinstance(value, ast.Name) and value.id == "COOKIE_PATH", (
                    f"{path.name}:{node.lineno}"
                )
                assert not [k for k in node.keywords if k.arg == "domain"], path.name
    assert calls >= 2


# The public URL ----------------------------------------------------------------------------------


def test_the_shared_origin_is_a_public_url():
    assert parse_public_url(SHARED_ORIGIN, {"K_SERVICE": "team-relay"}) == SHARED_ORIGIN
    assert parse_public_url(SHARED_ORIGIN + "/", {"K_SERVICE": "team-relay"}) == SHARED_ORIGIN
    with pytest.raises(ConfigError):
        parse_public_url(SHARED_ORIGIN + "/v1", {"K_SERVICE": "team-relay"})


@asynccontextmanager
async def relay_as(
    kind: str,
    clock: FakeClock,
    *,
    base_url: str | None = None,
    cloud_run: pytest.MonkeyPatch | None = None,
    **changes: Any,
) -> AsyncIterator[tuple[Api, httpx.AsyncClient]]:
    """A relay over a fresh ``kind`` store with its settings changed by ``changes``; with
    ``cloud_run`` it believes it runs on Cloud Run (the test verifier is made before)."""
    async with open_api(kind, clock, **changes.pop("limits", {})) as api:
        assert api.settings is not None and api.fake is not None
        verifier = DelegateVerifier()
        if cloud_run is not None:
            cloud_run.setenv("K_SERVICE", "team-relay")
        app = create_app(
            replace(api.settings, **changes),
            api.store,
            clock=api.clock,
            poll_interval=0.02,
            verifier=verifier,
            oauth=FakeGoogleProvider(api.fake),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=base_url or str(api.client.base_url),
            cookies=no_cookie_jar(),
        ) as client:
            yield api, client


async def test_the_login_works_at_the_shared_origin(kind: str, clock: FakeClock):
    origin = SHARED_ORIGIN
    async with relay_as(kind, clock, base_url=origin, public_url=origin) as (api, client):
        assert api.fake is not None
        started = await start(client)
        assert started.params["redirect_uri"] == f"{SHARED_ORIGIN}/v1/login/callback"
        chooser = await to_chooser(client, api.fake, EMAILS["alice"])
        # The browser posts the chooser from the shared host: accepted.
        fields = {"csrf": chooser.csrf, "team": api.team, "action": "continue"}
        r = await choose(client, chooser.started.cookie, fields, headers={"Origin": SHARED_ORIGIN})
        assert r.status_code == 303, r.text
        # The run.app address is another origin now: refused.
        chooser = await to_chooser(client, api.fake, EMAILS["alice"])
        fields = {"csrf": chooser.csrf, "team": api.team, "action": "continue"}
        r = await choose(
            client,
            chooser.started.cookie,
            fields,
            headers={"Origin": "https://team-relay-abc123-ts.a.run.app"},
        )
        assert r.status_code == 403


@pytest.fixture(params=["memory", "firestore"])
def kind(request: pytest.FixtureRequest) -> str:
    return request.param


# The client's address behind the load balancer ---------------------------------------------------


LB = [("x-forwarded-for", "6.6.6.6, 203.0.113.9, 34.120.1.2")]


@pytest.mark.parametrize(
    "headers, hops, expected",
    [
        # Directly on Cloud Run: the right-most entry, its front end's.
        (LB, 1, "34.120.1.2"),
        # Behind the load balancer: the client's entry, left of the forwarding rule's.
        (LB, 2, "203.0.113.9"),
        ([("x-forwarded-for", "203.0.113.9"), ("x-forwarded-for", "34.120.1.2")], 2,
         "203.0.113.9"),
        ([("x-forwarded-for", "2001:db8:1:2:3:4:5:6, 34.120.1.2")], 2, "2001:db8:1:2::/64"),
        # Fewer entries than the hops Google adds: not a request the balancer passed.
        ([("x-forwarded-for", "34.120.1.2")], 2, "unknown"),
        ([], 2, "unknown"),
    ],
)  # fmt: skip
def test_client_ip_behind_the_load_balancer(headers, hops, expected):
    assert client_ip(_Req(headers, "169.254.1.1"), True, hops) == expected  # type: ignore[arg-type]
    # Off Cloud Run the header is still ignored.
    assert client_ip(_Req(headers, "127.0.0.1"), False, hops) == "127.0.0.1"  # type: ignore[arg-type]


def _env(tmp_path: Path, public_url: str, **extra: str) -> dict[str, str]:
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUDIENCE": "aud.example",
        "K_SERVICE": "team-relay",
        **_login_env(tmp_path / "login"),
        "RELAY_PUBLIC_URL": public_url,
        **extra,
    }
    return env


def test_the_hops_come_from_the_env(tmp_path: Path):
    settings = Settings.from_env(_env(tmp_path, SHARED_ORIGIN, RELAY_FORWARDED_FOR_HOPS="2"))
    assert settings.forwarded_for_hops == 2
    run_app = "https://team-relay-abc123-ts.a.run.app"
    assert Settings.from_env(_env(tmp_path, run_app)).forwarded_for_hops == 1
    for bad in ("0", "4", "x", "1.5", " 2", "²"):
        with pytest.raises(ConfigError):
            Settings.from_env(_env(tmp_path, SHARED_ORIGIN, RELAY_FORWARDED_FOR_HOPS=bad))


def test_a_custom_domain_on_cloud_run_must_say_its_hops(tmp_path: Path):
    with pytest.raises(ConfigError) as caught:
        Settings.from_env(_env(tmp_path, SHARED_ORIGIN))
    assert "RELAY_FORWARDED_FOR_HOPS" in str(caught.value)
    # Off Cloud Run (local development) nothing reads the header: no need to say.
    env = _env(tmp_path, "http://127.0.0.1:8080")
    del env["K_SERVICE"]
    env["RELAY_AUTH_MODE"] = "static"
    assert Settings.from_env(env).forwarded_for_hops == 1


async def test_two_clients_behind_one_balancer_have_their_own_login_budgets(
    clock: FakeClock, monkeypatch: pytest.MonkeyPatch
):
    limits = {"login_starts_per_minute": 2}
    async with relay_as(
        "memory", clock, cloud_run=monkeypatch, limits=limits, forwarded_for_hops=2
    ) as (_, client):
        query = start_query()[0]
        for client_address in ("198.51.100.1", "198.51.100.2"):
            headers = {"x-forwarded-for": f"{client_address}, 34.120.1.2"}
            for _ in range(2):
                r = await client.get("/v1/login/start", params=query, headers=headers)
                assert r.status_code == 302, r.text
            r = await client.get("/v1/login/start", params=query, headers=headers)
            assert r.status_code == 429


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_two_clients_behind_one_balancer_have_their_own_creation_budgets(
    kind: str, clock: FakeClock, monkeypatch: pytest.MonkeyPatch
):
    """M10-SPEC §7.7: ``POST /v1/teams`` counts the per-address limit with the hop count too,
    not the balancer's own (right-most) address."""
    clock.current = clock.current.replace(minute=0, second=0)
    limits = {"team_creations_per_ip_per_hour": 1}
    async with relay_as(
        kind, clock, cloud_run=monkeypatch, limits=limits, forwarded_for_hops=2
    ) as (_, client):
        # Unique per run: the Firestore tests share one emulator and one fake hour.
        balancer = f"34.120.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        for n in range(2):
            client_address = f"198.51.{uuid.uuid4().int % 250}.{n + 1}"
            headers = {"x-forwarded-for": f"{client_address},{balancer}"}

            async def create(headers: dict[str, str] = headers) -> httpx.Response:
                email = f"u{uuid.uuid4().hex[:16]}@example.com"
                return await client.post(
                    "/v1/teams",
                    json={"name": "N", "id": "k" + uuid.uuid4().hex[:20], "owner_member_id": "o1"},
                    headers={
                        **headers,
                        "Authorization": f"Bearer {id_token(email, google_sub(email))}",
                    },
                )

            r = await create()
            assert r.status_code == 201, r.text
            r = await create()
            assert r.status_code == 429 and "this address" in r.json()["detail"], r.text
