"""Identity (M1-SPEC §2): the team file, the two verifiers, 401 and other-team 404."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from relay.app import create_app
from relay.auth import StaticVerifier
from relay.config import Settings, load_schema, load_team_config, parse_team_config
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import (
    EXAMPLE_CONFIG,
    SCHEMA_PATH,
    TOKENS,
    auth,
    principal,
    team_config_data,
)

pytestmark = pytest.mark.anyio


# The team file ---------------------------------------------------------------------------


def test_example_team_config_loads():
    config = load_team_config(EXAMPLE_CONFIG)
    seeds = config.teams["demo"].seeds
    assert [(s.id, s.role) for s in seeds] == [
        ("alice", "owner"),
        ("bob", "member"),
        ("carol", "member"),
    ]
    assert seeds[1].emails == ("bob@example.com",)
    assert config.limits.min_ack_timeout_seconds == 10
    assert config.limits.min_answer_timeout_seconds == 60
    assert config.audit_retention_days == 90


def test_google_principals_are_lowercased():
    data = {
        "teams": [
            {
                "id": "demo",
                "members": [
                    {"id": "alice", "role": "owner", "principals": ["google:Alice@Example.COM"]},
                ],
            }
        ]
    }
    assert parse_team_config(data).teams["demo"].seeds[0].emails == ("alice@example.com",)


@pytest.mark.parametrize(
    "mutate, message",
    [
        (
            lambda d: d["teams"][0]["members"][1]["principals"].append(
                d["teams"][0]["members"][0]["principals"][0]
            ),
            "listed twice",
        ),
        (
            lambda d: d["teams"][0]["members"].append(
                {"id": "alice", "principals": [principal("y" * 20)]}
            ),
            "duplicate member",
        ),
        (lambda d: d["teams"].append(dict(d["teams"][1])), "duplicate team"),
        (
            lambda d: d["teams"][0]["members"][0]["principals"].__setitem__(0, "alice"),
            "principal must be",
        ),
        (
            lambda d: d["teams"][0]["members"][0]["principals"].__setitem__(0, "token:sha256:ab"),
            "principal must be",
        ),
        (lambda d: d["teams"][0].__setitem__("id", "Demo"), "team id"),
        (lambda d: d["teams"][0]["members"][0].__setitem__("id", "Alice"), "member id"),
        (lambda d: d.__setitem__("extra", 1), "extra"),
        (lambda d: d.__setitem__("limits", {"min_ack_timeout_seconds": 0}), "limits"),
        # M6-SPEC §1: a team needs a seed owner; roles are owner or member.
        (lambda d: d["teams"][0]["members"][0].pop("role"), "no member with role: owner"),
        (lambda d: d["teams"][0]["members"][0].__setitem__("role", "admin"), "role"),
        (lambda d: d["teams"][0]["members"][0].__setitem__("role", "Owner"), "role"),
        # at most 5 google principals a member
        (
            lambda d: d["teams"][0]["members"][1]["principals"].extend(
                f"google:bob{i}@example.com" for i in range(5)
            ),
            "more than 5 google principals",
        ),
        # an email is one plain address
        (
            lambda d: d["teams"][0]["members"][1]["principals"].append("google:a,b@example.com"),
            "principal must be",
        ),
    ],
)
def test_bad_team_config_is_a_startup_error(mutate, message):
    data = team_config_data()
    mutate(data)
    with pytest.raises(ConfigError) as exc:
        parse_team_config(data)
    assert message in str(exc.value)


def test_a_principal_and_a_member_id_may_be_in_several_teams():
    """M5-SPEC §4: one member id per team, and member ids are unique within a team only."""
    data = team_config_data()
    data["teams"][1]["members"].append(
        {"id": "alice", "principals": [principal(TOKENS["alice"]), "google:alice@example.com"]}
    )
    config = parse_team_config(data)
    assert config.token_member(principal(TOKENS["alice"]), "demo") == "alice"
    assert config.token_member(principal(TOKENS["alice"]), "other") == "alice"
    assert [s.id for s in config.teams["other"].seeds] == ["dave", "alice"]
    assert config.teams["other"].seeds[1].emails == ("alice@example.com",)


def test_duplicate_principal_error_does_not_echo_the_principal():
    data = team_config_data()
    dup = data["teams"][0]["members"][0]["principals"][0]
    data["teams"][0]["members"][1]["principals"].append(dup)
    with pytest.raises(ConfigError) as exc:
        parse_team_config(data)
    assert dup not in str(exc.value) and dup.split(":")[-1] not in str(exc.value)


# Settings and the static-mode refusal ------------------------------------------------------


def _write_config(tmp_path: Path) -> Path:
    path = tmp_path / "team.yaml"
    path.write_text(json.dumps(team_config_data()))  # JSON is YAML
    return path


def test_settings_from_env(tmp_path: Path):
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUTH_MODE": "static"}
    settings = Settings.from_env(env)
    assert settings.auth_mode == "static"
    assert settings.manifest_schema == load_schema(SCHEMA_PATH)  # default path resolves


def test_settings_default_to_google_and_need_an_audience(tmp_path: Path):
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path))}
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE"):
        Settings.from_env(env)
    settings = Settings.from_env({**env, "RELAY_AUDIENCE": "https://relay.example"})
    assert settings.auth_mode == "google" and settings.audiences == ("https://relay.example",)


def test_settings_refuse_unknown_mode_and_missing_config(tmp_path: Path):
    with pytest.raises(ConfigError, match="RELAY_AUTH_MODE"):
        Settings.from_env(
            {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUTH_MODE": "none"}
        )
    with pytest.raises(ConfigError, match="RELAY_TEAM_CONFIG"):
        Settings.from_env({"RELAY_AUTH_MODE": "static"})


def test_static_mode_is_refused_on_cloud_run(tmp_path: Path, monkeypatch, settings):
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUTH_MODE": "static",
        "K_SERVICE": "relay",
    }
    with pytest.raises(ConfigError, match="K_SERVICE"):
        Settings.from_env(env)
    # Defence in depth: the verifier and the app factory refuse too.
    with pytest.raises(ConfigError, match="K_SERVICE"):
        StaticVerifier({"K_SERVICE": "relay"})
    monkeypatch.setenv("K_SERVICE", "relay")
    with pytest.raises(ConfigError, match="K_SERVICE"):
        create_app(settings, MemoryStore())


def test_google_mode_is_allowed_on_cloud_run(tmp_path: Path):
    client = tmp_path / "oauth.json"
    client.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret"}))
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUDIENCE": "https://relay.example",
        "RELAY_PUBLIC_URL": "https://relay.example",
        "RELAY_OAUTH_CLIENT_FILE": str(client),
        "K_SERVICE": "relay",
        # M10-SPEC §5: a public URL that is not a run.app one says how many hops Google adds.
        "RELAY_FORWARDED_FOR_HOPS": "1",
    }
    assert Settings.from_env(env).auth_mode == "google"


# 401 ---------------------------------------------------------------------------------------


async def test_healthz_needs_no_credentials(client: httpx.AsyncClient):
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"ok": True}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer "},
        {"Authorization": f"Basic {TOKENS['alice']}"},
        {"Authorization": TOKENS["alice"]},
        {"Authorization": "Bearer not-a-known-token"},
        {"Authorization": f"Bearer {TOKENS['alice']}x"},
    ],
)
async def test_unauthenticated_is_401_without_detail(client, headers, capsys, memory_store):
    for method, path in [
        ("GET", "/v1/teams/demo/me"),
        ("POST", "/v1/teams/demo/requests"),
        ("GET", "/v1/teams/demo/streams/inbox"),
    ]:
        r = await client.request(method, path, headers=headers, json={})
        assert r.status_code == 401
        assert r.json() == {"error": "unauthenticated"}
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.splitlines() if line.strip()]
    assert lines and all(line["event"] == "auth_rejected" for line in lines)
    assert "not-a-known-token" not in out and TOKENS["alice"] not in out
    assert await memory_store.list_audit("demo") == []  # no team to file them under


async def test_other_team_is_404_and_audited_on_mutations(client, memory_store):
    r = await client.get("/v1/teams/other/me", headers=auth("alice"))
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await client.get("/v1/teams/nosuchteam/directory", headers=auth("alice"))
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    assert await memory_store.list_audit("demo") == []  # reads are not audited

    r = await client.post("/v1/teams/other/requests", headers=auth("alice"), json={})
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    entries = await memory_store.list_audit("demo")
    assert [(e.actor, e.action, e.outcome, e.detail) for e in entries] == [
        ("alice", "request.create", "refused", "404 not_found")
    ]
    assert await memory_store.list_audit("other") == []

    # dave (team other) is 404 on demo, whatever the route.
    r = await client.get("/v1/teams/demo/me", headers=auth("dave"))
    assert r.status_code == 404


async def test_me(client):
    r = await client.get("/v1/teams/demo/me", headers=auth("bob"))
    assert r.status_code == 200
    assert r.json() == {
        "team": "demo",
        "name": "demo",
        "member": "bob",
        "teammates": ["alice", "carol"],
        "role": "member",
    }
    r = await client.get("/v1/teams/other/me", headers=auth("dave"))
    assert r.json() == {
        "team": "other",
        "name": "other",
        "member": "dave",
        "teammates": [],
        "role": "owner",
    }


async def test_unknown_routes_and_methods(client):
    r = await client.get("/v1/nothing")
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await client.delete("/v1/teams/demo/me", headers=auth("alice"))
    assert r.status_code == 405 and r.json()["error"] == "method_not_allowed"
    assert (await client.get("/docs")).status_code == 404
    assert (await client.get("/openapi.json")).status_code == 404
