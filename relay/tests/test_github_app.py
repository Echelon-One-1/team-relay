"""PICKERS-SPEC §4.3 (ACC-008): the relay's GitHub App client against a fake GitHub
(``tests/fake_github.py`` on ``httpx.MockTransport``; nothing reaches the network, the key is
made at test time).

The app's JWT (RS256, verified with the public key; ``iat`` 60 s back, ``exp`` 540 s ahead,
``iss`` the app id), installations of the allowed orgs only, installation tokens asked for with
``{"permissions": {"metadata": "read"}}`` and reused until 5 minutes before they expire, one
request in flight per installation, the 60 s listing cache and the 10-minute stale limit,
repositories sorted and capped at 1000 with ``truncated``, malformed data ignored, every
failure mapped to its code, and no log line holding a token or the key."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from relay.github_app import (
    MISCONFIGURED,
    RATE_LIMITED,
    UNAVAILABLE,
    GithubApp,
    GithubError,
)

from .fake_github import (
    APP_ID,
    FakeGithub,
    app_config,
    app_key,
    app_key_pem,
    decode_jwt,
    installation,
    repo,
)

pytestmark = pytest.mark.anyio

ORGS = frozenset({"example-org", "example-labs"})
T0 = 1_800_000_000.0


class Clocks:
    def __init__(self) -> None:
        self.wall_now = T0
        self.mono_now = 1000.0

    def wall(self) -> float:
        return self.wall_now

    def mono(self) -> float:
        return self.mono_now

    def advance(self, seconds: float) -> None:
        self.wall_now += seconds
        self.mono_now += seconds


@pytest.fixture
def clocks() -> Clocks:
    return Clocks()


@pytest.fixture
def github(clocks: Clocks) -> FakeGithub:
    fake = FakeGithub(wall=clocks.wall)
    fake.installations = [
        installation(11, "Example-Org"),
        installation(12, "someone-else"),
        installation(13, "example-labs", selection="selected"),
    ]
    fake.repos = {
        11: [repo(3, "web"), repo(1, "API", private=False), repo(2, "docs", archived=True)],
        12: [repo(9, "not-ours")],
        13: [repo(5, "tools")],
    }
    return fake


@pytest.fixture
async def app(github: FakeGithub, clocks: Clocks) -> AsyncIterator[GithubApp]:
    client = GithubApp(
        app_config(), ORGS, transport=github.transport(), wall=clocks.wall, monotonic=clocks.mono
    )
    try:
        yield client
    finally:
        await client.aclose()


def summary(found: list[Any]) -> list[tuple[str, str, str, list[str], bool]]:
    return [
        (i.account, i.state, i.repository_selection, [r.name for r in i.repos], i.truncated)
        for i in found
    ]


async def test_lists_only_the_allowed_orgs_installations_sorted(app: GithubApp, github):
    found = await app.list_installations()
    assert summary(found) == [
        ("Example-Org", "ok", "all", ["API", "docs", "web"], False),
        ("example-labs", "ok", "selected", ["tools"], False),
    ]
    api = found[0].repos[0]
    assert (api.id, api.private, api.archived) == (1, False, False)
    assert (found[0].repos[1].archived, found[0].repos[2].private) == (True, True)
    # The other org's installation is never asked for a token or listed.
    assert not github.calls("POST", "/app/installations/12/")
    assert all(i.account.lower() in ORGS for i in found)


async def test_the_jwt_is_rs256_from_the_apps_key(app: GithubApp, github, clocks: Clocks):
    await app.list_installations()
    calls = github.calls("GET", "/app/installations")
    token = calls[0].headers["authorization"].removeprefix("Bearer ")
    header, claims = decode_jwt(token, app_key().public_key())
    assert header == {"alg": "RS256", "typ": "JWT"}
    assert claims == {"iat": int(T0) - 60, "exp": int(T0) + 540, "iss": APP_ID}


async def test_every_request_goes_to_the_api_with_githubs_headers(app: GithubApp, github):
    await app.list_installations()
    assert github.seen
    for seen in github.seen:
        assert seen.headers["accept"] == "application/vnd.github+json"
        assert seen.headers["x-github-api-version"] == "2022-11-28"
        assert seen.headers["user-agent"] == "team-relay"
    listed = github.calls("GET", "/installation/repositories")
    assert listed and all(s.query["per_page"] == ["100"] for s in listed)


async def test_tokens_are_narrowed_to_metadata_read(app: GithubApp, github):
    await app.list_installations()
    posts = github.calls("POST", "/app/installations/")
    assert [p.path for p in posts] == [
        "/app/installations/11/access_tokens",
        "/app/installations/13/access_tokens",
    ]
    assert all(p.body == {"permissions": {"metadata": "read"}} for p in posts)


async def test_a_token_is_reused_until_five_minutes_before_it_expires(
    app: GithubApp, github, clocks: Clocks
):
    await app.list_installations()
    assert github.issued == 2
    clocks.advance(61)  # past the listing cache, the tokens still good
    await app.list_installations()
    assert github.issued == 2
    clocks.advance(3600 - 300 - 61 - 62)  # 62 s before the margin
    await app.list_installations()
    assert github.issued == 2
    clocks.advance(63)  # inside the last five minutes: new tokens
    await app.list_installations()
    assert github.issued == 4


async def test_the_token_margin_is_exact(app: GithubApp, github, clocks: Clocks):
    first = await app._token(11)
    clocks.advance(3600 - 300 - 1)
    assert await app._token(11) == first
    clocks.advance(1)
    second = await app._token(11)
    assert second != first and github.issued == 2


async def test_the_listing_is_cached_for_60_seconds(app: GithubApp, github, clocks: Clocks):
    await app.list_installations()
    before = len(github.seen)
    clocks.advance(59)
    await app.list_installations()
    assert len(github.seen) == before
    clocks.advance(2)
    await app.list_installations()
    assert len(github.seen) > before


async def test_one_request_in_flight_per_installation(app: GithubApp, github):
    github.delay = 0.01
    results = await asyncio.gather(*(app.list_installations() for _ in range(5)))
    assert all(summary(r) == summary(results[0]) for r in results)
    assert len(github.calls("GET", "/app/installations")) == 1
    assert github.issued == 2
    assert len(github.calls("GET", "/installation/repositories")) == 2


async def test_one_token_request_in_flight_per_installation(app: GithubApp, github):
    # The token path on its own, without the listing lock in front of it: five callers at once
    # for one installation ask GitHub for one token and all get it.
    github.delay = 0.01
    first = github.installations[0]["id"]
    tokens = await asyncio.gather(*(app._token(first) for _ in range(5)))
    assert len(set(tokens)) == 1
    assert github.issued == 1


async def test_malformed_data_is_ignored(app: GithubApp, github):
    github.installations = [
        installation(11, "example-org"),
        {"id": 0, "account": {"login": "example-org"}, "repository_selection": "all"},
        {"id": "14", "account": {"login": "example-org"}, "repository_selection": "all"},
        {"id": 15, "account": "example-org", "repository_selection": "all"},
        {"id": 16, "account": {"login": "example-org"}, "repository_selection": "some"},
        {"id": 17, "account": {"login": "-bad"}, "repository_selection": "all"},
        "not an installation",
    ]
    github.repos[11] = [
        repo(1, "ok"),
        repo(0, "zero-id"),
        repo(-1, "negative"),
        {**repo(2, "x"), "id": True},
        {**repo(3, "x"), "id": "3"},
        {**repo(4, "x"), "id": 2**53},
        repo(5, "has space"),
        repo(6, "..."),
        repo(7, ""),
        {**repo(8, "flags"), "private": "yes", "archived": 1},
        {"id": 9},
        "not a repo",
        None,
    ]
    found = await app.list_installations()
    assert summary(found) == [("example-org", "ok", "all", ["flags", "ok"], False)]
    flags = found[0].repos[0]
    assert (flags.private, flags.archived) == (False, False)


async def test_a_suspended_installation_lists_nothing_and_gets_no_token(app: GithubApp, github):
    github.installations = [installation(11, "example-org", suspended=True)]
    found = await app.list_installations()
    assert summary(found) == [("example-org", "suspended", "all", [], False)]
    assert github.issued == 0
    assert not github.calls("GET", "/installation/repositories")


async def test_pages_are_followed_and_capped_at_1000(app: GithubApp, github):
    github.installations = [installation(11, "example-org")]
    github.repos[11] = [repo(i + 1, f"r{i:04d}") for i in range(1050)]
    found = await app.list_installations()
    assert len(found[0].repos) == 1000 and found[0].truncated is True
    assert len(github.calls("GET", "/installation/repositories")) == 10
    assert [r.name for r in found[0].repos[:2]] == ["r0000", "r0001"]


async def test_exactly_a_full_page_is_not_truncated(app: GithubApp, github):
    github.installations = [installation(11, "example-org")]
    github.repos[11] = [repo(i + 1, f"r{i:03d}") for i in range(100)]
    found = await app.list_installations()
    assert len(found[0].repos) == 100 and found[0].truncated is False


async def test_installations_are_read_at_most_three_pages(app: GithubApp, github):
    github.installations = [installation(1000 + i, "someone-else") for i in range(400)]
    await app.list_installations()
    assert len(github.calls("GET", "/app/installations")) == 3


def _status(code: int, headers: dict[str, str] | None = None, text: str = "boom"):
    return lambda request: httpx.Response(code, headers=headers or {}, text=text)


@pytest.mark.parametrize(
    "path, failure, code",
    [
        ("/app/installations", _status(500), UNAVAILABLE),
        ("/app/installations", _status(503), UNAVAILABLE),
        ("/app/installations", _status(401), MISCONFIGURED),
        ("/app/installations", _status(200, text="not json"), UNAVAILABLE),
        ("/app/installations", lambda r: httpx.Response(200, json={"not": "a list"}), UNAVAILABLE),
        ("/app/installations", _status(302, {"location": "https://example.com/"}), UNAVAILABLE),
        ("/app/installations/11/access_tokens", _status(401), MISCONFIGURED),
        ("/app/installations/11/access_tokens", _status(502), UNAVAILABLE),
        (
            "/app/installations/11/access_tokens",
            lambda r: httpx.Response(201, json={"token": "has space", "expires_at": "x"}),
            UNAVAILABLE,
        ),
        (
            "/app/installations/11/access_tokens",
            lambda r: httpx.Response(201, json={"token": "ghs_x", "expires_at": "2026-11-11T00"}),
            UNAVAILABLE,
        ),
        ("/installation/repositories", _status(500), UNAVAILABLE),
        ("/installation/repositories", _status(401), UNAVAILABLE),
        ("/installation/repositories", lambda r: httpx.Response(200, json=[]), UNAVAILABLE),
    ],
)
async def test_failures_map_to_their_codes(app: GithubApp, github, path, failure, code):
    github.failures[path] = failure
    with pytest.raises(GithubError) as caught:
        await app.list_installations()
    assert caught.value.code == code


async def test_a_timeout_is_unavailable(app: GithubApp, github):
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    github.failures["/app/installations"] = timeout
    with pytest.raises(GithubError) as caught:
        await app.list_installations()
    assert caught.value.code == UNAVAILABLE


@pytest.mark.parametrize(
    "status, headers, wait",
    [
        (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(int(T0) + 120)}, 120),
        (429, {"retry-after": "30"}, 30),
        (403, {"retry-after": "7200"}, 3600),
        (429, {}, 60),
        (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(int(T0) - 5)}, 1),
    ],
)
async def test_rate_limits_say_when_to_try_again(app: GithubApp, github, status, headers, wait):
    github.failures["/installation/repositories"] = _status(status, headers)
    with pytest.raises(GithubError) as caught:
        await app.list_installations()
    assert (caught.value.code, caught.value.retry_after) == (RATE_LIMITED, wait)


async def test_a_403_without_rate_limit_headers_is_unavailable(app: GithubApp, github):
    github.failures["/installation/repositories"] = _status(403, {"x-ratelimit-remaining": "12"})
    with pytest.raises(GithubError) as caught:
        await app.list_installations()
    assert caught.value.code == UNAVAILABLE


async def test_a_refused_token_is_dropped(app: GithubApp, github, clocks: Clocks):
    first = summary(await app.list_installations())
    assert github.issued == 2
    github.tokens.clear()  # GitHub revoked them
    clocks.advance(61)
    # The refresh fails, so the listing still a minute old answers ...
    assert summary(await app.list_installations()) == first
    assert github.issued == 2
    clocks.advance(61)
    # ... and the next refresh mints new tokens instead of reusing the refused ones.
    assert summary(await app.list_installations()) == first
    assert github.issued == 4


async def test_a_failed_refresh_serves_what_is_at_most_ten_minutes_old(
    app: GithubApp, github, clocks: Clocks
):
    first = summary(await app.list_installations())
    github.failures["/app/installations"] = _status(500)
    clocks.advance(599)
    assert summary(await app.list_installations()) == first
    clocks.advance(2)
    with pytest.raises(GithubError) as caught:
        await app.list_installations()
    assert caught.value.code == UNAVAILABLE


async def test_no_log_line_holds_a_token_or_the_key(app: GithubApp, github, capsys, clocks):
    await app.list_installations()
    github.failures["/installation/repositories"] = _status(500, text="ghs_leaked_in_body")
    clocks.advance(700)
    with pytest.raises(GithubError):
        await app.list_installations()
    out = capsys.readouterr()
    text = out.out + out.err
    assert "github_failed" in text
    for token in github.tokens:
        assert token not in text
    assert "ghs_" not in text
    assert "PRIVATE KEY" not in text and app_key_pem()[40:80] not in text
    assert "boom" not in text


def test_the_config_never_shows_the_key():
    assert "PRIVATE" not in repr(app_config()) and "RSAPrivateKey" not in repr(app_config())
