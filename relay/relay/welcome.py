"""The public sign-in page (docs/SIGNIN-PAGE.md): ``GET /`` and ``GET /login``.

The hosted address's front door. A static page with one link, "Sign in with Google", to
``/start`` (the console, behind IAP); the load balancer sends ``/`` and ``/login`` here and
everything else but the relay's own paths to the console.

Everything is fixed at start: the template (``static/welcome/welcome.html``) is rendered once
with the brand from ``RELAY_BRAND_NAME`` (checked by :func:`relay.config.parse_brand_name` and
escaped all the same), and the stylesheet and the four fonts are read once. Nothing from a
request (query, headers, path) reaches a response body. GET and HEAD only; every other method is
405 with ``Allow: GET, HEAD``. The fonts are served by exact name from :data:`FONT_FILES`, never
by a path taken from the request.

The page runs no script (its CSP has no ``script-src``), holds no form and no data, and
references only its stylesheet (same origin, versioned by content hash), the fonts the
stylesheet names and ``/start``.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from html import escape
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.routing import request_response
from starlette.types import Receive, Scope, Send

from .config import parse_brand_name
from .errors import ConfigError, not_found

# Shipped as package data (pyproject.toml).
STATIC_DIR = Path(__file__).resolve().parent / "static" / "welcome"
FONT_DIR = STATIC_DIR / "fonts"
TEMPLATE_NAME = "welcome.html"
STYLESHEET_NAME = "welcome.css"

PAGE_PATHS = ("/", "/login")
STYLESHEET_PATH = "/v1/login/welcome.css"
FONT_PATH_PREFIX = "/v1/login/fonts/"
FONT_FILES = (
    "inter-latin-wght-normal.woff2",
    "playfair-display-latin-wght-normal.woff2",
    "playfair-display-latin-wght-italic.woff2",
    "google-sans-code-latin-wght-normal.woff2",
)
SIGN_IN_TARGET = "/start"
PRODUCT = "Team Relay"
ALLOW = "GET, HEAD"

CSP = (
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
)
PAGE_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
    "Cross-Origin-Opener-Policy": "same-origin",
}
ASSET_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
}
STYLESHEET_CACHE = "public, max-age=3600"
FONT_CACHE = "public, max-age=31536000, immutable"

_PLACEHOLDER_RE = re.compile(r"__[A-Z_]+__")
# A page, a stylesheet or a font is small; anything near this is not one.
MAX_FILE_BYTES = 512 * 1024


@dataclass(frozen=True)
class Asset:
    """One fixed response body with its type and headers (an ETag of its content included)."""

    body: bytes
    media_type: str
    headers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def of(cls, body: bytes, media_type: str, headers: Mapping[str, str]) -> Asset:
        etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
        return cls(body, media_type, {**headers, "ETag": etag})

    def respond(self, request: Request) -> Response:
        if request.method not in ("GET", "HEAD"):
            return method_not_allowed()
        headers = dict(self.headers)
        if _etag_matches(request.headers.get("if-none-match"), headers["ETag"]):
            return Response(status_code=304, headers=headers)
        if request.method == "HEAD":
            headers["Content-Length"] = str(len(self.body))
            return Response(b"", media_type=self.media_type, headers=headers)
        return Response(self.body, media_type=self.media_type, headers=headers)


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    for candidate in header.split(","):
        tag = candidate.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == etag or tag == "*":
            return True
    return False


def method_not_allowed() -> Response:
    return JSONResponse(
        {"error": "method_not_allowed", "detail": "method not allowed"},
        status_code=405,
        headers={"Allow": ALLOW},
    )


@dataclass(frozen=True)
class Welcome:
    page: Asset
    stylesheet: Asset
    fonts: Mapping[str, Asset]


def _read(path: Path) -> bytes:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ConfigError(
            f"cannot read the sign-in page's {path.name}: {exc.strerror or 'unreadable'}"
        ) from None
    if len(data) > MAX_FILE_BYTES:
        raise ConfigError(f"the sign-in page's {path.name} is larger than 512 KiB")
    return data


def _text(path: Path) -> str:
    try:
        return _read(path).decode("utf-8")
    except UnicodeDecodeError:
        raise ConfigError(f"the sign-in page's {path.name} is not UTF-8") from None


def render_page(template: str, brand: str | None, stylesheet_href: str) -> str:
    """The page: ``template`` with every placeholder replaced by escaped text (the brand
    checked first). Unset brand: the generic copy."""
    if brand is not None:
        parse_brand_name(brand)
        name = escape(brand, quote=True)
        values = {
            "__BRAND__": name,
            "__EYEBROW__": f"team relay · by {name}",
            "__WORDMARK__": f"{name} <span>{PRODUCT}</span>",
            "__LEDE__": (
                f"Use your <b>{name}</b> Google account. "
                "New members are taken to their setup steps."
            ),
            "__WHO__": f"For <b>{name}</b> team members.",
        }
    else:
        values = {
            "__BRAND__": PRODUCT,
            "__EYEBROW__": "team relay",
            "__WORDMARK__": PRODUCT,
            "__LEDE__": "Use your work Google account. New members are taken to their setup steps.",
            "__WHO__": "For team members.",
        }
    values["__STYLESHEET__"] = escape(stylesheet_href, quote=True)
    # One pass, so no value is ever read as a placeholder.
    page = _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(0), m.group(0)), template)
    left = _PLACEHOLDER_RE.search(page)
    if left:
        raise ConfigError(f"the sign-in page's template has an unknown placeholder {left.group(0)}")
    return page


def load_welcome(brand: str | None) -> Welcome:
    """Reads the template, the stylesheet and the fonts, and renders the page. A missing or
    malformed file refuses to start."""
    css = _read(STATIC_DIR / STYLESHEET_NAME)
    version = hashlib.sha256(css).hexdigest()[:12]
    page = render_page(_text(STATIC_DIR / TEMPLATE_NAME), brand, f"{STYLESHEET_PATH}?v={version}")
    fonts = {
        name: Asset.of(
            _read(FONT_DIR / name), "font/woff2", {**ASSET_HEADERS, "Cache-Control": FONT_CACHE}
        )
        for name in FONT_FILES
    }
    return Welcome(
        page=Asset.of(page.encode("utf-8"), "text/html; charset=utf-8", PAGE_HEADERS),
        stylesheet=Asset.of(
            css, "text/css; charset=utf-8", {**ASSET_HEADERS, "Cache-Control": STYLESHEET_CACHE}
        ),
        fonts=fonts,
    )


class _AnyMethod:
    """An ASGI endpoint the router hands every method to (a plain function would be GET-only
    there, and the router's own 405 carries no ``Allow`` through the app's error handler)."""

    def __init__(self, handler: Callable[[Request], Awaitable[Response]]) -> None:
        self._app = request_response(handler)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self._app(scope, receive, send)


def _serving(asset: Asset) -> _AnyMethod:
    async def serve(request: Request) -> Response:
        return asset.respond(request)

    return _AnyMethod(serve)


async def _not_found(_: Request) -> Response:
    return JSONResponse(not_found().body(), status_code=404)


def mount(app: FastAPI, welcome: Welcome) -> None:
    """The routes, every one an exact path that takes any method (so a method other than GET
    and HEAD is answered here: 405 with ``Allow: GET, HEAD``)."""
    for path in PAGE_PATHS:
        app.add_route(path, _serving(welcome.page), include_in_schema=False)
    # Exact paths only: without this, the router would redirect /login/ to /login.
    app.add_route("/login/", _AnyMethod(_not_found), include_in_schema=False)
    app.add_route(STYLESHEET_PATH, _serving(welcome.stylesheet), include_in_schema=False)
    for name, font in welcome.fonts.items():
        app.add_route(FONT_PATH_PREFIX + name, _serving(font), include_in_schema=False)
