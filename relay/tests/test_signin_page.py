"""The public sign-in page (docs/SIGNIN-PAGE.md): ``GET /`` and ``GET /login`` on the relay.

- GET and HEAD only (anything else 405 with ``Allow: GET, HEAD``), exact paths: ``/login/``,
  ``/LOGIN``, ``/login.html`` and the rest stay 404.
- Strict headers: a CSP with no scripts, no framing, no referrer, ``Cache-Control: no-cache``
  with an ETag; ``noindex``.
- Fixed at start: nothing from the request (query, headers, path) appears in it.
- Branding from ``RELAY_BRAND_NAME`` only, checked at start (a bad value refuses to start and is
  never quoted) and escaped anyway; unset, generic copy.
- Its stylesheet and four fonts under ``/v1/login/``, by exact name from a fixed list; the page
  references nothing but those, and ``/start``.
- The image carries the files, with the fonts' licences beside them.
- The load balancer sends ``/`` and ``/login`` to the relay and everything else (``/start``,
  ``/team``, ``/join``) to the console behind IAP; ``deploy.sh`` checks the brand as the relay
  does.

Synthetic names only (Example Co)."""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import tomllib
from pathlib import Path

import httpx
import pytest

from relay import welcome
from relay.app import create_app
from relay.config import Settings, load_schema, parse_brand_name, parse_team_config
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import REPO_ROOT, SCHEMA_PATH, team_config_data

pytestmark = pytest.mark.anyio

RELAY_ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://team.example.com"
CSP = (
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
)
FONTS = (
    "inter-latin-wght-normal.woff2",
    "playfair-display-latin-wght-normal.woff2",
    "playfair-display-latin-wght-italic.woff2",
    "google-sans-code-latin-wght-normal.woff2",
)
PAGES = ("/", "/login")


def _settings(brand: str | None = None) -> Settings:
    return Settings(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
        brand_name=brand,
    )


def _client(brand: str | None = None) -> httpx.AsyncClient:
    app = create_app(_settings(brand), MemoryStore())
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN)


def _env(tmp_path: Path, **extra: str) -> dict[str, str]:
    config = tmp_path / "team.yaml"
    config.write_text(json.dumps(team_config_data()))
    return {"RELAY_TEAM_CONFIG": str(config), "RELAY_AUTH_MODE": "static", **extra}


def _assert_page_headers(r: httpx.Response) -> None:
    assert r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.headers["content-security-policy"] == CSP
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["cache-control"] == "no-cache"
    assert re.fullmatch(r'"[0-9a-f]{32}"', r.headers["etag"])
    assert "set-cookie" not in r.headers


# The page ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", PAGES)
async def test_the_page_is_served_with_every_header(path: str):
    async with _client() as client:
        r = await client.get(path)
        assert r.status_code == 200
        _assert_page_headers(r)
        assert '<meta name="robots" content="noindex, nofollow">' in r.text
        assert "<h1>Sign in</h1>" in r.text
        # A bearer token changes nothing (and is not looked at).
        again = await client.get(path, headers={"Authorization": "Bearer nope"})
        assert again.status_code == 200 and again.text == r.text


async def test_both_paths_serve_the_same_page():
    async with _client("Example Co") as client:
        assert (await client.get("/")).text == (await client.get("/login")).text


@pytest.mark.parametrize("path", PAGES)
async def test_head_has_the_headers_and_no_body(path: str):
    async with _client() as client:
        full = await client.get(path)
        r = await client.head(path)
        assert r.status_code == 200
        _assert_page_headers(r)
        assert r.content == b""
        assert r.headers["content-length"] == str(len(full.content))
        assert r.headers["etag"] == full.headers["etag"]


@pytest.mark.parametrize("path", [*PAGES, "/v1/login/welcome.css", "/v1/login/fonts/" + FONTS[0]])
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def test_every_other_method_is_405_with_allow(path: str, method: str):
    async with _client() as client:
        r = await client.request(method, path)
        assert r.status_code == 405
        assert r.headers["allow"] == "GET, HEAD"
        assert r.json()["error"] == "method_not_allowed"


@pytest.mark.parametrize(
    "path",
    [
        "/login/",
        "/LOGIN",
        "/Login",
        "/login.html",
        "/index.html",
        "/login/x",
        "/v1/login/welcome.html",
        "/v1/login/fonts/",
        "/v1/login/fonts/unknown.woff2",
        "/v1/login/fonts/INTER-latin-wght-normal.woff2",
        "/v1/login/fonts/inter-latin-wght-normal.woff2.map",
        "/v1/login/fonts/inter-OFL.txt",
        "/v1/login/fonts/%2e%2e/welcome.css",
        "/v1/login/fonts/..%2fwelcome.css",
        "/v1/login/fonts/sub/inter-latin-wght-normal.woff2",
        "/v1/login/static/welcome/welcome.css",
    ],
)
async def test_anything_but_the_exact_paths_is_404(path: str):
    async with _client() as client:
        for method in ("GET", "HEAD"):
            r = await client.request(method, path)
            assert r.status_code == 404, (method, path)
            assert "Sign in with Google" not in r.text


async def test_a_dot_dot_path_is_never_resolved_against_the_disk():
    # Sent as is (httpx would tidy the dots away).
    app = create_app(_settings(), MemoryStore())
    for raw in (
        b"/v1/login/fonts/../x",
        b"/v1/login/fonts/../../welcome.html",
        b"/v1/login/../../",
    ):
        status = await _raw_get(app, raw)
        assert status == 404, raw


async def _raw_get(app, raw_path: bytes) -> int:
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": raw_path.decode(),
        "raw_path": raw_path,
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"team.example.com")],
        "client": ("127.0.0.1", 1234),
        "server": ("team.example.com", 443),
    }
    await app(scope, receive, send)
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


async def test_nothing_from_the_request_is_reflected():
    async with _client("Example Co") as client:
        plain = (await client.get("/")).text
        r = await client.get(
            "/",
            params={"x": "<script>alert(1)</script>", "next": "https://evil.example.org/"},
            headers={
                "X-Forwarded-Host": "evil.example.org",
                "Referer": "https://evil.example.org/<b>",
                "User-Agent": "<img src=x onerror=alert(1)>",
                "Cookie": "s=<i>cookie</i>",
            },
        )
        assert r.status_code == 200
        assert r.text == plain
        for marker in ("<script", "alert(1)", "evil.example.org", "onerror", "<i>cookie"):
            assert marker not in r.text
        assert (await client.get("/login", params={"q": "<b>x</b>"})).text == plain


async def test_an_etag_match_is_304():
    async with _client() as client:
        first = await client.get("/")
        r = await client.get("/", headers={"If-None-Match": first.headers["etag"]})
        assert r.status_code == 304 and r.content == b""
        assert r.headers["etag"] == first.headers["etag"]
        other = await client.get("/", headers={"If-None-Match": '"0000"'})
        assert other.status_code == 200 and other.text == first.text


async def test_the_page_holds_no_script_and_references_only_its_own_assets():
    async with _client("Example Co") as client:
        page = (await client.get("/")).text
        css_hrefs = re.findall(r'<link rel="stylesheet" href="([^"]+)">', page)
        assert len(css_hrefs) == 1 and re.fullmatch(
            r"/v1/login/welcome\.css\?v=[0-9a-f]{12}", css_hrefs[0]
        )
        hrefs = re.findall(r'href="([^"]*)"', page)
        icons = [h for h in hrefs if h.startswith("data:")]
        assert len(icons) == 1 and icons[0].startswith("data:image/svg+xml,")
        assert sorted(h for h in hrefs if not h.startswith("data:")) == sorted(
            [css_hrefs[0], "/start"]
        )
        assert '<a class="gsi" href="/start">' in page
        lowered = page.lower()
        body = lowered.replace(icons[0].lower(), "")
        for forbidden in ("<script", "<form", "<iframe", "<img", " src=", "style=", "javascript:"):
            assert forbidden not in body, forbidden
        assert not re.search(r"\son[a-z]+\s*=", body)
        assert "http://" not in page.replace(icons[0], "") and "https://" not in page

        css = (await client.get(css_hrefs[0])).text
        urls = re.findall(r"url\(([^)]*)\)", css)
        assert sorted(set(urls)) == sorted(f"/v1/login/fonts/{f}" for f in FONTS)
        assert "@import" not in css and "http" not in css


async def test_the_copy_and_the_layout():
    async with _client("Example Co") as client:
        page = (await client.get("/")).text
    assert '<aside class="brand" aria-label="Example Co">' in page
    assert '<p class="mark">Example Co</p>' in page
    assert '<p class="eyebrow">team relay · by Example Co</p>' in page
    assert "<h2>Ask your teammates’ Claude, <em>inside the team’s limits</em>.</h2>" in page
    steps = re.findall(r'<li><span class="n">(\d\d)</span><span>([^<]+)</span></li>', page)
    assert steps == [
        ("01", "Sign in with your Google account."),
        ("02", "Run the setup line once on your Mac."),
        ("03", "Ask from the browser or from Claude. Answers come back on their own."),
    ]
    assert '<p class="brand-foot">team relay</p>' in page
    assert '<p class="wordmark">Example Co <span>Team Relay</span></p>' in page
    assert (
        '<p class="lede">Use your <b>Example Co</b> Google account. New members are taken to '
        "their setup steps.</p>"
    ) in page
    assert "<span>Sign in with Google</span>" in page
    assert '<p class="who">For <b>Example Co</b> team members.</p>' in page
    assert "Google checks who you are. This page holds no data." in page
    # The official multicolour G, inline.
    for colour in ("#EA4335", "#4285F4", "#FBBC05", "#34A853"):
        assert f'fill="{colour}"' in page


async def test_no_brand_gives_the_generic_copy():
    async with _client(None) as client:
        page = (await client.get("/")).text
    assert '<aside class="brand" aria-label="Team Relay">' in page
    assert '<p class="mark">Team Relay</p>' in page
    assert '<p class="eyebrow">team relay</p>' in page
    assert '<p class="wordmark">Team Relay</p>' in page
    assert (
        '<p class="lede">Use your work Google account. New members are taken to their setup '
        "steps.</p>"
    ) in page
    assert '<p class="who">For team members.</p>' in page
    assert " by " not in page and "<b>" not in page


@pytest.mark.parametrize(
    ("brand", "escaped"),
    [
        ("Smith & Sons", "Smith &amp; Sons"),
        ("O'Brien Co.", "O&#x27;Brien Co."),
        ("A-1, Ltd.", "A-1, Ltd."),
    ],
)
async def test_the_brand_is_escaped(brand: str, escaped: str):
    async with _client(brand) as client:
        page = (await client.get("/")).text
    assert f'<p class="mark">{escaped}</p>' in page
    assert f'aria-label="{escaped}"' in page
    assert f"<b>{escaped}</b>" in page
    if escaped != brand:
        assert brand not in page


# The brand ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw", ["Example Co", "A", "Smith & Sons", "O'Brien Co.", "A-1, Ltd.", "x" * 40, "3M"]
)
def test_a_brand_is_letters_digits_spaces_and_a_few_marks(raw: str):
    assert parse_brand_name(raw) == raw


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "x" * 41,
        "<script>",
        'Example "Co"',
        "Example\nCo",
        "Example\tCo",
        "Example;Co",
        "Example_Co",
        "Example/Co",
        "Exämple",
        "Example‮Co",
        " Example",
        "Example ",
        "{{brand}}",
        "__BRAND__",
    ],
)
def test_any_other_brand_refuses_to_start_without_quoting_it(raw: str, tmp_path: Path):
    with pytest.raises(ConfigError, match="RELAY_BRAND_NAME") as err:
        parse_brand_name(raw)
    if raw.strip():
        assert raw not in str(err.value)
    if raw:
        with pytest.raises(ConfigError, match="RELAY_BRAND_NAME") as err:
            Settings.from_env(_env(tmp_path, RELAY_BRAND_NAME=raw))
        if raw.strip():
            assert raw not in str(err.value)
    # Settings built directly are checked too.
    with pytest.raises(ConfigError, match="RELAY_BRAND_NAME"):
        _settings(raw)


def test_the_brand_comes_from_the_env(tmp_path: Path):
    assert Settings.from_env(_env(tmp_path, RELAY_BRAND_NAME="Example Co")).brand_name == (
        "Example Co"
    )
    assert Settings.from_env(_env(tmp_path)).brand_name is None
    assert Settings.from_env(_env(tmp_path, RELAY_BRAND_NAME="")).brand_name is None


# The stylesheet and the fonts --------------------------------------------------------------------


async def test_the_stylesheet_is_served_as_css():
    async with _client() as client:
        r = await client.get("/v1/login/welcome.css")
        assert r.status_code == 200
        assert r.headers["content-type"] == "text/css; charset=utf-8"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["cache-control"] == "public, max-age=3600"
        assert r.headers["etag"]
        assert "@font-face" in r.text and "prefers-color-scheme: dark" in r.text
        assert r.content == (welcome.STATIC_DIR / "welcome.css").read_bytes()
        # The page's versioned link is the same file.
        page = (await client.get("/")).text
        href = re.search(r'href="(/v1/login/welcome\.css\?v=[0-9a-f]+)"', page).group(1)
        assert (await client.get(href)).content == r.content
        head = await client.head("/v1/login/welcome.css")
        assert head.status_code == 200 and head.content == b""


@pytest.mark.parametrize("font", FONTS)
async def test_each_font_is_served_as_woff2_for_a_year(font: str):
    async with _client() as client:
        r = await client.get(f"/v1/login/fonts/{font}")
        assert r.status_code == 200
        assert r.headers["content-type"] == "font/woff2"
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.content == (welcome.FONT_DIR / font).read_bytes()
        assert r.content[:4] == b"wOF2"
        head = await client.head(f"/v1/login/fonts/{font}")
        assert head.status_code == 200 and head.content == b""
        assert head.headers["content-length"] == str(len(r.content))


async def test_the_page_is_served_whether_or_not_the_login_is_set_up():
    # _settings() has no public URL (the plugin's sign-in pages are 404); this page is static.
    async with _client() as client:
        assert (await client.get("/v1/login/style.css")).status_code == 404
        assert (await client.get("/")).status_code == 200
        assert (await client.get("/v1/login/welcome.css")).status_code == 200


def test_missing_files_refuse_to_start(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(welcome, "STATIC_DIR", tmp_path / "nowhere")
    monkeypatch.setattr(welcome, "FONT_DIR", tmp_path / "nowhere" / "fonts")
    with pytest.raises(ConfigError, match="sign-in page"):
        welcome.load_welcome(None)


def test_the_page_is_rendered_once_from_checked_values_only():
    with pytest.raises(ConfigError, match="RELAY_BRAND_NAME"):
        welcome.load_welcome("<b>")
    page = welcome.load_welcome("Example Co").page.body.decode()
    assert not re.search(r"__[A-Z_]+__", page)


# The image ---------------------------------------------------------------------------------------


def test_the_image_carries_the_page_and_the_fonts_with_their_licences():
    patterns = tomllib.loads((RELAY_ROOT / "pyproject.toml").read_text())["tool"]["setuptools"][
        "package-data"
    ]["relay"]
    package = RELAY_ROOT / "relay"
    shipped = [p for p in (package / "static" / "welcome").rglob("*") if p.is_file()]
    assert shipped
    for path in shipped:
        rel = path.relative_to(package).as_posix()
        assert any(fnmatch.fnmatch(rel, pattern) for pattern in patterns), rel
    for font in FONTS:
        assert (welcome.FONT_DIR / font).is_file()
    for family in ("inter", "playfair-display", "google-sans-code"):
        text = (welcome.FONT_DIR / f"{family}-OFL.txt").read_text()
        assert "SIL Open Font License" in text
    assert welcome.STATIC_DIR == RELAY_ROOT / "relay" / "static" / "welcome"
    dockerfile = (RELAY_ROOT / "Dockerfile").read_text()
    assert "COPY relay/relay ./relay" in dockerfile
    assert "!relay/relay/" in (RELAY_ROOT / "Dockerfile.dockerignore").read_text().splitlines()


def test_the_public_files_name_no_one():
    # A public repository: the page and its stylesheet carry no company, domain or logo.
    for name in ("welcome.html", "welcome.css"):
        text = (welcome.STATIC_DIR / name).read_text().lower()
        assert "echelon" not in text and "polaris" not in text and ".com" not in text


# The load balancer and the deploy script --------------------------------------------------------


def _url_map() -> dict:
    script = (REPO_ROOT / "scripts" / "deploy-lb.sh").read_text()
    body = re.search(r'cat > "\$MAP_DIR/\$\{URL_MAP\}\.json" <<JSON\n(.*?)\nJSON\n', script, re.S)
    assert body, "the URL map heredoc"
    text = re.sub(r"\$\{([A-Z_]+)\}", lambda m: m.group(1), body.group(1))
    return json.loads(text)


RELAY = "BACKEND_URL_PREFIX/RELAY_BACKEND"
CONSOLE = "BACKEND_URL_PREFIX/CONSOLE_BACKEND"


def test_the_load_balancer_routes_the_sign_in_page_to_the_relay():
    m = _url_map()
    (matcher,) = m["pathMatchers"]
    assert "pathRules" not in matcher
    assert matcher["defaultService"] == CONSOLE
    rules = sorted(matcher["routeRules"], key=lambda r: r["priority"])
    assert [(r["priority"], r["matchRules"], r["service"]) for r in rules] == [
        (1, [{"fullPathMatch": "/"}], RELAY),
        (2, [{"fullPathMatch": "/login"}], RELAY),
        (3, [{"prefixMatch": "/v1/"}], RELAY),
        (4, [{"fullPathMatch": "/healthz"}], RELAY),
        (5, [{"fullPathMatch": "/setup"}], RELAY),
    ]
    tests = {t["path"]: t["service"] for t in m["tests"]}
    assert all(t["host"] == "PUBLIC_HOST" for t in m["tests"])
    assert tests == {
        "/": RELAY,
        "/login": RELAY,
        "/v1/health": RELAY,
        "/setup": RELAY,
        "/start": CONSOLE,
        "/join": CONSOLE,
        "/team": CONSOLE,
        "/login/": CONSOLE,
    }
    # Everything else about the map is as before.
    assert m["hostRules"] == [{"hosts": ["PUBLIC_HOST"], "pathMatcher": "team-relay"}]
    assert m["defaultUrlRedirect"]["hostRedirect"] == "PUBLIC_HOST"


def test_the_map_digest_compares_the_tests_too():
    script = (REPO_ROOT / "scripts" / "deploy-lb.sh").read_text()
    assert '"pathMatchers", "tests")' in script


@pytest.mark.parametrize(
    "raw",
    [
        "Example Co",
        "Smith & Sons",
        "O'Brien Co.",
        "A-1, Ltd.",
        "x" * 40,
        "x" * 41,
        "<b>",
        "",
        " Example",
        "Example ",
        "Exämple",
        "Example;Co",
        "Example_Co",
        'a"b',
        "a\\b",
        "$(id)",
    ],
)
def test_deploy_checks_the_brand_as_the_relay_does(raw: str):
    script = (REPO_ROOT / "scripts" / "deploy.sh").read_text()
    line = re.search(r'^BRAND_RE="([^"]+)"$', script, re.M)
    assert line, "BRAND_RE in deploy.sh"
    result = subprocess.run(
        ["bash", "-c", '(LC_ALL=C; [[ "$2" =~ $1 ]])', "check", line.group(1), raw],
        capture_output=True,
        check=False,
    )
    try:
        parse_brand_name(raw)
        relay_accepts = True
    except ConfigError:
        relay_accepts = False
    assert (result.returncode == 0) == relay_accepts, raw
