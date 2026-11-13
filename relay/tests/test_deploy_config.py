"""M2-SPEC §1 and §2: the relay's Cloud Run environment, /v1/health, and RELAY_AUDIENCE as a
list of audiences; scripts/deploy.sh's CONFIRM_REMOVE, and (local folders only, 13 Nov 2026)
that scripts/deploy.sh and scripts/gcp-bootstrap.sh no longer mount, set or store the GitHub
App, the Drive Picker, the Drive client or the source allowlists, and remove their settings from
the live service. Synthetic identities only; nothing reaches the network or GCP (gcloud and git
are stubs)."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from relay import __main__ as relay_main
from relay import app as app_module
from relay.app import create_app
from relay.auth import (
    GoogleVerifier,
    Unauthenticated,
    audience_set_digest,
    build_verifier,
    verified_cache_key,
)
from relay.config import (
    Settings,
    load_schema,
    parse_audiences,
    parse_team_config,
)
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import REPO_ROOT, SCHEMA_PATH, TOKENS, team_config_data
from .test_google_verifier import Clock, FakeCertsEndpoint, make_token

pytestmark = pytest.mark.anyio

GCLOUD_CLIENT = "32555940559.apps.googleusercontent.com"
SERVICE_URL = "https://team-relay-test.a.run.app"


def _write_config(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "team.yaml"
    path.write_text(json.dumps(team_config_data()))  # JSON is YAML
    return path


def _login_env(directory: Path) -> dict[str, str]:
    """M5-SPEC §5: on Cloud Run the relay also needs its public URL and its OAuth client."""
    directory.mkdir(parents=True, exist_ok=True)
    client = directory / "oauth-client.json"
    client.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret"}))
    return {"RELAY_PUBLIC_URL": SERVICE_URL, "RELAY_OAUTH_CLIENT_FILE": str(client)}


# /v1/health ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer not-a-known-token"}, {"Authorization": "Basic x"}],
)
async def test_v1_health_needs_no_credentials_and_matches_healthz(client, headers):
    r = await client.get("/v1/health", headers=headers)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.json() == (await client.get("/healthz")).json()


async def test_v1_health_is_get_only(client):
    assert (await client.post("/v1/health")).status_code == 405


async def test_v1_health_under_google_mode_needs_no_token():
    settings = Settings(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="google",
        audiences=(GCLOUD_CLIENT,),
    )
    endpoint = FakeCertsEndpoint()
    app = create_app(
        settings, MemoryStore(), verifier=GoogleVerifier(GCLOUD_CLIENT, transport=endpoint)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as c:
        assert (await c.get("/v1/health")).json() == {"ok": True}
        assert (await c.get("/v1/teams/demo/me")).status_code == 401
    assert endpoint.fetches == 0


# RELAY_AUDIENCE ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("https://relay.example", ("https://relay.example",)),
        (f"{GCLOUD_CLIENT},{SERVICE_URL}", (GCLOUD_CLIENT, SERVICE_URL)),
        (f" {GCLOUD_CLIENT} , {SERVICE_URL} ", (GCLOUD_CLIENT, SERVICE_URL)),
        (f"{GCLOUD_CLIENT},{SERVICE_URL},{GCLOUD_CLIENT}", (GCLOUD_CLIENT, SERVICE_URL)),
        (None, ()),
        ("", ()),
        ("   ", ()),
    ],
)
def test_parse_audiences(raw, expected):
    assert parse_audiences(raw) == expected


@pytest.mark.parametrize("raw", ["a,,b", "a,", ",a", " , ", "a, ", ",", "a,\t,b"])
def test_an_empty_audience_entry_is_a_startup_error(raw, tmp_path: Path):
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE has an empty entry"):
        parse_audiences(raw)
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUDIENCE": raw}
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE has an empty entry"):
        Settings.from_env(env)


def test_settings_carry_every_audience(tmp_path: Path):
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUDIENCE": f"{GCLOUD_CLIENT},{SERVICE_URL}",
        "K_SERVICE": "team-relay",
        **_login_env(tmp_path / "oauth"),
    }
    settings = Settings.from_env(env)
    assert settings.auth_mode == "google"
    assert settings.audiences == (GCLOUD_CLIENT, SERVICE_URL)
    verifier = build_verifier(settings)
    assert isinstance(verifier, GoogleVerifier)
    assert verifier._audiences == [GCLOUD_CLIENT, SERVICE_URL]


@pytest.mark.parametrize("audiences", [("",), ("a", ""), (" a",), ["a"], ("a", 1)])
def test_settings_refuse_malformed_audiences(audiences):
    with pytest.raises(ConfigError):
        Settings(
            team_config=parse_team_config(team_config_data()),
            manifest_schema=load_schema(SCHEMA_PATH),
            auth_mode="google",
            audiences=audiences,  # type: ignore[arg-type]
        )


def test_google_mode_needs_at_least_one_audience():
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE is required"):
        Settings(
            team_config=parse_team_config(team_config_data()),
            manifest_schema=load_schema(SCHEMA_PATH),
            auth_mode="google",
        )


@pytest.mark.parametrize("audiences", ["", [], ["a", ""], ("",)])
def test_the_verifier_refuses_an_empty_audience(audiences):
    with pytest.raises(ValueError):
        GoogleVerifier(audiences)


@pytest.fixture
def two_audiences() -> GoogleVerifier:
    return GoogleVerifier(
        [GCLOUD_CLIENT, SERVICE_URL], transport=FakeCertsEndpoint(), clock=Clock()
    )


@pytest.mark.parametrize("aud", [GCLOUD_CLIENT, SERVICE_URL])
async def test_a_token_for_any_listed_audience_is_accepted(two_audiences, aud):
    assert await two_audiences.principal(make_token(aud=aud)) == "google:alice@example.com"


@pytest.mark.parametrize(
    "aud",
    [
        "https://some-other-service.a.run.app",
        GCLOUD_CLIENT + " ",
        GCLOUD_CLIENT.upper(),
        f"{GCLOUD_CLIENT},{SERVICE_URL}",
        [GCLOUD_CLIENT],  # an array-valued aud is never one of the accepted strings
        [GCLOUD_CLIENT, SERVICE_URL],
    ],
)
async def test_a_token_for_any_other_audience_is_refused(two_audiences, aud):
    with pytest.raises(Unauthenticated):
        await two_audiences.principal(make_token(aud=aud))


async def test_the_other_checks_still_apply_with_a_list(two_audiences):
    for claims in ({"email_verified": False}, {"iss": "https://evil.example"}):
        with pytest.raises(Unauthenticated):
            await two_audiences.principal(make_token(aud=SERVICE_URL, **claims))


def test_the_audience_digest_ignores_order_and_duplicates():
    assert audience_set_digest(["a", "b"]) == audience_set_digest(["b", "a", "a"])
    assert audience_set_digest(["a"]) != audience_set_digest(["a", "b"])
    assert audience_set_digest(["a,b"]) != audience_set_digest(["a", "b"])
    assert audience_set_digest(["a\nb"]) != audience_set_digest(["a", "b"])


async def test_the_verified_cache_is_keyed_on_the_audience_set_and_the_token(two_audiences):
    token = make_token(aud=SERVICE_URL)
    await two_audiences.principal(token)
    [key] = list(two_audiences._verified)
    assert key == verified_cache_key(audience_set_digest([GCLOUD_CLIENT, SERVICE_URL]), token)
    assert key != hashlib.sha256(token.encode()).hexdigest()  # not the token alone
    assert key != verified_cache_key(audience_set_digest([SERVICE_URL]), token)
    assert key != verified_cache_key(audience_set_digest([GCLOUD_CLIENT]), token)


async def test_a_principal_cached_under_one_audience_set_is_not_served_under_another():
    """Two verifiers sharing one cache (the cache is per verifier today; this pins that the
    key would keep them apart if it ever were shared)."""
    endpoint, clock = FakeCertsEndpoint(), Clock()
    wide = GoogleVerifier([GCLOUD_CLIENT, SERVICE_URL], transport=endpoint, clock=clock)
    narrow = GoogleVerifier([SERVICE_URL], transport=endpoint, clock=clock)
    narrow._verified = wide._verified  # shared on purpose
    token = make_token(aud=GCLOUD_CLIENT)
    assert await wide.principal(token) == "google:alice@example.com"
    with pytest.raises(Unauthenticated):
        await narrow.principal(token)  # re-verified under its own set, and refused


# The Cloud Run environment (M2-SPEC §1) -------------------------------------------------------


def test_the_team_config_is_read_from_a_mounted_secret_file(tmp_path: Path):
    # Secret Manager volumes present the file through symlinks (…/team.yaml -> ..data/…).
    real = _write_config(tmp_path / "secrets" / "team" / "..2026_09_23")
    data_link = tmp_path / "secrets" / "team" / "..data"
    data_link.symlink_to(real.parent.name)
    mounted = tmp_path / "secrets" / "team" / "team.yaml"
    mounted.symlink_to(Path("..data") / "team.yaml")
    env = {
        "RELAY_TEAM_CONFIG": str(mounted),
        "RELAY_AUDIENCE": f"{GCLOUD_CLIENT},{SERVICE_URL}",
        "K_SERVICE": "team-relay",
        **_login_env(tmp_path / "oauth"),
    }
    settings = Settings.from_env(env)
    assert [s.id for s in settings.team_config.teams["demo"].seeds] == ["alice", "bob", "carol"]


def test_a_missing_mounted_file_is_a_startup_error(tmp_path: Path):
    env = {
        "RELAY_TEAM_CONFIG": str(tmp_path / "secrets" / "team" / "team.yaml"),
        "RELAY_AUDIENCE": SERVICE_URL,
    }
    with pytest.raises(ConfigError, match="cannot read team config"):
        Settings.from_env(env)


def test_the_app_from_env_uses_the_named_firestore_database(tmp_path: Path, monkeypatch):
    seen: dict[str, Any] = {}

    class FakeFirestoreStore(MemoryStore):
        def __init__(self, project: str | None = None, database: str | None = None) -> None:
            super().__init__()
            seen.update(project=project, database=database)

    import relay.store_firestore as store_firestore

    monkeypatch.setattr(store_firestore, "FirestoreStore", FakeFirestoreStore)
    monkeypatch.setenv("RELAY_TEAM_CONFIG", str(_write_config(tmp_path)))
    monkeypatch.setenv("RELAY_AUTH_MODE", "google")
    monkeypatch.setenv("RELAY_AUDIENCE", f"{GCLOUD_CLIENT},{SERVICE_URL}")
    monkeypatch.setenv("RELAY_FIRESTORE_DATABASE", "team-relay")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "demo-project")
    app = app_module.create_app_from_env()
    assert seen == {"project": "demo-project", "database": "team-relay"}
    assert isinstance(app.state.store, FakeFirestoreStore)


@pytest.mark.parametrize(
    "env, host, port",
    [({}, "127.0.0.1", 8080), ({"RELAY_HOST": "0.0.0.0", "PORT": "9090"}, "0.0.0.0", 9090)],
)
def test_the_listen_address_comes_from_relay_host(monkeypatch, env, host, port):
    calls: list[dict[str, Any]] = []
    monkeypatch.delenv("RELAY_HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(relay_main.uvicorn, "run", lambda app, **kw: calls.append(kw))
    relay_main.main()
    assert calls[0]["host"] == host and calls[0]["port"] == port


def test_static_tokens_still_resolve_under_the_new_settings(tmp_path: Path):
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUTH_MODE": "static"}
    settings = Settings.from_env(env)
    assert settings.audiences == ()
    principal = "token:sha256:" + hashlib.sha256(TOKENS["alice"].encode()).hexdigest()
    assert settings.team_config.token_member(principal, "demo") == "alice"


# scripts/deploy.sh and scripts/gcp-bootstrap.sh ------------------------------------------------
#
# Each script runs from a copy in a temporary folder (so no deploy.local.env is ever read) with
# stubs of gcloud and git first on PATH: the stub answers from a JSON state file and records every
# call and every secret value sent on stdin. Nothing reaches GCP.

GCLOUD_STUB = r"""#!/usr/bin/env python3
import json, os, sys

state_path = os.environ["STUB_STATE"]
with open(state_path) as f:
    state = json.load(f)
args = sys.argv[1:]
state.setdefault("calls", []).append(args)


def save():
    with open(state_path, "w") as f:
        json.dump(state, f)


def flag(name):
    for a in args:
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def done(out="", code=0):
    save()
    if out:
        print(out)
    sys.exit(code)


words = [a for a in args if not a.startswith("-")]
secrets = state.setdefault("secrets", {})
if words[:2] == ["config", "get-value"]:
    done("operator@example.com")
if words[:2] == ["projects", "describe"]:
    done("123456789012")
if words[:2] == ["services", "list"]:
    done("")
if words[:3] == ["run", "services", "describe"]:
    if state.get("live_env") is None:
        done("", 1)
    done(";".join(state["live_env"]))
if words[:3] == ["run", "services", "list"]:
    done("team-relay" if state.get("live_env") is not None else "")
if words[:3] == ["secrets", "versions", "list"]:
    name = words[3]
    if name not in secrets:
        done("", 1)
    done(str(len(secrets[name])))
if words[:3] == ["secrets", "versions", "access"]:
    name = flag("--secret")
    if name not in secrets:
        done("", 1)
    sys.stdout.write(secrets[name][-1])
    done()
if words[:2] == ["secrets", "describe"]:
    done("", 0 if words[2] in secrets else 1)
if words[:2] == ["secrets", "create"] or words[:3] == ["secrets", "versions", "add"]:
    name = words[2] if words[1] == "create" else words[3]
    source = flag("--data-file")
    value = sys.stdin.read() if source == "-" else open(source).read()
    secrets.setdefault(name, []).append(value)
    done()
if words[:4] == ["artifacts", "docker", "images", "describe"]:
    done("sha256:" + "0" * 64)
done("")
"""

GIT_STUB = """#!/bin/sh
case "$1" in
  status) exit 0 ;;
  rev-parse) echo abc1234 ;;
esac
"""


def _copy_script(tmp_path: Path, name: str) -> Path:
    scripts = tmp_path / "repo" / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    target = scripts / name
    target.write_text((REPO_ROOT / "scripts" / name).read_text())
    config = tmp_path / "repo" / "config"
    config.mkdir(exist_ok=True)
    (config / "team.local.yaml").write_text("teams: []\n")
    return target


def _stubs(tmp_path: Path, state: dict[str, Any]) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    for name, body in (("gcloud", GCLOUD_STUB), ("git", GIT_STUB)):
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps(state))
    return {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "STUB_STATE": str(state_path),
        "HOME": str(tmp_path),
        "LC_ALL": "C",
    }


@dataclass
class ScriptRun:
    code: int
    output: str
    state: dict[str, Any]

    def calls(self, *words: str) -> list[list[str]]:
        return [c for c in self.state.get("calls", []) if c[: len(words)] == list(words)]

    def deploy_flag(self, name: str) -> str | None:
        (deploy,) = self.calls("run", "deploy")
        for arg in deploy:
            if arg.startswith(name + "="):
                return arg.split("=", 1)[1]
        return None


def _run(tmp_path: Path, script: str, state: dict[str, Any], **env: str) -> ScriptRun:
    target = _copy_script(tmp_path, script)
    full_env = {**_stubs(tmp_path, state), "PROJECT": "example-project", **env}
    done = subprocess.run(
        ["bash", str(target)], env=full_env, capture_output=True, text=True, timeout=120
    )
    final = json.loads((tmp_path / "state.json").read_text())
    final.setdefault("calls", [])
    return ScriptRun(done.returncode, done.stdout + done.stderr, final)


BASE_SECRETS = {"team-relay-team-config": ["teams: []\n"], "team-relay-oauth-client": ["{}"]}
DEPLOY_ENV = {"ALLOWED_DOMAINS": "example.com"}
SECRET_VALUE = "never-printed-" + uuid.uuid4().hex


def _deploy(tmp_path: Path, secrets: dict[str, list[str]], live: list[str] | None, **env: str):
    state = {"secrets": {**BASE_SECRETS, **secrets}, "live_env": live}
    return _run(tmp_path, "deploy.sh", state, **{**DEPLOY_ENV, **env})


def _env_vars(run: ScriptRun) -> dict[str, str]:
    raw = run.deploy_flag("--update-env-vars")
    assert raw is not None and raw.startswith("^;^")
    return dict(item.split("=", 1) for item in raw[3:].split(";"))


# Local folders only (13 Nov 2026): the sources' settings, secrets and APIs.
RETIRED = [
    "RELAY_GITHUB_ORGS",
    "RELAY_GITHUB_APP_FILE",
    "RELAY_PICKER_FILE",
    "RELAY_ALLOWED_SHARED_DRIVES",
    "RELAY_DRIVE_CLIENT_FILE",
]
SOURCE_SECRETS = {
    "team-relay-github-app": [SECRET_VALUE],
    "team-relay-picker": [SECRET_VALUE],
    "team-relay-drive-client": [SECRET_VALUE],
}
STALE_SOURCE_ENV = {
    "GITHUB_ORGS": "example-org",
    "ALLOWED_SHARED_DRIVES": "0AExampleDriveId0PVA",
    "DRIVE_CLIENT_FILE": "/nonexistent/client.json",
    "GITHUB_APP_ID": "424242",
    "GITHUB_APP_SLUG": "example-relay-sources",
    "GITHUB_APP_KEY_FILE": "/nonexistent/app.pem",
    "PICKER_CLIENT_ID": "123456789012-picker.apps.googleusercontent.com",
    "PICKER_API_KEY": "AIza" + "Example0Picker0Key0Only0For0Tests00",
}


def test_deploy_mounts_and_sets_nothing_of_the_removed_sources(tmp_path: Path):
    """The sources' secrets still exist and config/deploy.local.env still names them: the
    deploy mounts only the team config and the login's client and sets none of their
    settings."""
    run = _deploy(tmp_path, SOURCE_SECRETS, None, **STALE_SOURCE_ENV)
    assert run.code == 0, run.output
    secrets = (run.deploy_flag("--set-secrets") or "").split(",")
    assert secrets == [
        "/secrets/team/team.yaml=team-relay-team-config:1",
        "/secrets/oauth/client.json=team-relay-oauth-client:1",
    ]
    env = _env_vars(run)
    assert not [name for name in env if name in RETIRED]
    assert SECRET_VALUE not in run.output
    for value in STALE_SOURCE_ENV.values():
        assert value not in run.output and value not in json.dumps(run.state["calls"])
    # A service not deployed yet has none of them to remove.
    removed = (run.deploy_flag("--remove-env-vars") or "").split(",")
    assert not [name for name in removed if name in RETIRED]


def test_deploy_removes_the_removed_sources_settings_the_live_service_has(tmp_path: Path):
    """Settings an earlier deploy left on the service are removed without CONFIRM_REMOVE; only
    those the service has are named."""
    live = ["RELAY_AUTH_MODE", "RELAY_ALLOWED_DOMAINS", *RETIRED[:4]]
    run = _deploy(tmp_path, {}, live)
    assert run.code == 0, run.output
    removed = (run.deploy_flag("--remove-env-vars") or "").split(",")
    assert [name for name in removed if name in RETIRED] == RETIRED[:4]
    assert "RELAY_DRIVE_CLIENT_FILE" not in removed
    assert "RELAY_ALLOWED_DOMAINS" not in removed


@pytest.mark.parametrize("raw", ["relay_brand_name", "RELAY_BRAND_NAME,,X", ","])
def test_deploy_refuses_a_malformed_confirm_remove_without_quoting_it(tmp_path: Path, raw: str):
    run = _deploy(tmp_path, {}, None, CONFIRM_REMOVE=raw)
    assert run.code != 0 and "CONFIRM_REMOVE" in run.output
    assert not run.calls("builds", "submit")
    assert "relay_brand_name" not in run.output


LIVE = [
    "RELAY_AUTH_MODE",
    "RELAY_ALLOWED_DOMAINS",
    "RELAY_PLUGIN_MARKETPLACE",
    "RELAY_BRAND_NAME",
]


def test_deploy_refuses_to_remove_a_live_setting_unless_confirmed(tmp_path: Path):
    full = {
        "ALLOWED_DOMAINS": "example.com",
        "PLUGIN_MARKETPLACE": "example-org/team-relay",
        "PUBLIC_HOST": "relay.example.com",
        "BRAND_NAME": "Example Co",
    }
    # Everything the live service has is still set: deployed.
    assert _deploy(tmp_path / "same", {}, LIVE, **full).code == 0
    # One setting left out: refused, naming it, before anything is built.
    for name, setting in (
        ("PLUGIN_MARKETPLACE", "RELAY_PLUGIN_MARKETPLACE"),
        ("BRAND_NAME", "RELAY_BRAND_NAME"),
    ):
        env = {k: v for k, v in full.items() if k != name}
        run = _deploy(tmp_path / name, {}, LIVE, **env)
        assert run.code != 0, run.output
        assert setting in run.output and f"CONFIRM_REMOVE={setting}" in run.output
        assert not run.calls("builds", "submit") and not run.calls("run", "deploy")
        confirmed = _deploy(tmp_path / f"{name}-ok", {}, LIVE, CONFIRM_REMOVE=setting, **env)
        assert confirmed.code == 0, confirmed.output
        assert setting in (confirmed.deploy_flag("--remove-env-vars") or "").split(",")
    # Removing the domain allowlist needs both confirmations.
    env = {k: v for k, v in full.items() if k != "ALLOWED_DOMAINS"}
    run = _deploy(tmp_path / "open", {}, LIVE, ALLOWED_DOMAINS="", CONFIRM_OPEN_RELAY="1", **env)
    assert run.code != 0 and "RELAY_ALLOWED_DOMAINS" in run.output
    run = _deploy(
        tmp_path / "open-ok",
        {},
        LIVE,
        ALLOWED_DOMAINS="",
        CONFIRM_OPEN_RELAY="1",
        CONFIRM_REMOVE="RELAY_ALLOWED_DOMAINS",
        **env,
    )
    assert run.code == 0, run.output


def test_deploy_reads_only_the_names_of_the_live_settings(tmp_path: Path):
    run = _deploy(tmp_path, {}, ["RELAY_AUTH_MODE"])
    assert run.code == 0, run.output
    (describe,) = run.calls("run", "services", "describe")
    assert "--format=value(spec.template.spec.containers[0].env[].name)" in describe


def _deploy_with_failing(tmp_path: Path, *commands: str) -> subprocess.CompletedProcess[str]:
    """deploy.sh with each named ``gcloud run services <command>`` failing (exit 1, no output)."""
    state = {"secrets": dict(BASE_SECRETS), "live_env": ["RELAY_AUTH_MODE"]}
    target = _copy_script(tmp_path, "deploy.sh")
    env = {**_stubs(tmp_path, state), "PROJECT": "example-project", **DEPLOY_ENV}
    stub = Path(env["PATH"].split(":")[0]) / "gcloud"
    text = stub.read_text()
    for command in commands:
        line = f'if words[:3] == ["run", "services", "{command}"]:'
        assert line in text, command
        text = text.replace(line, f'{line}\n    done("", 1)')
    stub.write_text(text)
    return subprocess.run(["bash", str(target)], env=env, capture_output=True, text=True)


def test_deploy_stops_when_the_live_service_cannot_be_read(tmp_path: Path):
    # describe fails while the service exists (an expired sign-in, say): nothing is deployed.
    done = _deploy_with_failing(tmp_path, "describe")
    assert done.returncode != 0 and "cannot read the settings" in done.stderr
    calls = json.loads((tmp_path / "state.json").read_text())["calls"]
    assert not [c for c in calls if c[:2] == ["builds", "submit"]]


def test_deploy_stops_when_describe_and_list_both_fail(tmp_path: Path):
    # Both reads fail (the sign-in expired): never read as "not deployed yet", nothing is built.
    done = _deploy_with_failing(tmp_path, "describe", "list")
    assert done.returncode != 0 and "cannot read the settings" in done.stderr
    calls = json.loads((tmp_path / "state.json").read_text())["calls"]
    assert not [c for c in calls if c[:2] == ["builds", "submit"]]


def _bootstrap(tmp_path: Path, secrets: dict[str, list[str]] | None = None, **env: str):
    return _run(tmp_path, "gcp-bootstrap.sh", {"secrets": secrets or {}}, **env)


def test_bootstrap_stores_no_source_secret_and_enables_no_picker_or_drive_api(tmp_path: Path):
    """Even with the sources' old settings in the environment: nothing of them is checked,
    stored, granted or enabled, and the output does not mention them."""
    run = _bootstrap(tmp_path, **STALE_SOURCE_ENV)
    assert run.code == 0, run.output
    assert set(run.state["secrets"]).isdisjoint(SOURCE_SECRETS)
    calls = json.dumps(run.state["calls"])
    for name in (*SOURCE_SECRETS, "picker.googleapis.com", "drive.googleapis.com"):
        assert name not in calls and name not in run.output
    for value in STALE_SOURCE_ENV.values():
        assert value not in calls and value not in run.output
    assert "GitHub" not in run.output and "Drive" not in run.output
