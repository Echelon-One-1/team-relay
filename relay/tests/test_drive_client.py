"""M10-SPEC §2a: the Desktop OAuth client for Drive, served to active members from an optional
mounted file (``RELAY_DRIVE_CLIENT_FILE``). Google's downloaded "installed" shape and a flat
``{client_id, client_secret}`` are read; anything else stops the relay at startup; a missing
file or no setting is ``404 drive_not_configured``. The secret is never logged. Throwaway
values only."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from relay.app import create_app
from relay.config import OAuthClient, Settings, load_drive_client
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import (
    EMAILS,
    DelegateVerifier,
    FakeClock,
    accept_invitation,
    auth,
    delegate_auth,
    id_token,
)
from .test_deploy_config import _login_env, _write_config

pytestmark = pytest.mark.anyio

CLIENT_ID = "1234-drive.apps.googleusercontent.com"
SECRET = "GOCSPX-drive-" + uuid.uuid4().hex  # unique, so a log search cannot match by luck

INSTALLED = {
    "installed": {
        "client_id": CLIENT_ID,
        "project_id": "example-project",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_secret": SECRET,
        "redirect_uris": ["http://localhost"],
    }
}


def _write(tmp_path: Path, data: Any, name: str = "client.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(data) if not isinstance(data, str) else data)
    return path


# Reading the file ---------------------------------------------------------------------------------


def test_googles_installed_shape_is_read(tmp_path: Path):
    client = load_drive_client(_write(tmp_path, INSTALLED))
    assert client == OAuthClient(client_id=CLIENT_ID, client_secret=SECRET)
    assert SECRET not in repr(client)


def test_a_flat_shape_is_read(tmp_path: Path):
    path = _write(tmp_path, {"client_id": CLIENT_ID, "client_secret": SECRET})
    assert load_drive_client(path) == OAuthClient(CLIENT_ID, SECRET)


def test_a_missing_file_is_not_configured(tmp_path: Path):
    assert load_drive_client(tmp_path / "absent.json") is None


@pytest.mark.parametrize(
    "data",
    [
        "not json",
        "[]",
        {},
        {"installed": "x"},
        {"installed": {"client_id": CLIENT_ID}},
        {"installed": {"client_secret": SECRET}},
        {"installed": {"client_id": CLIENT_ID, "client_secret": "has space"}},
        {"client_id": CLIENT_ID},
        {"client_id": 5, "client_secret": SECRET},
        {"client_id": "", "client_secret": SECRET},
        # A web client's secret is confidential: it is never handed to members.
        {"web": {"client_id": CLIENT_ID, "client_secret": SECRET}},
        {"installed": INSTALLED["installed"], "web": {"client_id": "x", "client_secret": "y"}},
    ],
)
def test_anything_else_stops_the_relay_without_quoting_the_file(tmp_path: Path, data: Any):
    with pytest.raises(ConfigError) as caught:
        load_drive_client(_write(tmp_path, data))
    assert SECRET not in str(caught.value) and CLIENT_ID not in str(caught.value)


def test_the_env_names_the_file(tmp_path: Path):
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUTH_MODE": "static"}
    assert Settings.from_env(env).drive_client is None
    env["RELAY_DRIVE_CLIENT_FILE"] = str(tmp_path / "absent.json")
    assert Settings.from_env(env).drive_client is None
    env["RELAY_DRIVE_CLIENT_FILE"] = str(_write(tmp_path, INSTALLED))
    assert Settings.from_env(env).drive_client == OAuthClient(CLIENT_ID, SECRET)
    env["RELAY_DRIVE_CLIENT_FILE"] = str(_write(tmp_path, "{", "bad.json"))
    with pytest.raises(ConfigError):
        Settings.from_env(env)


def test_the_login_client_is_never_served_as_the_drive_client(tmp_path: Path):
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUTH_MODE": "static",
        **_login_env(tmp_path / "login"),
    }
    login_client = json.loads(Path(env["RELAY_OAUTH_CLIENT_FILE"]).read_text())
    env["RELAY_DRIVE_CLIENT_FILE"] = str(_write(tmp_path, login_client, "same.json"))
    with pytest.raises(ConfigError) as caught:
        Settings.from_env(env)
    assert "drive" in str(caught.value).lower()


# The endpoint -------------------------------------------------------------------------------------


@asynccontextmanager
async def relay(
    settings: Settings, drive: OAuthClient | None, clock: FakeClock
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        replace(settings, drive_client=drive),
        MemoryStore(),
        clock=clock,
        poll_interval=0.02,
        verifier=DelegateVerifier(),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as client:
        yield client


async def test_an_active_member_gets_the_client_and_nothing_is_cached(
    settings: Settings, clock: FakeClock, capsys
):
    async with relay(settings, OAuthClient(CLIENT_ID, SECRET), clock) as client:
        for member in ("alice", "bob"):
            r = await client.get("/v1/teams/demo/drive-client", headers=auth(member))
            assert r.status_code == 200, r.text
            assert r.json() == {"client_id": CLIENT_ID, "client_secret": SECRET}
            assert r.headers["cache-control"] == "no-store"
        # A Google identity of a member works too.
        token = id_token(EMAILS["carol"], "sub-carol-" + uuid.uuid4().hex)
        r = await client.get(
            "/v1/teams/demo/drive-client", headers={"Authorization": f"Bearer {token}"}
        )
        assert r.status_code == 200
    out = capsys.readouterr()
    assert SECRET not in out.out and SECRET not in out.err


async def test_not_configured_is_404_drive_not_configured(settings: Settings, clock: FakeClock):
    async with relay(settings, None, clock) as client:
        r = await client.get("/v1/teams/demo/drive-client", headers=auth("alice"))
        assert r.status_code == 404 and r.json()["error"] == "drive_not_configured"
        assert r.headers["cache-control"] == "no-store"


async def test_outsiders_and_delegates_get_nothing(settings: Settings, clock: FakeClock):
    async with relay(settings, OAuthClient(CLIENT_ID, SECRET), clock) as client:
        r = await client.get("/v1/teams/demo/drive-client")
        assert r.status_code == 401
        r = await client.get(
            "/v1/teams/demo/drive-client", headers={"Authorization": "Bearer nope"}
        )
        assert r.status_code == 401
        # dave is on team other only.
        r = await client.get("/v1/teams/demo/drive-client", headers=auth("dave"))
        assert r.status_code == 404 and r.json()["error"] == "not_found"
        r = await client.get("/v1/teams/nosuch/drive-client", headers=auth("alice"))
        assert r.status_code == 404 and r.json()["error"] == "not_found"
        # The console's delegate has no use for it.
        r = await client.get("/v1/teams/demo/drive-client", headers=delegate_auth(EMAILS["alice"]))
        assert r.status_code == 403 and SECRET not in r.text
        # Only GET.
        r = await client.put("/v1/teams/demo/drive-client", headers=auth("alice"), json={})
        assert r.status_code == 405


async def test_an_invited_account_gets_nothing(settings: Settings, clock: FakeClock):
    async with relay(settings, OAuthClient(CLIENT_ID, SECRET), clock) as client:
        email = f"u{uuid.uuid4().hex[:12]}@example.com"
        r = await client.post(
            "/v1/teams/demo/roster", headers=auth("alice"), json={"member": "erin", "email": email}
        )
        assert r.status_code == 201, r.text
        sub = "sub-erin-" + uuid.uuid4().hex
        erin = {"Authorization": f"Bearer {id_token(email, sub)}"}
        r = await client.get("/v1/teams/demo/drive-client", headers=erin)
        assert r.status_code in (401, 404) and SECRET not in r.text
        await accept_invitation(client, "demo", email, sub=sub)
        assert (await client.get("/v1/teams/demo/drive-client", headers=erin)).status_code == 200
