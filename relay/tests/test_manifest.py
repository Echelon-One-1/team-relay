"""Manifests (M1-SPEC §3.3), the directory (§3.4) and param validation rules (§3.5)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
import yaml

from relay.config import load_schema
from relay.manifest import (
    ManifestError,
    ManifestValidator,
    ParamsError,
    compile_pattern,
    validate_params,
)

from .conftest import MANIFEST, PLUGIN_MANIFEST, SCHEMA_PATH, TOKENS, auth, team_config_data

pytestmark = pytest.mark.anyio

URL = "/v1/teams/demo/members/{}/manifest"


@pytest.fixture(scope="module")
def validator() -> ManifestValidator:
    return ManifestValidator(load_schema(SCHEMA_PATH))


def test_plugin_manifest_is_accepted(validator):
    manifest = yaml.safe_load(PLUGIN_MANIFEST.read_text())
    names = validator.validate(manifest)
    assert "staging_db_query" in names


def test_fixture_manifest_is_accepted(validator):
    assert validator.validate(MANIFEST) == ["staging_db_query", "service_health"]


def _cap(manifest: dict[str, Any], i: int = 0) -> dict[str, Any]:
    return manifest["capabilities"][i]


def _string_param(pattern: str, **extra: Any) -> dict[str, Any]:
    return {"type": "string", "max_length": 10, "pattern": pattern, "description": "d", **extra}


BAD_MANIFESTS = [
    # schema
    ("not an object", lambda m: "manifest", "schema"),
    ("wrong version", lambda m: {**m, "version": 2}, "schema"),
    ("extra top-level key", lambda m: {**m, "from": "alice"}, "schema"),
    (
        "free-form string (no pattern)",
        lambda m: _cap(m)["params"].__setitem__(
            "query", {"type": "string", "max_length": 5, "description": "d"}
        ),
        "schema",
    ),
    (
        "pattern not anchored at the start",
        lambda m: _cap(m)["params"].__setitem__("query", _string_param("abc$")),
        "schema",
    ),
    # relay-side checks
    (
        "pattern ending in an escaped dollar",
        lambda m: _cap(m)["params"].__setitem__("query", _string_param("^abc\\$")),
        "anchored",
    ),
    (
        "pattern that does not compile",
        lambda m: _cap(m)["params"].__setitem__("query", _string_param("^(abc$")),
        "compile",
    ),
    (
        "required names a missing param",
        lambda m: _cap(m).__setitem__("required", ["dataset", "nope"]),
        "required 'nope'",
    ),
    (
        "enum default outside values",
        lambda m: _cap(m)["params"]["dataset"].__setitem__("default", "secrets"),
        "default",
    ),
    (
        "integer default above max",
        lambda m: _cap(m)["params"]["limit"].__setitem__("default", 101),
        "default",
    ),
    (
        "string default not matching its pattern",
        lambda m: _cap(m)["params"].__setitem__("query", _string_param("^[a-z]*$", default="ABC")),
        "default",
    ),
    (
        "string default longer than max_length",
        lambda m: _cap(m)["params"].__setitem__(
            "query", _string_param("^[a-z]*$", default="a" * 11)
        ),
        "default",
    ),
    (
        "integer min above max",
        lambda m: _cap(m)["params"]["limit"].update({"min": 50, "max": 10, "default": 20}),
        "min",
    ),
    (
        "number min above max",
        lambda m: _cap(m)["params"].__setitem__(
            "ratio", {"type": "number", "min": 1.5, "max": 1.0, "description": "d"}
        ),
        "min",
    ),
    (
        "duplicate capability names",
        lambda m: m["capabilities"].append(copy.deepcopy(_cap(m))),
        "twice",
    ),
    # A schema pattern's final $ is the end of the string, as in JSON Schema and the plugin,
    # not Python's "or before a trailing newline".
    (
        "capability name with a trailing newline",
        lambda m: _cap(m).__setitem__("name", "staging_db_query\n"),
        "does not match",
    ),
    (
        "param name with a trailing newline",
        lambda m: _cap(m)["params"].__setitem__("query\n", _string_param("^[a-z]*$")),
        "does not match",
    ),
    (
        "enum value with a trailing newline",
        lambda m: _cap(m)["params"]["dataset"]["values"].append("orders\n"),
        "at capabilities/0/params/dataset",
    ),
]


@pytest.mark.parametrize("label, mutate, message", BAD_MANIFESTS, ids=[b[0] for b in BAD_MANIFESTS])
def test_bad_manifests_are_refused(validator, label, mutate, message):
    manifest = copy.deepcopy(MANIFEST)
    result = mutate(manifest)
    if result is not None:
        manifest = result
    with pytest.raises(ManifestError) as exc:
        validator.validate(manifest)
    assert message in str(exc.value)


async def test_put_manifest_publishes_and_directory_shows_it(client, clock):
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=MANIFEST)
    assert r.status_code == 200
    assert r.json() == {
        "published_at": "2026-09-23T12:00:00.000Z",
        "capabilities": ["staging_db_query", "service_health"],
    }
    r = await client.get("/v1/teams/demo/directory", headers=auth("alice"))
    assert r.status_code == 200
    members = r.json()["members"]
    assert [m["member"] for m in members] == ["bob", "carol"]  # never the caller
    assert members[0]["manifest"] == MANIFEST
    assert members[0]["published_at"] == "2026-09-23T12:00:00.000Z"
    assert members[1] == {
        "member": "carol",
        "last_seen": None,
        "manifest": None,
        "published_at": None,
        "sessions": {"working": {"last_seen": None}, "answering": {"last_seen": None}},
        "stats": {"asked": 0, "answered": 0, "open": 0, "median_answer_seconds": None},
        "inbox_waiting": 0,
    }


async def test_put_manifest_for_someone_else_is_403_and_audited(client, memory_store):
    r = await client.put(URL.format("carol"), headers=auth("bob"), json=MANIFEST)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    r = await client.put(URL.format("Not-A-Member"), headers=auth("bob"), json=MANIFEST)
    assert r.status_code == 403
    audit = await memory_store.list_audit("demo")
    assert [(a.actor, a.action, a.detail) for a in audit] == [
        ("bob", "manifest.publish", "403 forbidden"),
        ("bob", "manifest.publish", "403 forbidden"),
    ]
    assert (await memory_store.get_members("demo", ["carol"])) == {}


@pytest.mark.parametrize(
    "label, mutate, message", BAD_MANIFESTS[:9], ids=[b[0] for b in BAD_MANIFESTS[:9]]
)
async def test_put_bad_manifest_is_422(client, memory_store, label, mutate, message):
    manifest = copy.deepcopy(MANIFEST)
    result = mutate(manifest)
    if result is not None:
        manifest = result
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=manifest)
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_manifest" and message in r.json()["detail"]
    audit = await memory_store.list_audit("demo")
    assert [(a.action, a.outcome, a.detail) for a in audit] == [
        ("manifest.publish", "refused", "422 invalid_manifest")
    ]


async def test_put_manifest_rejects_non_json(client):
    r = await client.put(
        URL.format("bob"),
        headers={**auth("bob"), "Content-Type": "application/json"},
        content=b"{nope",
    )
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"
    r = await client.put(URL.format("bob"), headers=auth("bob"), content=b'{"version": NaN}')
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"


async def test_last_seen_is_the_later_of_the_two_sessions(client, clock):
    # M2-SPEC §3.1 replaces M1 §3.4's once-a-minute last_seen: each stream records its own
    # presence at most every 15 s, and last_seen is the later of the two.
    async def bob() -> dict:
        r = await client.get("/v1/teams/demo/directory", headers=auth("alice"))
        return r.json()["members"][0]

    assert (await bob())["last_seen"] is None
    await client.get("/v1/teams/demo/streams/inbox", headers=auth("bob"))
    assert (await bob())["last_seen"] == "2026-09-23T12:00:00.000Z"
    clock.advance(10)
    await client.get("/v1/teams/demo/streams/inbox", headers=auth("bob"))  # throttled
    assert (await bob())["last_seen"] == "2026-09-23T12:00:00.000Z"
    await client.get("/v1/teams/demo/streams/replies", headers=auth("bob"))
    entry = await bob()
    assert entry["last_seen"] == "2026-09-23T12:00:10.000Z"
    assert entry["sessions"] == {
        "working": {"last_seen": "2026-09-23T12:00:10.000Z"},
        "answering": {"last_seen": "2026-09-23T12:00:00.000Z"},
    }


# Param validation, unit level ----------------------------------------------------------------

CAP = MANIFEST["capabilities"][0]


def test_params_defaults_are_filled():
    assert validate_params(CAP, {"dataset": "users"}) == {"dataset": "users", "limit": 20}
    assert validate_params(CAP, {"dataset": "users", "limit": 5, "filter": "a = 'b'"}) == {
        "dataset": "users",
        "filter": "a = 'b'",
        "limit": 5,
    }


@pytest.mark.parametrize(
    "params, first",
    [
        ({"dataset": "users", "limit": 500}, "param 'limit': above max"),
        ({"dataset": "users", "limit": 0}, "param 'limit': below min"),
        ({"dataset": "secrets"}, "param 'dataset': not one of"),
        ({"dataset": "users", "extra": 1}, "param 'extra': not a parameter"),
        ({}, "param 'dataset': required"),
        ({"dataset": "users", "limit": "5"}, "param 'limit': expected an integer"),
        ({"dataset": "users", "limit": 5.5}, "param 'limit': expected an integer"),
        ({"dataset": "users", "limit": True}, "param 'limit': expected an integer"),
        ({"dataset": 1}, "param 'dataset': expected one of"),
        ({"dataset": "users", "filter": "x; DROP TABLE users"}, "param 'filter': does not match"),
        ({"dataset": "users", "filter": "a" * 201}, "param 'filter': longer than"),
        ({"dataset": "users", "filter": "a\n"}, "param 'filter': does not match"),
        # The first failure wins: unknown keys before declared params.
        ({"zzz": 1, "dataset": "secrets"}, "param 'zzz'"),
    ],
)
def test_params_errors_name_the_first_failing_param(params, first):
    with pytest.raises(ParamsError) as exc:
        validate_params(CAP, params)
    assert str(exc.value).startswith(first)


def test_number_and_boolean_params():
    cap = {
        "name": "c",
        "params": {
            "ratio": {"type": "number", "min": 0, "max": 1, "description": "d"},
            "flag": {"type": "boolean", "default": False, "description": "d"},
        },
        "required": ["ratio"],
    }
    assert validate_params(cap, {"ratio": 0.5}) == {"ratio": 0.5, "flag": False}
    assert validate_params(cap, {"ratio": 1, "flag": True}) == {"ratio": 1, "flag": True}
    for bad in (
        {"ratio": 1.5},
        {"ratio": float("nan")},
        {"ratio": True},
        {"ratio": 0.5, "flag": 1},
    ):
        with pytest.raises(ParamsError):
            validate_params(cap, bad)


# RE2 patterns (M1-SPEC §11.1) ----------------------------------------------------------------


def _cap_with(param: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "version": 1,
        "capabilities": [
            {
                "name": "probe",
                "title": "t",
                "description": "d",
                "environment": "staging",
                "params": {"val": param},
                "required": required if required is not None else [],
            }
        ],
    }


def test_patterns_are_compiled_by_re2():
    compiled = compile_pattern("^[a-z]+$")
    assert type(compiled).__module__.split(".")[0] == "re2"


# Run in a child process so a regression to a backtracking engine fails on the timeout
# instead of hanging the suite: Python's `re` holds the GIL in C, so no in-process timer
# could interrupt it.
_REDOS_SCRIPT = r"""
import asyncio, copy, json, sys, time
import httpx
from relay.app import create_app
from relay.config import Settings, load_schema, parse_team_config
from relay.manifest import (
    ManifestError,
    ManifestValidator,
    ParamsError,
    compile_pattern,
    validate_params,
)
from relay.store_memory import MemoryStore

schema_path, config_json, bob_token, alice_token = sys.argv[1:5]
schema = load_schema(schema_path)
evil = "^(a+)+$"
value = "a" * 499 + "!"
cap = {"name": "probe", "title": "t", "description": "d", "environment": "staging",
       "params": {"val": {"type": "string", "max_length": 500, "pattern": evil,
                        "description": "d"}},
       "required": ["val"]}
manifest = {"version": 1, "capabilities": [cap]}
started = time.monotonic()

# The request path: params checked against a teammate's pattern.
try:
    validate_params(cap, {"val": value})
    raise SystemExit("matched")
except ParamsError:
    pass

# The publish path: a default checked against its own pattern.
with_default = copy.deepcopy(manifest)
with_default["capabilities"][0]["required"] = []
with_default["capabilities"][0]["params"]["val"]["default"] = value
try:
    ManifestValidator(schema).validate(with_default)
    raise SystemExit("accepted")
except ManifestError:
    pass

# Through the app, both paths.
async def main():
    settings = Settings(team_config=parse_team_config(json.loads(config_json)),
                        manifest_schema=schema, auth_mode="static")
    app = create_app(settings, MemoryStore())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://relay") as c:
        bob = {"Authorization": "Bearer " + bob_token}
        alice = {"Authorization": "Bearer " + alice_token}
        url = "/v1/teams/demo/members/bob/manifest"
        r = await c.put(url, headers=bob, json=with_default)
        assert r.status_code == 422, r.text
        r = await c.put(url, headers=bob, json=manifest)
        assert r.status_code == 200, r.text
        body = {"idempotency_key": "redos-key-1", "kind": "capability", "to": ["bob"],
                "capability": {"name": "probe", "params": {"val": value}}}
        r = await c.post("/v1/teams/demo/requests", headers=alice, json=body)
        assert r.status_code == 422 and r.json()["error"] == "invalid_params", r.text

asyncio.run(main())
print(round(time.monotonic() - started, 3))
"""


def test_catastrophic_backtracking_patterns_run_in_linear_time():
    import json
    import subprocess
    import sys

    config = json.dumps(team_config_data())
    try:
        done = subprocess.run(
            [
                sys.executable,
                "-c",
                _REDOS_SCRIPT,
                str(SCHEMA_PATH),
                config,
                TOKENS["bob"],
                TOKENS["alice"],
            ],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(SCHEMA_PATH.parent.parent / "relay"),
        )
    except subprocess.TimeoutExpired:
        pytest.fail("a backtracking pattern stalled validation: patterns are not run by RE2")
    assert done.returncode == 0, done.stderr[-2000:]
    assert float(done.stdout.strip().splitlines()[-1]) < 10


@pytest.mark.parametrize(
    "pattern, message",
    [
        ("^(a)\\1$", "RE2"),  # backreference: not RE2
        ("^(?=a)a$", "RE2"),  # lookahead: not RE2
        ("^(?<=a)a$", "RE2"),  # lookbehind: not RE2
        ("^a{1001}$", "RE2"),  # repetition beyond RE2's bound
        ("^(abc$", "compile"),
        ("^\\C$", "\\C"),
        ("^a\\\\\\$", "anchored"),  # ends in an escaped dollar
        ("abc$", "schema"),  # the schema refuses these before the relay's own check
        ("^abc", "schema"),
    ],
)
def test_patterns_must_compile_in_re2_and_be_anchored(validator, pattern, message):
    with pytest.raises(ManifestError) as exc:
        validator.validate(_cap_with(_string_param(pattern)))
    assert message in str(exc.value)


def test_pattern_length_cap():
    compile_pattern("^" + "a" * 298 + "$")  # 300: fine
    with pytest.raises(ManifestError, match="longer than 300"):
        compile_pattern("^" + "a" * 299 + "$")


async def test_a_pattern_over_300_characters_is_422(client):
    manifest = _cap_with(_string_param("^" + "a" * 299 + "$"))
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=manifest)
    assert r.status_code == 422 and r.json()["error"] == "invalid_manifest"


def test_patterns_are_a_full_match_of_the_whole_value():
    cap = _cap_with(_string_param("^ab|cd$", max_length=10))["capabilities"][0]
    assert validate_params(cap, {"val": "ab"}) == {"val": "ab"}
    assert validate_params(cap, {"val": "cd"}) == {"val": "cd"}
    for bad in ("abcd", "abx", "xcd", "ab\n", "cd\n"):
        with pytest.raises(ParamsError, match="does not match"):
            validate_params(cap, {"val": bad})


def test_patterns_and_max_length_count_code_points():
    cap = _cap_with(_string_param("^.{1,3}$", max_length=3))["capabilities"][0]
    assert validate_params(cap, {"val": "😀😀😀"}) == {"val": "😀😀😀"}  # 3 code points, 6 UTF-16
    with pytest.raises(ParamsError, match="longer than max_length"):
        validate_params(cap, {"val": "😀😀😀😀"})


def test_lone_surrogates_are_refused_in_params_and_manifests(validator):
    cap = _cap_with(_string_param("^.*$", max_length=10))["capabilities"][0]
    for bad in ("\ud800", "a\udfffb"):
        with pytest.raises(ParamsError, match="lone surrogate"):
            validate_params(cap, {"val": bad})
    with pytest.raises(ParamsError):
        validate_params(cap, {"\ud800": "x"})
    manifest = _cap_with(_string_param("^.*$"))
    manifest["capabilities"][0]["description"] = "bad \udc00 text"
    with pytest.raises(ManifestError, match="lone surrogate"):
        validator.validate(manifest)
    with pytest.raises(ManifestError, match="lone surrogate"):
        compile_pattern("^\ud800$")


# Param rules, one reading on both sides (M1-SPEC §11.2) ---------------------------------------


def test_a_required_param_may_not_declare_a_default(validator):
    manifest = _cap_with(
        {"type": "integer", "min": 1, "max": 9, "default": 2, "description": "d"}, ["val"]
    )
    with pytest.raises(ManifestError, match="required 'val' may not declare a default"):
        validator.validate(manifest)


async def test_a_required_param_with_a_default_is_422(client):
    manifest = copy.deepcopy(MANIFEST)
    manifest["capabilities"][0]["params"]["dataset"]["default"] = "users"
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=manifest)
    assert r.status_code == 422 and "may not declare a default" in r.json()["detail"]


def test_request_id_is_a_reserved_param_name(validator):
    manifest = _cap_with(_string_param("^rq_[0-9a-f]{32}$", max_length=35))
    manifest["capabilities"][0]["params"] = {
        "request_id": manifest["capabilities"][0]["params"]["val"]
    }
    with pytest.raises(ManifestError, match="reserved"):
        validator.validate(manifest)


INT_CAP = _cap_with({"type": "integer", "min": -(2**60), "max": 2**60, "description": "d"})[
    "capabilities"
][0]
NUM_CAP = _cap_with({"type": "number", "min": -1e300, "max": 1e300, "description": "d"})[
    "capabilities"
][0]


@pytest.mark.parametrize(
    "value, expected",
    [
        (5, 5),
        (5.0, 5),
        (-0.0, 0),
        (2**53, 2**53),
        (-(2**53), -(2**53)),
        (9007199254740992.0, 2**53),
    ],
)
def test_integer_accepts_integral_numbers_and_normalises(value, expected):
    out = validate_params(INT_CAP, {"val": value})["val"]
    assert out == expected and type(out) is int


@pytest.mark.parametrize(
    "value, message",
    [
        (5.5, "expected an integer"),
        (2**53 + 1, "beyond 2\\^53"),
        (-(2**53) - 1, "beyond 2\\^53"),
        (1e300, "beyond 2\\^53"),
        (10**400, "beyond 2\\^53"),  # would overflow a float conversion
        (float("inf"), "finite"),
        (float("nan"), "finite"),
        (True, "expected an integer"),
        ("5", "expected an integer"),
    ],
)
def test_integer_refusals(value, message):
    with pytest.raises(ParamsError, match=message):
        validate_params(INT_CAP, {"val": value})


def test_number_magnitude_and_finiteness():
    assert validate_params(NUM_CAP, {"val": 0.5}) == {"val": 0.5}
    assert validate_params(NUM_CAP, {"val": 2**53}) == {"val": 2**53}
    assert validate_params(NUM_CAP, {"val": -9007199254740992.0}) == {"val": -9007199254740992.0}
    for bad in (2**53 + 1, 1e300, -1e17, 10**400, -(10**400), float("inf"), float("-inf")):
        with pytest.raises(ParamsError):
            validate_params(NUM_CAP, {"val": bad})


def test_integer_defaults_are_normalised_when_filled(validator):
    manifest = _cap_with(
        {"type": "integer", "min": 1, "max": 9, "default": 3.0, "description": "d"}
    )
    validator.validate(manifest)
    out = validate_params(manifest["capabilities"][0], {})
    assert out == {"val": 3} and type(out["val"]) is int


@pytest.mark.parametrize(
    "param",
    [
        {"type": "integer", "min": 1, "max": 10**400, "default": 10**400, "description": "d"},
        {"type": "number", "min": 0, "max": 10**400, "default": 10**400, "description": "d"},
        {"type": "number", "min": 0, "max": 1e308, "default": 1e300, "description": "d"},
    ],
)
async def test_defaults_beyond_2_53_make_the_manifest_invalid_never_a_500(client, param):
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=_cap_with(param))
    assert r.status_code == 422 and r.json()["error"] == "invalid_manifest"
    assert "default" in r.json()["detail"]


async def test_huge_bounds_without_defaults_are_accepted(client):
    param = {"type": "number", "min": -(10**400), "max": 10**400, "description": "d"}
    r = await client.put(URL.format("bob"), headers=auth("bob"), json=_cap_with(param))
    assert r.status_code == 200


# M4-SPEC §3: the optional shares list ---------------------------------------------------------


def _with_shares(shares: Any) -> dict[str, Any]:
    return {**copy.deepcopy(MANIFEST), "shares": shares}


@pytest.mark.parametrize(
    "shares",
    [
        [],
        [{"name": "docs"}],
        [{"name": "a"}, {"name": "x" * 64}, {"name": "A-z_0.9"}, {"name": "..."}],
        [{"name": "Docs"}, {"name": "docs"}, {"name": "DOCS"}],  # case-sensitive: all distinct
        [{"name": f"share-{i:02d}"} for i in range(16)],
    ],
    ids=["empty", "one", "bounds", "case", "sixteen"],
)
def test_shares_are_accepted(validator, shares):
    assert validator.validate(_with_shares(shares)) == ["staging_db_query", "service_health"]


def test_a_manifest_without_shares_is_still_accepted(validator):
    assert "shares" not in MANIFEST
    assert validator.validate(copy.deepcopy(MANIFEST)) == ["staging_db_query", "service_health"]


BAD_SHARES = [
    ("not a list", {"name": "docs"}),
    ("a string", "docs"),
    ("null", None),
    ("seventeen", [{"name": f"share-{i:02d}"} for i in range(17)]),
    ("a bare string item", ["docs"]),
    ("a null item", [None]),
    ("no name", [{}]),
    (
        "an extra key",
        [{"name": "docs", "path": "/Users/bob/docs"}],  # e1-guard: allow (synthetic test path)
    ),
    ("a path key only", [{"path": "/Users/bob/docs"}]),  # e1-guard: allow (synthetic test path)
    ("empty name", [{"name": ""}]),
    ("65 characters", [{"name": "x" * 65}]),
    ("a full path", [{"name": "/Users/bob/docs"}]),  # e1-guard: allow (synthetic test path)
    ("a relative path", [{"name": "bob/docs"}]),
    ("a home path", [{"name": "~"}]),
    ("a backslash", [{"name": "a\\b"}]),
    ("a space", [{"name": "my docs"}]),
    ("a trailing newline", [{"name": "docs\n"}]),
    ("a leading newline", [{"name": "\ndocs"}]),
    ("non-ASCII", [{"name": "döcs"}]),
    ("a number", [{"name": 5}]),
    ("a null name", [{"name": None}]),
    ("the same name twice", [{"name": "docs"}, {"name": "docs"}]),
]


@pytest.mark.parametrize("label, shares", BAD_SHARES, ids=[b[0] for b in BAD_SHARES])
def test_bad_shares_are_refused(validator, label, shares):
    with pytest.raises(ManifestError) as exc:
        validator.validate(_with_shares(shares))
    assert "shares" in str(exc.value)


def test_duplicate_share_names_are_refused_by_the_relay_check_too():
    """The relay's own check, not only the schema's uniqueItems (M4-SPEC §3)."""
    schema = copy.deepcopy(load_schema(SCHEMA_PATH))
    del schema["properties"]["shares"]["uniqueItems"]
    lax = ManifestValidator(schema)
    assert lax.validate(_with_shares([{"name": "docs"}, {"name": "Docs"}]))
    with pytest.raises(ManifestError, match="share 'docs': name used twice"):
        lax.validate(_with_shares([{"name": "docs"}, {"name": "notes"}, {"name": "docs"}]))


async def test_shares_round_trip_through_publish_and_directory(api):
    shares = [{"name": "notes"}, {"name": "Docs"}, {"name": "runbooks.v2"}]
    published = _with_shares(shares)
    r = await api.client.put(api.url("/members/bob/manifest"), headers=auth("bob"), json=published)
    assert r.status_code == 200, r.text
    assert r.json()["capabilities"] == ["staging_db_query", "service_health"]
    directory = await api.directory("alice")
    assert directory["bob"]["manifest"] == published  # as published, order kept
    assert directory["bob"]["manifest"]["shares"] == shares
    # A manifest without shares comes back without the key; one with none, with [].
    await api.publish("carol")
    r = await api.client.put(
        api.url("/members/bob/manifest"), headers=auth("bob"), json=_with_shares([])
    )
    assert r.status_code == 200
    directory = await api.directory("alice")
    assert "shares" not in directory["carol"]["manifest"]
    assert directory["bob"]["manifest"]["shares"] == []


@pytest.mark.parametrize(
    "shares",
    [
        [{"name": "/Users/bob/docs"}],  # e1-guard: allow (synthetic test path)
        [{"name": "docs", "path": "/Users/bob/docs"}],  # e1-guard: allow (synthetic test path)
        [{"name": "docs"}, {"name": "docs"}],
        [{"name": f"s{i}"} for i in range(17)],
    ],
    ids=["path", "extra key", "twice", "seventeen"],
)
async def test_a_manifest_with_bad_shares_is_422_and_not_stored(api, shares):
    await api.publish("bob")
    api.clock.advance(1)  # the audit lists by time
    r = await api.client.put(
        api.url("/members/bob/manifest"), headers=auth("bob"), json=_with_shares(shares)
    )
    assert r.status_code == 422 and r.json()["error"] == "invalid_manifest"
    assert "shares" in r.json()["detail"]
    assert (await api.directory("alice"))["bob"]["manifest"] == MANIFEST  # the earlier one
    audit = [a for a in await api.store.list_audit(api.team) if a.action == "manifest.publish"]
    assert [(a.outcome, a.detail) for a in audit] == [
        ("published", None),
        ("refused", "422 invalid_manifest"),
    ]
