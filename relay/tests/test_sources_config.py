"""PICKERS-SPEC §3.5, §3.6, §4.2 (ACC-007, ACC-008 over HTTP, ACC-024's settings half): what
owners pick sources from, on both stores.

- ``GET sources/config``: owners (direct, or the console's delegate on behalf of an owner) get
  whether the GitHub App is set up with its install link and the Google Picker's public settings;
  anyone else ``403``; ``no-store``; never the app's key or a token.
- ``GET sources/github``: the installations of the allowed orgs with their repositories (a fake
  GitHub on ``httpx.MockTransport``); ``404 github_not_configured`` without the app; GitHub's
  failures as ``502``/``503`` with ``Retry-After``; the shared ``source_reads`` budget; the
  ``github_listed`` log line with counts only.
- The mounted files: ``RELAY_GITHUB_APP_FILE`` (PKCS#1 or PKCS#8 RSA, 2048 bits or more,
  unencrypted) and ``RELAY_PICKER_FILE``; anything else stops the relay without quoting the
  file. Throwaway keys and values only."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from relay.app import create_app
from relay.config import PickerConfig, Settings, load_github_app, load_picker
from relay.errors import ConfigError
from relay.github_app import GithubApp
from relay.sources import config_json

from .conftest import (
    EMAILS,
    PUBLIC_URL,
    Api,
    DelegateVerifier,
    auth,
    delegate_auth,
    no_cookie_jar,
    open_api,
)
from .fake_github import APP_ID, SLUG, FakeGithub, app_config, app_key_pem, installation, repo
from .fake_google import FakeGoogleProvider
from .test_deploy_config import _login_env, _write_config

pytestmark = pytest.mark.anyio

ORGS = frozenset({"example-org"})
PICKER = PickerConfig(
    client_id="123456789012-picker.apps.googleusercontent.com",
    api_key="AIza" + "Example0Picker0Key0Only0For0Tests00",
    app_id="123456789012",
)
INSTALL_URL = f"https://github.com/apps/{SLUG}/installations/new"


@asynccontextmanager
async def relay_with(
    api: Api,
    fake: FakeGithub | None,
    *,
    app_set_up: bool = True,
    picker: PickerConfig | None = PICKER,
) -> AsyncIterator[httpx.AsyncClient]:
    """Another relay instance over ``api``'s store with the GitHub App (``fake`` as GitHub) on
    RELAY_GITHUB_ORGS ``example-org`` and the Picker's settings ``picker``."""
    assert api.settings is not None and api.fake is not None
    settings = replace(
        api.settings,
        team_config=replace(api.settings.team_config, allowed_github_orgs=ORGS),
        github_app=app_config() if app_set_up else None,
        picker=picker,
    )
    github = None
    if fake is not None:
        clock = api.clock
        github = GithubApp(
            app_config(), ORGS, transport=fake.transport(), wall=lambda: clock.current.timestamp()
        )
    app = create_app(
        settings,
        api.store,
        clock=api.clock,
        poll_interval=0.02,
        verifier=DelegateVerifier(),
        oauth=FakeGoogleProvider(api.fake),
        github=github,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=PUBLIC_URL, cookies=no_cookie_jar()
        ) as client:
            yield client


def github_fake(api: Api) -> FakeGithub:
    fake = FakeGithub(wall=lambda: api.clock.current.timestamp())
    fake.installations = [
        installation(11, "example-org"),
        installation(12, "someone-else"),
        installation(13, "Example-Org", suspended=True),
    ]
    fake.repos = {11: [repo(7, "web"), repo(3, "api")], 12: [repo(9, "theirs")]}
    return fake


def url(api: Api, path: str) -> str:
    return f"/v1/teams/{api.team}/sources/{path}"


def delegate(on_behalf: str) -> dict[str, str]:
    return delegate_auth(on_behalf)


def assert_no_secret(text: str) -> None:
    assert "PRIVATE KEY" not in text and app_key_pem()[60:120] not in text
    assert "ghs_" not in text and "token" not in text.lower()


# sources/config ---------------------------------------------------------------------------------


def test_the_config_without_settings():
    assert config_json(None) == {
        "github": {"configured": False, "install_url": None},
        "google_picker": None,
    }


async def test_an_owner_gets_the_config(api: Api):
    async with relay_with(api, None) as client:
        for headers in (auth("alice"), delegate(EMAILS["alice"])):
            r = await client.get(url(api, "config"), headers=headers)
            assert r.status_code == 200, r.text
            assert r.headers["cache-control"] == "no-store"
            assert r.json() == {
                "github": {"configured": True, "install_url": INSTALL_URL},
                "google_picker": {
                    "client_id": PICKER.client_id,
                    "api_key": PICKER.api_key,
                    "app_id": PICKER.app_id,
                },
            }
            assert_no_secret(r.text)


async def test_without_the_app_or_the_picker_the_config_says_so(api: Api):
    async with relay_with(api, None, app_set_up=False, picker=None) as client:
        r = await client.get(url(api, "config"), headers=auth("alice"))
    assert r.json() == {"github": {"configured": False, "install_url": None}, "google_picker": None}


@pytest.mark.parametrize("path", ["config", "github"])
async def test_anyone_but_an_owner_is_403(api: Api, path: str):
    fake = github_fake(api)
    async with relay_with(api, fake) as client:
        for headers in (auth("bob"), delegate(EMAILS["bob"])):
            r = await client.get(url(api, path), headers=headers)
            assert (r.status_code, r.json()["error"]) == (403, "forbidden")
            assert r.headers["cache-control"] == "no-store"
            assert "AIza" not in r.text
        # dave is an owner of another team, not of this one.
        r = await client.get(url(api, path), headers=auth("dave"))
        assert r.status_code == 404
    assert not fake.seen  # GitHub is never asked for a non-owner


async def test_a_new_owner_is_an_owner_at_once(api: Api):
    async with relay_with(api, None) as client:
        assert (await client.get(url(api, "config"), headers=auth("bob"))).status_code == 403
        r = await client.patch(
            f"/v1/teams/{api.team}/roster/bob", headers=auth("alice"), json={"role": "owner"}
        )
        assert r.status_code == 200, r.text
        assert (await client.get(url(api, "config"), headers=auth("bob"))).status_code == 200


# sources/github ---------------------------------------------------------------------------------


async def test_an_owner_lists_the_allowed_orgs_repositories(api: Api, capsys):
    fake = github_fake(api)
    async with relay_with(api, fake) as client:
        for headers in (auth("alice"), delegate(EMAILS["alice"])):
            r = await client.get(url(api, "github"), headers=headers)
            assert r.status_code == 200, r.text
            assert r.headers["cache-control"] == "no-store"
            assert r.json() == {
                "installations": [
                    {
                        "account": "example-org",
                        "state": "ok",
                        "repository_selection": "all",
                        "repos": [
                            {"name": "api", "id": 3, "private": True, "archived": False},
                            {"name": "web", "id": 7, "private": True, "archived": False},
                        ],
                        "truncated": False,
                    },
                    {
                        "account": "Example-Org",
                        "state": "suspended",
                        "repository_selection": "all",
                        "repos": [],
                        "truncated": False,
                    },
                ],
                "fetched_at": "2026-09-23T12:00:00.000Z",
            }
            assert "someone-else" not in r.text and "theirs" not in r.text
            assert_no_secret(r.text)
    # Cached: the second read asked GitHub nothing more.
    assert len(fake.calls("GET", "/app/installations")) == 1
    logged = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if '"github_listed"' in line
    ]
    assert len(logged) == 2
    assert {k: logged[0][k] for k in ("team", "member", "installations", "repos")} == {
        "team": api.team,
        "member": "alice",
        "installations": 2,
        "repos": 2,
    }
    assert isinstance(logged[0]["duration_ms"], int)


async def test_without_the_app_the_listing_is_404(api: Api):
    async with relay_with(api, None, app_set_up=False) as client:
        r = await client.get(url(api, "github"), headers=auth("alice"))
    assert (r.status_code, r.json()["error"]) == (404, "github_not_configured")
    assert r.headers["cache-control"] == "no-store"


def _answer(code: int, headers: dict[str, str] | None = None):
    return lambda request: httpx.Response(code, headers=headers or {}, text="ghs_from_github")


@pytest.mark.parametrize(
    "path, failure, status, error, retry_after",
    [
        ("/app/installations", _answer(500), 502, "github_unavailable", None),
        ("/app/installations", _answer(401), 502, "github_app_misconfigured", None),
        (
            "/installation/repositories",
            _answer(429, {"retry-after": "42"}),
            503,
            "github_rate_limited",
            "42",
        ),
        (
            "/installation/repositories",
            _answer(403, {"retry-after": "99999"}),
            503,
            "github_rate_limited",
            "3600",
        ),
    ],
)
async def test_githubs_failures_are_answered_with_their_codes(
    api: Api, path, failure, status, error, retry_after
):
    fake = github_fake(api)
    fake.failures[path] = failure
    async with relay_with(api, fake) as client:
        r = await client.get(url(api, "github"), headers=auth("alice"))
    assert (r.status_code, r.json()["error"]) == (status, error)
    assert r.headers.get("retry-after") == retry_after
    assert r.headers["cache-control"] == "no-store"
    assert "ghs_" not in r.text


async def test_a_timeout_is_502_unavailable(api: Api):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    fake = github_fake(api)
    fake.failures["/app/installations"] = slow
    async with relay_with(api, fake) as client:
        r = await client.get(url(api, "github"), headers=auth("alice"))
    assert (r.status_code, r.json()["error"]) == (502, "github_unavailable")


async def test_both_routes_share_the_source_reads_budget(clock):
    async with open_api("memory", clock, reads_per_minute=3) as api:
        fake = github_fake(api)
        async with relay_with(api, fake) as client:
            for path in ("config", "github", "config"):
                r = await client.get(url(api, path), headers=auth("alice"))
                assert r.status_code == 200, r.text
            r = await client.get(url(api, "github"), headers=auth("alice"))
            assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
            # Counted before the owner check: a non-owner's reads spend their own budget.
            for _ in range(3):
                r = await client.get(url(api, "config"), headers=auth("bob"))
                assert r.status_code == 403
            r = await client.get(url(api, "config"), headers=auth("bob"))
            assert r.status_code == 429


# The mounted files ------------------------------------------------------------------------------


def _write(tmp_path: Path, data: Any, name: str = "app.json") -> Path:
    path = tmp_path / name
    path.write_text(data if isinstance(data, str) else json.dumps(data))
    return path


def _app_file(tmp_path: Path, **changes: Any) -> Path:
    data = {"app_id": APP_ID, "slug": SLUG, "private_key": app_key_pem()}
    return _write(tmp_path, {**data, **changes})


@pytest.mark.parametrize("pkcs8", [True, False])
def test_the_app_file_is_read(tmp_path: Path, pkcs8: bool):
    loaded = load_github_app(_app_file(tmp_path, private_key=app_key_pem(pkcs8)))
    assert (loaded.app_id, loaded.slug, loaded.install_url) == (APP_ID, SLUG, INSTALL_URL)
    assert "PRIVATE" not in repr(loaded)


def _pem(key: Any, password: bytes | None = None) -> str:
    encryption = (
        serialization.BestAvailableEncryption(password)
        if password
        else serialization.NoEncryption()
    )
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, encryption
    ).decode()


@pytest.mark.parametrize(
    "data",
    [
        "not json",
        "[]",
        {"app_id": APP_ID, "slug": SLUG},
        {"app_id": APP_ID, "slug": SLUG, "private_key": "x", "extra": "y"},
        {"app_id": 424242, "slug": SLUG, "private_key": "x"},
        "app_id=abc",
        "slug=Has Space",
        "slug=-leading",
        "private_key=-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
        "small",
        "ec",
        "encrypted",
    ],
)
def test_a_bad_app_file_stops_the_relay_without_quoting_it(tmp_path: Path, data: Any):
    if isinstance(data, str) and data.startswith(("app_id=", "slug=", "private_key=")):
        name, value = data.split("=", 1)
        path = _app_file(tmp_path, **{name: value})
    elif data == "small":
        small = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        path = _app_file(tmp_path, private_key=_pem(small))
    elif data == "ec":
        path = _app_file(tmp_path, private_key=_pem(ec.generate_private_key(ec.SECP256R1())))
    elif data == "encrypted":
        path = _app_file(tmp_path, private_key=_pem(rsa.generate_private_key(65537, 2048), b"pw"))
    else:
        path = _write(tmp_path, data)
    with pytest.raises(ConfigError) as caught:
        load_github_app(path)
    message = str(caught.value)
    assert "BEGIN" not in message and "not a key" not in message and "Has Space" not in message
    assert app_key_pem()[60:120] not in message


def test_a_missing_app_file_stops_the_relay(tmp_path: Path):
    with pytest.raises(ConfigError, match="cannot read the GitHub App file"):
        load_github_app(tmp_path / "absent.json")


def _picker_file(tmp_path: Path, **changes: Any) -> Path:
    data = {"client_id": PICKER.client_id, "api_key": PICKER.api_key, "app_id": PICKER.app_id}
    return _write(tmp_path, {**data, **changes}, "picker.json")


def test_the_picker_file_is_read(tmp_path: Path):
    assert load_picker(_picker_file(tmp_path)) == PICKER


@pytest.mark.parametrize(
    "changes",
    [
        {"client_id": "not-a-client"},
        {"client_id": "x.apps.googleusercontent.com.example.com"},
        {"api_key": "AIzaTooShort"},
        {"api_key": "BIza" + "x" * 35},
        {"app_id": "12345"},
        {"app_id": "12345678901234567890123"},
        {"app_id": 123456789012},
        {"extra": "x"},
    ],
)
def test_a_bad_picker_file_stops_the_relay_without_quoting_it(tmp_path: Path, changes):
    with pytest.raises(ConfigError) as caught:
        load_picker(_picker_file(tmp_path, **changes))
    for value in changes.values():
        if isinstance(value, str) and len(value) > 4:
            assert value not in str(caught.value)


# Settings.from_env ------------------------------------------------------------------------------


def _env(tmp_path: Path, **extra: str) -> dict[str, str]:
    return {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUTH_MODE": "static",
        **extra,
    }


def test_the_env_names_the_app_and_the_picker(tmp_path: Path):
    settings = Settings.from_env(_env(tmp_path))
    assert settings.github_app is None and settings.picker is None
    assert settings.team_config.allowed_github_orgs == frozenset()
    assert settings.team_config.allowed_shared_drives == frozenset()
    settings = Settings.from_env(
        _env(
            tmp_path,
            RELAY_GITHUB_APP_FILE=str(_app_file(tmp_path)),
            RELAY_GITHUB_ORGS=" Example-Org , example-labs",
            RELAY_ALLOWED_SHARED_DRIVES="0AExampleDriveId0PVA,0AOtherDriveId00PVA0",
            RELAY_PICKER_FILE=str(_picker_file(tmp_path)),
        )
    )
    assert settings.github_app is not None and settings.github_app.app_id == APP_ID
    assert settings.picker == PICKER
    assert settings.team_config.allowed_github_orgs == {"example-org", "example-labs"}
    assert settings.team_config.allowed_shared_drives == {
        "0AExampleDriveId0PVA",
        "0AOtherDriveId00PVA0",
    }


def test_the_app_without_an_org_allowlist_refuses_to_start(tmp_path: Path):
    env = _env(tmp_path, RELAY_GITHUB_APP_FILE=str(_app_file(tmp_path)))
    with pytest.raises(ConfigError, match="RELAY_GITHUB_ORGS is required"):
        Settings.from_env(env)
    with pytest.raises(ConfigError, match="RELAY_GITHUB_ORGS is required"):
        Settings.from_env({**env, "RELAY_GITHUB_ORGS": " "})


def test_a_missing_app_or_picker_file_refuses_to_start(tmp_path: Path):
    absent = str(tmp_path / "absent.json")
    with pytest.raises(ConfigError, match="GitHub App"):
        Settings.from_env(_env(tmp_path, RELAY_GITHUB_APP_FILE=absent, RELAY_GITHUB_ORGS="x"))
    with pytest.raises(ConfigError, match="Picker"):
        Settings.from_env(_env(tmp_path, RELAY_PICKER_FILE=absent))


@pytest.mark.parametrize(
    "name, raw",
    [
        ("RELAY_GITHUB_ORGS", "example-org,,other"),
        ("RELAY_GITHUB_ORGS", "-bad-org"),
        ("RELAY_GITHUB_ORGS", "example_org"),
        ("RELAY_GITHUB_ORGS", "a" * 40),
        ("RELAY_ALLOWED_SHARED_DRIVES", "short"),
        ("RELAY_ALLOWED_SHARED_DRIVES", "0AExampleDriveId0PVA,has space here"),
    ],
)
def test_malformed_allowlists_refuse_to_start_without_quoting_them(tmp_path: Path, name, raw):
    with pytest.raises(ConfigError) as caught:
        Settings.from_env(_env(tmp_path, **{name: raw}))
    message = str(caught.value)
    assert name in message
    for entry in raw.split(","):
        if len(entry) > 3:
            assert entry not in message


def test_the_picker_client_is_never_the_login_or_the_drive_client(tmp_path: Path):
    login = _login_env(tmp_path / "login")
    login_id = json.loads(Path(login["RELAY_OAUTH_CLIENT_FILE"]).read_text())["client_id"]
    env = _env(tmp_path, **login)
    # The login client here is "id.example", which no picker file can name; build the clash
    # through the settings themselves.
    settings = Settings.from_env(env)
    assert settings.oauth_client is not None and settings.oauth_client.client_id == login_id
    clash = replace(PICKER, client_id=login_id)
    with pytest.raises(ConfigError, match="picker's own OAuth client"):
        replace(settings, picker=clash)
    drive = replace(settings.oauth_client, client_id=PICKER.client_id)
    with pytest.raises(ConfigError, match="picker's own OAuth client"):
        replace(settings, oauth_client=None, drive_client=drive, picker=PICKER)


def test_the_picker_file_with_the_login_clients_id_refuses_to_start(tmp_path: Path):
    login_dir = tmp_path / "login"
    login_dir.mkdir()
    client = login_dir / "oauth-client.json"
    client.write_text(json.dumps({"client_id": PICKER.client_id, "client_secret": "s3cret"}))
    env = _env(
        tmp_path,
        RELAY_PUBLIC_URL="https://team-relay-test.a.run.app",
        RELAY_OAUTH_CLIENT_FILE=str(client),
        RELAY_PICKER_FILE=str(_picker_file(tmp_path)),
    )
    with pytest.raises(ConfigError) as caught:
        Settings.from_env(env)
    assert "picker" in str(caught.value).lower() and "s3cret" not in str(caught.value)
