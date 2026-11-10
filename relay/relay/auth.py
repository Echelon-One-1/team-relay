"""Bearer-token verification (M1-SPEC §2).

A verifier turns a bearer token into a principal string or refuses it. It never returns
why in the HTTP response, and it never logs the token or an exception message (Google's
parser errors can quote the token): only an exception class name.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import anyio.to_thread
import google.auth.exceptions
import google.auth.transport.requests
from google.auth import jwt

from .config import Settings, refuse_static_on_cloud_run
from .errors import ApiError

GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"

# Google's ``sub``: an opaque ASCII identifier of the account, at most 255 characters.
SUB_SHAPE = re.compile(r"[\x21-\x7e]{1,255}")
# Google ID tokens are about 1 KiB; anything much longer is not one.
MAX_TOKEN_LENGTH = 4096
JWT_SHAPE = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")

# Google's signing certificates are cached for their Cache-Control max-age, within bounds.
CERTS_DEFAULT_TTL = 3600
CERTS_MIN_TTL = 60
CERTS_MAX_TTL = 86400
# A token naming a key the cache does not hold refetches, but at most this often.
CERTS_MIN_REFRESH = 300
CERTS_FETCH_TIMEOUT = 10
MAX_CERTS_BYTES = 256 * 1024
VERIFIED_CACHE_SIZE = 1024

_MAX_AGE = re.compile(r"(?:^|,)\s*max-age\s*=\s*\"?(\d{1,10})\"?\s*(?:,|$)", re.IGNORECASE)


class Unauthenticated(Exception):
    """The token is not acceptable. ``reason`` is a short code for the stdout log only."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Verified:
    """What a verified token says: the principal, and for a Google ID token the account's
    ``sub`` (M6-SPEC §7.2), which the relay checks against the roster's binding, and its
    ``hd`` claim (the Google Workspace domain; None for a consumer account or a service
    account), which RELAY_ALLOWED_DOMAINS checks (M10-SPEC §7.2)."""

    principal: str
    sub: str | None = None
    hd: str | None = None


class Verifier(Protocol):
    async def principal(self, token: str) -> str:
        """Return the principal for ``token`` or raise :class:`Unauthenticated`."""
        ...

    async def verify(self, token: str) -> Verified:
        """:meth:`principal` with the ``sub`` when the token carries one."""
        ...


class StaticVerifier:
    """Local development only: the principal is the SHA-256 of the whole token."""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        refuse_static_on_cloud_run("static", os.environ if env is None else env)

    async def principal(self, token: str) -> str:
        if not token:
            raise Unauthenticated("empty_token")
        return "token:sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()

    async def verify(self, token: str) -> Verified:
        return Verified(await self.principal(token))


def certs_lifetime(cache_control: str | None) -> int:
    """Seconds to keep Google's certificates: ``max-age`` bounded to
    [CERTS_MIN_TTL, CERTS_MAX_TTL], or CERTS_DEFAULT_TTL when there is none."""
    match = _MAX_AGE.search(cache_control or "")
    if match is None:
        return CERTS_DEFAULT_TTL
    return max(CERTS_MIN_TTL, min(CERTS_MAX_TTL, int(match.group(1))))


def _header_value(headers: Any, name: str) -> str | None:
    for key, value in (headers or {}).items():
        if isinstance(key, str) and key.lower() == name:
            return value if isinstance(value, str) else None
    return None


def _token_kid(token: str) -> str | None:
    """The unverified ``kid`` from a JWT-shaped token's header; used only to pick a key."""
    segment = token.split(".", 1)[0]
    try:
        header = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (binascii.Error, ValueError, RecursionError):
        raise Unauthenticated("malformed_token") from None
    if not isinstance(header, dict):
        raise Unauthenticated("malformed_token")
    kid = header.get("kid")
    if kid is not None and not isinstance(kid, str):
        raise Unauthenticated("malformed_token")
    return kid


@dataclass
class _CachedCerts:
    certs: dict[str, str]
    fetched_at: float
    expires_at: float


def audience_set_digest(audiences: Sequence[str]) -> str:
    """A digest of the accepted audience set, independent of order and duplicates."""
    # JSON, not a joined string: no two different sets can encode the same way.
    encoded = json.dumps(sorted(set(audiences)), ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


def verified_cache_key(audience_digest: str, token: str) -> str:
    """The verified-token cache key: the token and the audience set it was verified for
    (M2-SPEC §2), so a principal cached under one set is never served under another."""
    return hashlib.sha256(f"{audience_digest}\n{token}".encode("ascii")).hexdigest()


class GoogleVerifier:
    """A Google-signed ID token for one of ``audiences`` with a verified email (M1-SPEC §2,
    §11.8, M2-SPEC §2).

    - A token not shaped like a JWT (three base64url segments, at most MAX_TOKEN_LENGTH
      characters) is refused before any network call.
    - Google's certificates are fetched off the event loop and cached for their
      Cache-Control lifetime; concurrent misses share one fetch.
    - A verified token's principal is cached under the SHA-256 of the accepted audience set
      and the token until the token's ``exp`` (a bounded LRU), so a long-poll loop does not
      re-verify every second.
      Issuer, audience, signature, expiry, ``email_verified is True`` and a ``sub`` are all
      checked before anything is cached.
    """

    def __init__(
        self,
        audiences: str | Sequence[str],
        *,
        transport: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.time,
        certs_url: str = GOOGLE_CERTS_URL,
        cache_size: int = VERIFIED_CACHE_SIZE,
    ) -> None:
        accepted = (audiences,) if isinstance(audiences, str) else tuple(audiences)
        if not accepted or not all(isinstance(a, str) and a for a in accepted):
            raise ValueError("at least one audience is required, and none may be empty")
        # A list: google.auth.jwt.decode accepts the token when its (string) aud is any one
        # of them, by exact match; an array-valued aud is never in the list, so it is refused.
        self._audiences = list(dict.fromkeys(accepted))
        self._audience_digest = audience_set_digest(self._audiences)
        self._transport = transport or google.auth.transport.requests.Request()
        self._clock = clock
        self._certs_url = certs_url
        self._cache_size = cache_size
        self._certs: _CachedCerts | None = None
        self._certs_lock = asyncio.Lock()
        self._verified: OrderedDict[str, tuple[Verified, int]] = OrderedDict()

    # Certificates -----------------------------------------------------------------------
    def _fetch_certs(self) -> tuple[dict[str, str], int]:
        """Blocking: runs in a worker thread."""
        unavailable = google.auth.exceptions.TransportError("cannot fetch Google's certificates")
        try:
            response = self._transport(self._certs_url, method="GET", timeout=CERTS_FETCH_TIMEOUT)
        except Exception:  # the transport's own errors, whatever their class
            raise unavailable from None
        if response.status != 200:
            raise unavailable
        data = response.data
        if not isinstance(data, bytes | str) or len(data) > MAX_CERTS_BYTES:
            raise unavailable
        try:
            certs = json.loads(data)
        except ValueError:
            raise unavailable from None
        if (
            not isinstance(certs, dict)
            or not certs
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in certs.items())
        ):
            raise unavailable
        return certs, certs_lifetime(_header_value(response.headers, "cache-control"))

    async def _certs_for(self, kid: str | None) -> dict[str, str]:
        async with self._certs_lock:
            now = self._clock()
            cached = self._certs
            if cached is not None and now < cached.expires_at:
                if kid is None or kid in cached.certs:
                    return cached.certs
                if now - cached.fetched_at < CERTS_MIN_REFRESH:
                    return cached.certs  # the key is unknown and a refetch is too soon
            certs, ttl = await anyio.to_thread.run_sync(self._fetch_certs)
            fetched = self._clock()
            self._certs = _CachedCerts(certs=certs, fetched_at=fetched, expires_at=fetched + ttl)
            return certs

    # Verification -----------------------------------------------------------------------
    def _decode(self, token: str, certs: Mapping[str, str]) -> Any:
        """CPU only (the certificates are in hand); runs in a worker thread."""
        try:
            return jwt.decode(
                token, certs=certs, audience=list(self._audiences), clock_skew_in_seconds=0
            )
        except Exception as exc:  # any failure to verify is a refusal, never a 500
            raise Unauthenticated(type(exc).__name__) from None

    @staticmethod
    def _principal_from(claims: Any) -> tuple[Verified, int]:
        if not isinstance(claims, Mapping):
            raise Unauthenticated("no_claims")
        if claims.get("iss") not in GOOGLE_ISSUERS:
            raise Unauthenticated("wrong_issuer")
        if claims.get("email_verified") is not True:
            raise Unauthenticated("email_not_verified")
        email = claims.get("email")
        if not isinstance(email, str) or "@" not in email:
            raise Unauthenticated("no_email")
        sub = claims.get("sub")
        if not isinstance(sub, str) or SUB_SHAPE.fullmatch(sub) is None:
            raise Unauthenticated("no_sub")
        exp = claims.get("exp")
        if isinstance(exp, bool) or not isinstance(exp, int):
            raise Unauthenticated("bad_exp")
        hd = claims.get("hd")
        if hd is not None and not isinstance(hd, str):
            raise Unauthenticated("bad_hd")
        return Verified("google:" + email.lower(), sub, hd), exp

    async def principal(self, token: str) -> str:
        return (await self.verify(token)).principal

    async def verify(self, token: str) -> Verified:
        if not token:
            raise Unauthenticated("empty_token")
        if len(token) > MAX_TOKEN_LENGTH or JWT_SHAPE.fullmatch(token) is None:
            raise Unauthenticated("malformed_token")  # before any network call
        key = verified_cache_key(self._audience_digest, token)
        hit = self._verified.get(key)
        if hit is not None:
            if self._clock() < hit[1]:
                self._verified.move_to_end(key)
                return hit[0]
            del self._verified[key]

        kid = _token_kid(token)
        try:
            certs = await self._certs_for(kid)
        except google.auth.exceptions.TransportError:
            raise ApiError(503, "auth_unavailable", "Cannot verify credentials now.") from None
        claims = await anyio.to_thread.run_sync(self._decode, token, certs)
        verified, exp = self._principal_from(claims)
        if self._clock() < exp:
            self._verified[key] = (verified, exp)
            self._verified.move_to_end(key)
            while len(self._verified) > self._cache_size:
                self._verified.popitem(last=False)
        return verified


def build_verifier(settings: Settings) -> Verifier:
    if settings.auth_mode == "static":
        return StaticVerifier()
    return GoogleVerifier(settings.audiences)


def bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None
