"""A fake GitHub REST API for the relay's GitHub App client (PICKERS-SPEC §4.3), served through
``httpx.MockTransport``: nothing reaches the network. Its key is made by :func:`app_key` at
test time and never written to disk.

It checks what GitHub would: the app's JWT (RS256 with the app's public key, ``iss`` the app
id, a lifetime of at most 10 minutes) on ``/app/...``, and a live installation token on
``/installation/repositories``. Tests set the installations, each one's repositories and
failures, and read back every request it got."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import cache
from typing import Any
from urllib.parse import parse_qs

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from relay.config import GithubAppConfig

APP_ID = "424242"
SLUG = "example-relay-sources"


@cache
def app_key() -> rsa.RSAPrivateKey:
    """A throwaway 2048-bit key for this test run (made once)."""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def app_key_pem(pkcs8: bool = True) -> str:
    formats = serialization.PrivateFormat
    fmt = formats.PKCS8 if pkcs8 else formats.TraditionalOpenSSL
    return (
        app_key()
        .private_bytes(serialization.Encoding.PEM, fmt, serialization.NoEncryption())
        .decode("ascii")
    )


def app_config() -> GithubAppConfig:
    return GithubAppConfig(app_id=APP_ID, slug=SLUG, private_key=app_key())


def _unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def decode_jwt(token: str, key: rsa.RSAPublicKey) -> tuple[dict[str, Any], dict[str, Any]]:
    """The header and claims of an RS256 JWT whose signature ``key`` verifies; raises
    ``InvalidSignature`` otherwise."""
    header, payload, signature = token.split(".")
    key.verify(
        _unb64(signature), f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )
    return json.loads(_unb64(header)), json.loads(_unb64(payload))


def installation(
    iid: int, login: str, *, selection: str = "all", suspended: bool = False
) -> dict[str, Any]:
    return {
        "id": iid,
        "account": {"login": login, "type": "Organization"},
        "repository_selection": selection,
        "suspended_at": "2026-11-01T00:00:00Z" if suspended else None,
        "permissions": {"metadata": "read"},
    }


def repo(rid: int, name: str, *, private: bool = True, archived: bool = False) -> dict[str, Any]:
    return {
        "id": rid,
        "name": name,
        "full_name": f"example-org/{name}",
        "private": private,
        "archived": archived,
        "owner": {"login": "example-org"},
    }


@dataclass
class Seen:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: Any


@dataclass
class FakeGithub:
    """``installations``: GitHub's installation objects; ``repos``: installation id -> its
    repositories (as GitHub lists them); ``failures``: path -> a function returning the
    response to give instead (None: answer normally)."""

    wall: Callable[[], float]
    installations: list[dict[str, Any]] = field(default_factory=list)
    repos: dict[int, list[Any]] = field(default_factory=dict)
    failures: dict[str, Callable[[httpx.Request], httpx.Response | None]] = field(
        default_factory=dict
    )
    token_lifetime: int = 3600
    delay: float = 0.0
    seen: list[Seen] = field(default_factory=list)
    tokens: dict[str, int] = field(default_factory=dict)  # live token -> installation
    jwt_claims: list[dict[str, Any]] = field(default_factory=list)
    issued: int = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def calls(self, method: str, path_prefix: str) -> list[Seen]:
        return [s for s in self.seen if s.method == method and s.path.startswith(path_prefix)]

    async def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        self.seen.append(
            Seen(
                request.method,
                path,
                parse_qs(request.url.query.decode()),
                dict(request.headers),
                body,
            )
        )
        if self.delay:
            await asyncio.sleep(self.delay)
        failure = self.failures.get(path)
        if failure is not None:
            response = failure(request)
            if response is not None:
                return response
        assert request.url.host == "api.github.com" and request.url.scheme == "https"
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return httpx.Response(401, json={"message": "Requires authentication"})
        bearer = auth.removeprefix("Bearer ")
        if path.startswith("/app/"):
            try:
                _, claims = decode_jwt(bearer, app_key().public_key())
            except (InvalidSignature, ValueError):
                return httpx.Response(401, json={"message": "The JWT could not be decoded"})
            self.jwt_claims.append(claims)
            if claims["iss"] != APP_ID or claims["exp"] - claims["iat"] > 600:
                return httpx.Response(401, json={"message": "bad claims"})
            return self._app_route(request, path, body)
        if path == "/installation/repositories":
            iid = self.tokens.get(bearer)
            if iid is None:
                return httpx.Response(401, json={"message": "Bad credentials"})
            return self._repositories(request, iid)
        return httpx.Response(404, json={"message": "Not Found"})

    def _app_route(self, request: httpx.Request, path: str, body: Any) -> httpx.Response:
        if request.method == "GET" and path == "/app/installations":
            page = int(parse_qs(request.url.query.decode()).get("page", ["1"])[0])
            per_page = int(parse_qs(request.url.query.decode()).get("per_page", ["30"])[0])
            chunk = self.installations[(page - 1) * per_page : page * per_page]
            return httpx.Response(200, json=chunk)
        parts = path.split("/")
        if request.method == "POST" and len(parts) == 5 and parts[4] == "access_tokens":
            iid = int(parts[3])
            if not any(i.get("id") == iid for i in self.installations):
                return httpx.Response(404, json={"message": "Not Found"})
            self.issued += 1
            token = f"ghs_faketoken{self.issued:04d}xyz"
            self.tokens[token] = iid
            expires = datetime.fromtimestamp(self.wall() + self.token_lifetime, UTC)
            return httpx.Response(
                201,
                json={
                    "token": token,
                    "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "permissions": (body or {}).get("permissions"),
                },
            )
        return httpx.Response(404, json={"message": "Not Found"})

    def _repositories(self, request: httpx.Request, iid: int) -> httpx.Response:
        query = parse_qs(request.url.query.decode())
        page = int(query.get("page", ["1"])[0])
        per_page = int(query.get("per_page", ["30"])[0])
        listed = self.repos.get(iid, [])
        chunk = listed[(page - 1) * per_page : page * per_page]
        return httpx.Response(200, json={"total_count": len(listed), "repositories": chunk})
