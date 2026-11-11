"""The relay's read-only GitHub App (PICKERS-SPEC §4): installation tokens and repository
listings for the console's picker. The app has one permission, Metadata: read.

- HTTP: ``https://api.github.com`` only, no redirects followed, a 10 s timeout, GitHub's JSON
  media type and API version, ``User-Agent: team-relay``.
- The app's JWT (RS256 with the private key; ``iat`` 60 s back, ``exp`` 540 s ahead, ``iss``
  the app id) is made for each call and never kept.
- Installations: ``GET /app/installations`` (the JWT), at most 3 pages of 100; only those whose
  ``account.login`` (lower case) is one of the relay's allowed orgs are kept.
- An installation token: ``POST /app/installations/{id}/access_tokens`` asking for
  ``{"permissions": {"metadata": "read"}}`` only (narrowed even if the app ever gains more);
  kept in this process's memory until 5 minutes before its ``expires_at``, one request in
  flight per installation, never written anywhere or logged.
- Repositories: ``GET /installation/repositories``, at most 10 pages of 100; a repository is
  kept only when its ``name`` passes the repository rule and its ``id`` is a positive
  integer. Everything else in GitHub's answers is data, never trusted to be shaped.
- The listing of each installation (and the installations themselves) are kept for 60 s, so an
  owner ticking boxes costs GitHub nothing; when a refresh fails, what was read less than 10
  minutes ago is answered instead, never anything older.

Failures are :class:`GithubError` with a code of PICKERS-SPEC §3.6; GitHub's own text is never
passed on, and no log line holds a token or the key.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from .boundaries import MAX_REPO_ID, org_ok, repo_name_ok
from .config import GithubAppConfig
from .log import log_event

API = "https://api.github.com"
HTTP_TIMEOUT = 10.0
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "team-relay",
}
JWT_BACKDATE = 60
JWT_LIFETIME = 540  # GitHub's limit is 10 minutes
TOKEN_MARGIN = 300  # a token is renewed this long before it expires
PER_PAGE = 100
MAX_INSTALLATION_PAGES = 3
MAX_REPO_PAGES = 10
MAX_REPOS = MAX_REPO_PAGES * PER_PAGE
LISTING_TTL = 60.0
STALE_LIMIT = 600.0  # a failed refresh never answers anything older
MAX_RETRY_AFTER = 3600
# What a token GitHub hands back may look like (theirs are ghs_ and letters and digits).
TOKEN_RE = re.compile(r"[A-Za-z0-9_.-]{1,512}")

UNAVAILABLE = "github_unavailable"
MISCONFIGURED = "github_app_misconfigured"
RATE_LIMITED = "github_rate_limited"


class GithubError(Exception):
    """GitHub did not give a usable answer. ``code`` is one of PICKERS-SPEC §3.6;
    ``retry_after`` the seconds to wait (rate limited only)."""

    def __init__(self, code: str, retry_after: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


@dataclass(frozen=True)
class Repo:
    name: str
    id: int
    private: bool
    archived: bool


@dataclass(frozen=True)
class Installation:
    """One installation on an allowed org: ``account`` as GitHub spells the login, ``state``
    ``ok`` or ``suspended`` (no repositories), ``repos`` sorted by lower-case name (at most
    1000; ``truncated`` when there are more), ``fetched_at`` the wall-clock time (seconds) it
    was read from GitHub."""

    id: int
    account: str
    state: str
    repository_selection: str
    repos: tuple[Repo, ...]
    truncated: bool
    fetched_at: float


@dataclass
class _Cached[T]:
    value: T
    at: float  # monotonic


@dataclass(frozen=True)
class _Token:
    token: str
    expires_at: float  # wall clock


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _positive_int(value: Any) -> bool:
    return type(value) is int and 1 <= value <= MAX_REPO_ID


def _retry_after(response: httpx.Response, now: float) -> int | None:
    """Seconds to wait when ``response`` says the budget is spent (403/429), else None."""
    if response.status_code not in (403, 429):
        return None
    after = response.headers.get("retry-after")
    remaining = response.headers.get("x-ratelimit-remaining")
    if after is not None and after.isascii() and after.isdigit():
        return max(1, min(int(after), MAX_RETRY_AFTER))
    if remaining == "0":
        reset = response.headers.get("x-ratelimit-reset")
        wait = 60
        if reset is not None and reset.isascii() and reset.isdigit():
            wait = int(reset) - int(now)
        return max(1, min(wait, MAX_RETRY_AFTER))
    if response.status_code == 429:
        return 60
    return None


class GithubApp:
    """The app's client for one relay instance. ``orgs`` is RELAY_GITHUB_ORGS (lower case).
    Tests pass ``transport`` (an ``httpx.MockTransport``) and the clocks; nothing in the
    environment can point it elsewhere than ``api.github.com``."""

    def __init__(
        self,
        config: GithubAppConfig,
        orgs: frozenset[str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        wall: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._orgs = frozenset(o.lower() for o in orgs)
        self._wall = wall
        self._monotonic = monotonic
        self._client = httpx.AsyncClient(
            base_url=API,
            headers=HEADERS,
            timeout=HTTP_TIMEOUT,
            follow_redirects=False,
            transport=transport,
        )
        self._tokens: dict[int, _Token] = {}
        self._token_locks: dict[int, asyncio.Lock] = {}
        self._index: _Cached[list[dict[str, Any]]] | None = None
        self._index_lock = asyncio.Lock()
        self._listings: dict[int, _Cached[Installation]] = {}
        self._listing_locks: dict[int, asyncio.Lock] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    def now(self) -> float:
        """The wall clock this client reads (seconds)."""
        return self._wall()

    # The JWT and requests -------------------------------------------------------------------
    def _jwt(self) -> str:
        now = int(self._wall())
        header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        claims = {"iat": now - JWT_BACKDATE, "exp": now + JWT_LIFETIME, "iss": self._config.app_id}
        payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{header}.{payload}".encode("ascii")
        signature = self._config.private_key.sign(
            signing_input, padding.PKCS1v15(), hashes.SHA256()
        )
        return f"{header}.{payload}.{_b64(signature)}"

    async def _call(
        self,
        method: str,
        path: str,
        *,
        bearer: str,
        as_app: bool,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        """One request; the JSON answer of a 2xx, else :class:`GithubError`. ``as_app``: the
        bearer is the app's JWT (so 401 means GitHub refused the app itself)."""
        try:
            response = await self._client.request(
                method,
                path,
                params=params,
                json=body,
                headers={"Authorization": f"Bearer {bearer}"},
            )
        except httpx.HTTPError as exc:
            log_event("github_failed", severity="WARNING", reason=type(exc).__name__, path=path)
            raise GithubError(UNAVAILABLE) from None
        status = response.status_code
        if 200 <= status < 300:
            try:
                return response.json()
            except ValueError:
                log_event("github_failed", severity="WARNING", reason="not_json", path=path)
                raise GithubError(UNAVAILABLE) from None
        wait = _retry_after(response, self._wall())
        log_event("github_failed", severity="WARNING", status=status, path=path)
        if wait is not None:
            raise GithubError(RATE_LIMITED, wait)
        if status == 401 and as_app:
            raise GithubError(MISCONFIGURED)
        raise GithubError(UNAVAILABLE)

    # Installations --------------------------------------------------------------------------
    async def _installations(self) -> list[dict[str, Any]]:
        """The allowed orgs' installations as ``{id, account, state, repository_selection}``,
        from GitHub or the 60 s cache."""
        async with self._index_lock:
            now = self._monotonic()
            cached = self._index
            if cached is not None and now - cached.at < LISTING_TTL:
                return cached.value
            try:
                found: list[dict[str, Any]] = []
                for page in range(1, MAX_INSTALLATION_PAGES + 1):
                    answer = await self._call(
                        "GET",
                        "/app/installations",
                        bearer=self._jwt(),
                        as_app=True,
                        params={"per_page": PER_PAGE, "page": page},
                    )
                    if not isinstance(answer, list):
                        raise GithubError(UNAVAILABLE)
                    for raw in answer:
                        entry = self._installation(raw)
                        if entry is not None:
                            found.append(entry)
                    if len(answer) < PER_PAGE:
                        break
            except GithubError:
                if cached is not None and now - cached.at <= STALE_LIMIT:
                    return cached.value
                raise
            self._index = _Cached(found, now)
            return found

    def _installation(self, raw: Any) -> dict[str, Any] | None:
        """An installation of GitHub's answer, when it is well formed and on an allowed org."""
        if not isinstance(raw, dict) or not _positive_int(raw.get("id")):
            return None
        account = raw.get("account")
        login = account.get("login") if isinstance(account, dict) else None
        if not isinstance(login, str) or not org_ok(login) or login.lower() not in self._orgs:
            return None
        selection = raw.get("repository_selection")
        if selection not in ("all", "selected"):
            return None
        return {
            "id": raw["id"],
            "account": login,
            "state": "suspended" if raw.get("suspended_at") is not None else "ok",
            "repository_selection": selection,
        }

    # Tokens ---------------------------------------------------------------------------------
    async def _token(self, installation: int) -> str:
        lock = self._token_locks.setdefault(installation, asyncio.Lock())
        async with lock:
            held = self._tokens.get(installation)
            if held is not None and self._wall() < held.expires_at - TOKEN_MARGIN:
                return held.token
            answer = await self._call(
                "POST",
                f"/app/installations/{installation}/access_tokens",
                bearer=self._jwt(),
                as_app=True,
                body={"permissions": {"metadata": "read"}},
            )
            token = answer.get("token") if isinstance(answer, dict) else None
            expires = answer.get("expires_at") if isinstance(answer, dict) else None
            if not isinstance(token, str) or TOKEN_RE.fullmatch(token) is None:
                raise GithubError(UNAVAILABLE)
            try:
                parsed = datetime.fromisoformat(expires) if isinstance(expires, str) else None
            except ValueError:
                parsed = None
            if parsed is None or parsed.tzinfo is None:
                raise GithubError(UNAVAILABLE)
            expires_at = parsed.timestamp()
            self._tokens[installation] = _Token(token=token, expires_at=expires_at)
            return token

    # Repositories ---------------------------------------------------------------------------
    async def _listing(self, entry: dict[str, Any]) -> Installation:
        installation = int(entry["id"])
        lock = self._listing_locks.setdefault(installation, asyncio.Lock())
        async with lock:
            now = self._monotonic()
            cached = self._listings.get(installation)
            if cached is not None and now - cached.at < LISTING_TTL:
                return cached.value
            try:
                listing = await self._read_listing(entry)
            except GithubError:
                if cached is not None and now - cached.at <= STALE_LIMIT:
                    return cached.value
                raise
            self._listings[installation] = _Cached(listing, now)
            return listing

    async def _read_listing(self, entry: dict[str, Any]) -> Installation:
        fetched_at = self._wall()
        if entry["state"] == "suspended":
            return Installation(
                id=entry["id"],
                account=entry["account"],
                state="suspended",
                repository_selection=entry["repository_selection"],
                repos=(),
                truncated=False,
                fetched_at=fetched_at,
            )
        token = await self._token(int(entry["id"]))
        repos: list[Repo] = []
        seen = 0
        total: Any = None
        full_last_page = False
        for page in range(1, MAX_REPO_PAGES + 1):
            try:
                answer = await self._call(
                    "GET",
                    "/installation/repositories",
                    bearer=token,
                    as_app=False,
                    params={"per_page": PER_PAGE, "page": page},
                )
            except GithubError as exc:
                if exc.code == UNAVAILABLE:
                    # A refused token is never used again.
                    self._tokens.pop(int(entry["id"]), None)
                raise
            listed = answer.get("repositories") if isinstance(answer, dict) else None
            if not isinstance(listed, list):
                raise GithubError(UNAVAILABLE)
            total = answer.get("total_count")
            seen += len(listed)
            for raw in listed:
                repo = _repo(raw)
                if repo is not None:
                    repos.append(repo)
            full_last_page = len(listed) >= PER_PAGE
            if not full_last_page:
                break
        truncated = full_last_page and (type(total) is not int or total > seen)
        repos.sort(key=lambda r: (r.name.lower(), r.name))
        return Installation(
            id=entry["id"],
            account=entry["account"],
            state="ok",
            repository_selection=entry["repository_selection"],
            repos=tuple(repos[:MAX_REPOS]),
            truncated=truncated or len(repos) > MAX_REPOS,
            fetched_at=fetched_at,
        )

    async def list_installations(self) -> list[Installation]:
        """Every installation of the app on an allowed org, with its repositories."""
        return [await self._listing(entry) for entry in await self._installations()]


def _repo(raw: Any) -> Repo | None:
    if not isinstance(raw, dict):
        return None
    name, repo_id = raw.get("name"), raw.get("id")
    if not isinstance(name, str) or not repo_name_ok(name) or not _positive_int(repo_id):
        return None
    private, archived = raw.get("private") is True, raw.get("archived") is True
    return Repo(name=name, id=repo_id, private=private, archived=archived)
