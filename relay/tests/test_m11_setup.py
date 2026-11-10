"""M11-SPEC §5: ``GET /setup`` serves the one-command setup script.

- No authentication, outside ``/v1``; ``text/x-shellscript; charset=utf-8``, ``Cache-Control:
  no-store``; the script with ``__RELAY_URL__`` (RELAY_PUBLIC_URL) and ``__MARKETPLACE__``
  (RELAY_PLUGIN_MARKETPLACE) replaced everywhere they occur.
- Both are checked at start: a malformed marketplace, or a marketplace with a public URL that
  is not an ``https`` origin, refuses to start. Either unset, or the script missing from the
  image: ``/setup`` is 404.
- The script is read once, at start.
- The image carries the script: the Dockerfile copies the package and ``pyproject.toml``
  declares it as package data.

The script here is a tiny fixture written per test; the real one is
``relay/relay/static/setup.sh``."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import httpx
import pytest

from relay import setup_script
from relay.app import create_app
from relay.config import Settings, load_schema, parse_public_url, parse_team_config
from relay.errors import ConfigError
from relay.setup_script import load_setup_script, parse_plugin_marketplace
from relay.store_memory import MemoryStore

from .conftest import SCHEMA_PATH, team_config_data

pytestmark = pytest.mark.anyio

RELAY_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail
RELAY_URL="__RELAY_URL__"
MARKETPLACE="__MARKETPLACE__"
echo "Setting up against __RELAY_URL__ from __MARKETPLACE__"
"""
ORIGIN = "https://team.example.com"
MARKETPLACE = "example-org/team-relay"


def _template(directory: Path, text: str = TEMPLATE) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "setup.sh"
    path.write_text(text, encoding="utf-8")
    return path


def _env(tmp_path: Path, **extra: str) -> dict[str, str]:
    config = tmp_path / "team.yaml"
    config.write_text(json.dumps(team_config_data()))
    client = tmp_path / "client.json"
    client.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret"}))
    return {
        "RELAY_TEAM_CONFIG": str(config),
        "RELAY_AUDIENCE": ORIGIN,
        "RELAY_PUBLIC_URL": ORIGIN,
        "RELAY_OAUTH_CLIENT_FILE": str(client),
        **extra,
    }


@pytest.fixture
def template(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = _template(tmp_path / "static")
    monkeypatch.setattr(setup_script, "SETUP_SCRIPT_PATH", path)
    return path


# The marketplace and the public URL ---------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "example-org/team-relay",
        "a/b",
        "A1-b/repo.name_with-dots",
        "o" * 39 + "/" + "r" * 100,
    ],
)
def test_a_marketplace_is_owner_slash_repo(raw: str):
    assert parse_plugin_marketplace(raw) == raw


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "example-org",
        "example-org/",
        "/team-relay",
        "example-org/team-relay/extra",
        "example_org/team-relay",
        "o" * 40 + "/repo",
        "owner/" + "r" * 101,
        "owner/repo name",
        "owner/repo;rm -rf ~",
        "owner/$(id)",
        "owner/repo\n",
        "https://github.com/owner/repo",
        "owner/répo",
    ],
)
def test_a_malformed_marketplace_is_refused(raw: str):
    with pytest.raises(ConfigError, match="RELAY_PLUGIN_MARKETPLACE"):
        parse_plugin_marketplace(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "https://a$b.example.com",
        "https://a'b.example.com",
        "https://a`id`.example.com",
        "https://a_b.example.com",
        "https://-a.example.com",
        "https://a b.example.com",
        "https://a\\b.example.com",
    ],
)
def test_a_public_url_host_holds_dns_characters_only(raw: str):
    with pytest.raises(ConfigError, match="RELAY_PUBLIC_URL"):
        parse_public_url(raw, {})


# Startup ----------------------------------------------------------------------------------------


def test_both_set_renders_the_script_once_at_start(tmp_path: Path, template: Path):
    settings = Settings.from_env(_env(tmp_path, RELAY_PLUGIN_MARKETPLACE=MARKETPLACE))
    assert settings.plugin_marketplace == MARKETPLACE
    assert settings.setup_script == TEMPLATE.replace("__RELAY_URL__", ORIGIN).replace(
        "__MARKETPLACE__", MARKETPLACE
    )
    assert "__" not in settings.setup_script
    # Read once: a later change to the file changes nothing in these settings.
    template.write_text("#!/bin/sh\necho changed\n")
    assert "changed" not in settings.setup_script


def test_a_public_url_with_a_trailing_slash_is_rendered_as_the_origin(
    tmp_path: Path, template: Path
):
    env = _env(tmp_path, RELAY_PLUGIN_MARKETPLACE=MARKETPLACE, RELAY_PUBLIC_URL=ORIGIN + "/")
    settings = Settings.from_env(env)
    assert settings.setup_script is not None
    assert f'RELAY_URL="{ORIGIN}"' in settings.setup_script


def test_a_malformed_marketplace_refuses_to_start(tmp_path: Path, template: Path):
    for raw in ("not-a-repo", "owner/repo;id", "owner/repo/x"):
        with pytest.raises(ConfigError, match="RELAY_PLUGIN_MARKETPLACE"):
            Settings.from_env(_env(tmp_path, RELAY_PLUGIN_MARKETPLACE=raw))
    # Malformed is refused even while the public URL is unset.
    env = {
        k: v
        for k, v in _env(tmp_path, RELAY_PLUGIN_MARKETPLACE="bad").items()
        if k not in ("RELAY_PUBLIC_URL", "RELAY_OAUTH_CLIENT_FILE")
    }
    with pytest.raises(ConfigError, match="RELAY_PLUGIN_MARKETPLACE"):
        Settings.from_env(env)


def test_a_local_http_public_url_with_a_marketplace_refuses_to_start(
    tmp_path: Path, template: Path
):
    env = _env(
        tmp_path,
        RELAY_PLUGIN_MARKETPLACE=MARKETPLACE,
        RELAY_PUBLIC_URL="http://127.0.0.1:8090",
    )
    with pytest.raises(ConfigError, match="https"):
        Settings.from_env(env)
    # Without a marketplace the local login keeps working as before.
    env.pop("RELAY_PLUGIN_MARKETPLACE")
    assert Settings.from_env(env).setup_script is None


def test_either_unset_serves_nothing(tmp_path: Path, template: Path):
    assert Settings.from_env(_env(tmp_path)).setup_script is None
    env = {
        k: v
        for k, v in _env(tmp_path, RELAY_PLUGIN_MARKETPLACE=MARKETPLACE).items()
        if k not in ("RELAY_PUBLIC_URL", "RELAY_OAUTH_CLIENT_FILE")
    }
    settings = Settings.from_env(env)
    assert settings.setup_script is None and settings.plugin_marketplace == MARKETPLACE
    # An empty value is unset.
    assert Settings.from_env(_env(tmp_path, RELAY_PLUGIN_MARKETPLACE="")).setup_script is None


def test_a_missing_script_serves_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(setup_script, "SETUP_SCRIPT_PATH", tmp_path / "nowhere" / "setup.sh")
    settings = Settings.from_env(_env(tmp_path, RELAY_PLUGIN_MARKETPLACE=MARKETPLACE))
    assert settings.setup_script is None


def test_an_unreadable_script_refuses_to_start(tmp_path: Path):
    path = tmp_path / "setup.sh"
    path.write_bytes(b"#!/bin/sh\n\xff\xfe\n")
    with pytest.raises(ConfigError, match="setup script"):
        load_setup_script(path, ORIGIN, MARKETPLACE)
    with pytest.raises(ConfigError, match="setup script"):
        load_setup_script(tmp_path, ORIGIN, MARKETPLACE)  # a directory


def test_the_script_is_rendered_from_checked_values_only():
    with pytest.raises(ConfigError):
        setup_script.render(TEMPLATE, "https://a$b.example.com", MARKETPLACE)
    with pytest.raises(ConfigError):
        setup_script.render(TEMPLATE, ORIGIN, "owner/$(id)")
    with pytest.raises(ConfigError):
        setup_script.render(TEMPLATE, "http://127.0.0.1:8090", MARKETPLACE)
    assert setup_script.render("__RELAY_URL__ __MARKETPLACE__", ORIGIN, MARKETPLACE) == (
        f"{ORIGIN} {MARKETPLACE}"
    )


# The route --------------------------------------------------------------------------------------


def _app(script: str | None) -> httpx.AsyncClient:
    settings = Settings(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
        plugin_marketplace=MARKETPLACE if script is not None else None,
        setup_script=script,
    )
    app = create_app(settings, MemoryStore())
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN)


async def test_setup_is_served_without_authentication():
    rendered = setup_script.render(TEMPLATE, ORIGIN, MARKETPLACE)
    async with _app(rendered) as client:
        r = await client.get("/setup")
        assert r.status_code == 200
        assert r.headers["content-type"] == "text/x-shellscript; charset=utf-8"
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.text == rendered
        assert "set-cookie" not in r.headers
        # A bearer token changes nothing (and is not looked at).
        r = await client.get("/setup", headers={"Authorization": "Bearer nope"})
        assert r.status_code == 200 and r.text == rendered


async def test_setup_is_get_only_and_not_under_v1():
    async with _app(setup_script.render(TEMPLATE, ORIGIN, MARKETPLACE)) as client:
        for method in ("POST", "PUT", "DELETE"):
            assert (await client.request(method, "/setup")).status_code == 405
        assert (await client.get("/v1/setup")).status_code == 404
        assert (await client.get("/setup/")).status_code in (404, 307)


async def test_setup_is_404_when_not_configured():
    async with _app(None) as client:
        r = await client.get("/setup")
        assert r.status_code == 404 and r.json() == {"error": "not_found"}


# The image -------------------------------------------------------------------------------------


def test_the_image_carries_the_script():
    pyproject = tomllib.loads((RELAY_ROOT / "pyproject.toml").read_text())
    assert "static/*.sh" in pyproject["tool"]["setuptools"]["package-data"]["relay"]
    dockerfile = (RELAY_ROOT / "Dockerfile").read_text()
    assert "COPY relay/relay ./relay" in dockerfile
    ignore = (RELAY_ROOT / "Dockerfile.dockerignore").read_text().splitlines()
    assert "!relay/relay/" in ignore
    assert setup_script.SETUP_SCRIPT_PATH == RELAY_ROOT / "relay" / "static" / "setup.sh"
