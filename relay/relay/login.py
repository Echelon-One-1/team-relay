"""Sign in from Claude Code (M5-SPEC §2): loopback + PKCE, RFC 8252 style.

    plugin ──GET /v1/login/start──▶ relay ──302──▶ Google ──302──▶ /v1/login/callback
           chooser page ──POST /v1/login/choose──▶ 303 http://127.0.0.1:<port>/callback?code&state
    plugin ──POST /v1/login/token {code, code_verifier}──▶ {"credential": "trc_…", …}

- The login document (``logins/{sha256(login id)}``) moves ``google`` → ``exchanging`` →
  ``choose`` → ``done``, or to ``closed``; every move is one store transaction that checks
  the step it expects and the expiry, so a replayed callback or a second POST finds the
  wrong step and stops.
- The browser that started the login holds the login id in the ``trl`` cookie
  (``HttpOnly; Secure; SameSite=Lax; Path=/v1/login; Max-Age=600``); the callback's
  ``state`` must equal it and the chooser's POST must carry it and the login's CSRF token.
- The one-time code travels only to ``http://127.0.0.1:<port>/callback`` (the port the
  plugin's listener chose); nothing else is ever a redirect target. It is stored hashed,
  lives 2 minutes, and is useless without the plugin's PKCE verifier. A code presented twice
  revokes the credential it minted.
- Every endpoint is rate limited per client IP, counted in the store (:func:`client_ip`).
  Each start logs how many ``X-Forwarded-For`` hops it saw (never the addresses), so the
  derivation can be checked on the live service (M6-SPEC §7.7).
- Accounts are bound by Google ``sub`` (M6-SPEC §7.2): the callback refuses an account whose
  email is bound, on any of its teams, to another ``sub``; the chosen team's binding is
  recorded (first sign-in) or checked again, in a roster transaction, before a code is
  minted. The credential records the SHA-256 of the email it was minted through (§7.1), and
  the token response names the email (M5-SPEC §9.3).
- Creating a team (M9-SPEC §3): an account on no team gets "You're not on a team yet" with
  the create form, at step ``choose`` with no choices. The chooser keeps its one form and
  fields (``csrf``, ``team``, ``action``); its "Create a new team" button is
  ``action=new``, which answers the create page. ``POST /v1/login/create`` (``csrf``,
  ``name``, ``team``, ``member``, ``action`` = ``create`` | ``back`` | ``cancel``) takes the
  same cookie, Origin and CSRF checks as the chooser's POST, and the login's step must still
  be ``choose``: it creates the team with the signed-in account as its owner (bound to its
  ``sub``), adds the team to the login's choices and shows the chooser with it preselected.
  A refused creation shows the form again with the reason and the member's own input
  (escaped). Back shows the chooser; Cancel ends the login as the chooser's Cancel does.
  Every create attempt counts against the account's hourly quota (M9-SPEC §7.4).
- Invitations (M9-SPEC §7.2): an invited entry is not a team to choose. The chooser lists the
  account's invitations; an account with invitations and no team sees the chooser (no radios,
  no Continue) instead of the create page. ``POST /v1/login/invitation`` (``csrf``,
  optionally ``team`` (the checked radio, ignored), and exactly one of ``accept`` or
  ``decline`` naming the team) takes the chooser's cookie, Origin, CSRF and step rules.
  Accepting makes the entry active, binds this Google account's ``sub`` and adds the team to
  the login's choices (preselected); declining removes the entry. Either way the chooser is
  shown again; an invitation no longer open shows it with a notice (``409``).
- RELAY_ALLOWED_DOMAINS (M10-SPEC §7.2): the callback refuses (``403``) a Google account
  whose email is not in one of the domains or whose ``hd`` claim is not that same domain,
  after ``email_verified``. Team creation and invitations check the email again (:mod:`relay.teams`)
  and a credential is refused while its email is outside them (:mod:`relay.app`).
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qsl, urlencode

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from .clock import format_time
from .config import Limits, Settings, TeamConfig, normalise_email, normalise_team_name
from .credentials import (
    CREDENTIAL_LIFETIME,
    Credentials,
    b64url,
    credential_key,
    new_credential,
    public_id,
)
from .errors import ApiError
from .jsonutil import sha256_hex
from .log import log_event
from .oauth import OAuthError, OAuthProvider, pkce_challenge
from .pages import (
    SECURITY_HEADERS,
    CreateForm,
    InvitationView,
    chooser_page,
    create_page,
    html_response,
    message_page,
)
from .roster import Roster, email_hash
from .store import (
    AuditEntry,
    CredentialRecord,
    LoginChange,
    LoginChoice,
    LoginCode,
    LoginDoc,
    Quota,
    Redemption,
    Store,
    TeamGone,
)
from .teams import NewTeam, Teams, parse_new_team, suggest_member_id, suggest_team_id

COOKIE = "trl"
COOKIE_PATH = "/v1/login"
LOGIN_LIFETIME = timedelta(minutes=10)
CODE_LIFETIME = timedelta(minutes=2)
LOGIN_WINDOW_SECONDS = 60
MAX_FORM_BYTES = 4096

PORT_RE = re.compile(r"^[1-9][0-9]{3,4}$")
# The plugin's state: 32 random bytes, base64url (43) or hex (64); a little room either way.
STATE_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")  # RFC 7636 §4.1
DEVICE_RE = re.compile(r"^[A-Za-z0-9 ._()-]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # login ids, CSRF tokens, one-time codes
GOOGLE_CODE_RE = re.compile(r"^[\x21-\x7e]{1,1024}$")
SUB_RE = re.compile(r"^[\x21-\x7e]{1,255}$")  # Google's: an opaque ASCII string, <= 255

STEP_GOOGLE = "google"
STEP_EXCHANGING = "exchanging"
STEP_CHOOSE = "choose"
STEP_DONE = "done"
STEP_CLOSED = "closed"

AGAIN = "Run /team-relay:login in Claude Code to start again."
CREATE_ACTION = "/v1/login/create"
CHOOSE_FIELDS = frozenset({"csrf", "team", "action"})
CREATE_FIELDS = frozenset({"csrf", "name", "team", "member", "action"})
INVITATION_FIELDS = frozenset({"csrf", "team", "accept", "decline"})
REBOUND_TITLE = "This email now belongs to a different Google account"
REBOUND_LINE = "Ask the owner."


def forwarded_hops(request: Request) -> int:
    """How many ``X-Forwarded-For`` entries the request carried, over every such header."""
    return sum(
        1
        for value in request.headers.getlist("x-forwarded-for")
        for part in value.split(",")
        if part.strip()
    )


def client_ip(request: Request, on_cloud_run: bool, hops: int) -> str:
    """The address a login rate limit is counted against.

    Behind Cloud Run the socket peer is Google's front end, which appends the address it
    received the connection from to ``X-Forwarded-For``. Anything to the left of what Google
    appended came from the client and can be forged, so the entry ``hops`` from the right is
    taken: with ``hops=1`` (Cloud Run reached directly) the right-most, the only one Google
    wrote; with ``hops=2`` (behind the external Application Load Balancer, M10-SPEC §5) the
    one left of the forwarding rule's own address, which the balancer wrote. Fewer entries
    than that: ``unknown``. Off Cloud Run (local development, the tests) the header is
    ignored and the socket peer is used. IPv6 addresses count per /64, since one host
    commonly holds a whole /64. Unparseable values share one bucket, ``unknown``."""
    raw: str | None
    if on_cloud_run:
        entries = [
            part.strip()
            for value in request.headers.getlist("x-forwarded-for")
            for part in value.split(",")
        ]
        raw = entries[-hops] if len(entries) >= hops else None
    else:
        raw = request.client.host if request.client else None
    try:
        address = ipaddress.ip_address(raw or "")
    except ValueError:
        return "unknown"
    if address.version == 6:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def _key(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _single(params: Any, name: str) -> str | None:
    """The one value of ``name``; None when it is absent or given more than once."""
    values = params.getlist(name)
    return values[0] if len(values) == 1 else None


@dataclass(frozen=True)
class _Form:
    fields: dict[str, str]


class LoginService:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        roster: Roster,
        teams: Teams,
        credentials: Credentials,
        oauth: OAuthProvider,
        now: Callable[[], datetime],
        on_cloud_run: bool,
    ) -> None:
        assert settings.public_url is not None
        self._config: TeamConfig = settings.team_config
        self._limits: Limits = settings.team_config.limits
        self._store = store
        self._roster = roster
        self._teams = teams
        self._credentials = credentials
        self._oauth = oauth
        self._now = now
        self._on_cloud_run = on_cloud_run
        self._hops = settings.forwarded_for_hops
        self.public_url = settings.public_url
        self.redirect_uri = f"{settings.public_url}/v1/login/callback"
        self._retention = timedelta(days=settings.team_config.audit_retention_days)

    # Helpers --------------------------------------------------------------------------------
    async def _allow(self, request: Request, kind: str, limit: int, **log: Any) -> bool:
        now = self._now()
        start = int(now.timestamp()) // LOGIN_WINDOW_SECONDS * LOGIN_WINDOW_SECONDS
        # The address itself is never stored: only a hash of it, in the counter's key.
        ip_hash = sha256_hex(client_ip(request, self._on_cloud_run, self._hops))[:32]
        quota = Quota(
            key=f"{kind}.{ip_hash}.{start}",
            limit=limit,
            expire_at=datetime.fromtimestamp(start + 2 * LOGIN_WINDOW_SECONDS, UTC),
        )
        if await self._store.count_login_quota(quota):
            return True
        log_event("login_rate_limited", severity="WARNING", endpoint=kind, **log)
        return False

    @staticmethod
    def _refused(reason: str, **fields: Any) -> None:
        log_event("login_refused", severity="WARNING", reason=reason, **fields)

    def _page(self, status: int, title: str, *lines: str, clear: bool = False) -> Response:
        response = html_response(message_page(title, lines, error=status >= 400), status)
        if clear:
            self._clear_cookie(response)
        return response

    def _clear_cookie(self, response: Response) -> None:
        response.delete_cookie(COOKIE, path=COOKIE_PATH, secure=True, httponly=True, samesite="lax")

    def _busy(self) -> Response:
        return self._page(429, "Too many attempts", "Wait a minute, then try again.")

    async def _close(self, key: str) -> None:
        def fn(doc: LoginDoc | None) -> LoginChange[None]:
            if doc is None or doc.step in (STEP_DONE, STEP_CLOSED):
                return LoginChange(result=None)
            doc.step = STEP_CLOSED
            return LoginChange(result=None, login=doc)

        await self._store.mutate_login(key, fn)

    def _cookie_login(self, request: Request) -> str | None:
        value = request.cookies.get(COOKIE)
        return value if value is not None and TOKEN_RE.fullmatch(value) else None

    # GET /v1/login/start ----------------------------------------------------------------------
    async def start(self, request: Request) -> Response:
        # Logged once per start, with whichever event ends it (M6-SPEC §7.7).
        hops = {"x_forwarded_for_hops": forwarded_hops(request)}
        if not await self._allow(request, "start", self._limits.login_starts_per_minute, **hops):
            return self._busy()
        q = request.query_params
        port, state = _single(q, "port"), _single(q, "state")
        challenge, method = _single(q, "code_challenge"), _single(q, "code_challenge_method")
        device = _single(q, "device")
        valid = (
            port is not None
            and PORT_RE.fullmatch(port) is not None
            and 1024 <= int(port) <= 65535
            and state is not None
            and STATE_RE.fullmatch(state) is not None
            and challenge is not None
            and CHALLENGE_RE.fullmatch(challenge) is not None
            and method == "S256"
            and device is not None
            and DEVICE_RE.fullmatch(device) is not None
        )
        if not valid:
            self._refused("bad_start", **hops)
            return self._page(400, "This sign-in link is not valid", AGAIN)
        assert port and state and challenge and device
        now = self._now()
        login_id = b64url(secrets.token_bytes(32))
        google_verifier = b64url(secrets.token_bytes(32))
        login = LoginDoc(
            key=_key(login_id),
            port=int(port),
            state=state,
            challenge=challenge,
            device=device,
            step=STEP_GOOGLE,
            nonce=b64url(secrets.token_bytes(32)),
            google_verifier=google_verifier,
            created_at=now,
            expire_at=now + LOGIN_LIFETIME,
        )
        await self._store.create_login(login)
        url = self._oauth.authorization_url(
            redirect_uri=self.redirect_uri,
            state=login_id,
            nonce=login.nonce,
            code_challenge=pkce_challenge(google_verifier),
        )
        response = RedirectResponse(url, status_code=302, headers=dict(SECURITY_HEADERS))
        response.set_cookie(
            COOKIE,
            login_id,
            max_age=int(LOGIN_LIFETIME.total_seconds()),
            path=COOKIE_PATH,
            secure=True,
            httponly=True,
            samesite="lax",
        )
        log_event("login_started", login=login.key[:12], **hops)
        return response

    # GET /v1/login/callback -------------------------------------------------------------------
    async def callback(self, request: Request) -> Response:
        if not await self._allow(request, "page", self._limits.login_pages_per_minute):
            return self._busy()
        q = request.query_params
        cookie = self._cookie_login(request)
        state = _single(q, "state")
        if cookie is None or state is None or not _same(cookie, state):
            self._refused("state_mismatch")
            return self._page(
                400, "This sign-in did not start in this browser", AGAIN, clear=cookie is not None
            )
        key = _key(cookie)
        now = self._now()

        def begin(doc: LoginDoc | None) -> LoginChange[LoginDoc | None]:
            if doc is None or doc.step != STEP_GOOGLE or now >= doc.expire_at:
                return LoginChange(result=None)
            doc.step = STEP_EXCHANGING
            return LoginChange(result=doc, login=doc)

        login = await self._store.mutate_login(key, begin)
        if login is None:
            self._refused("login_not_waiting_for_google", login=key[:12])
            return self._page(
                400, "This sign-in has expired or was already used", AGAIN, clear=True
            )

        async def fail(status: int, reason: str, title: str, *lines: str) -> Response:
            await self._close(key)
            self._refused(reason, login=key[:12])
            return self._page(status, title, *lines, clear=True)

        if q.getlist("error"):
            return await fail(400, "google_error", "Sign-in was cancelled", AGAIN)
        code = _single(q, "code")
        if code is None or GOOGLE_CODE_RE.fullmatch(code) is None:
            return await fail(400, "bad_google_code", "Sign-in did not complete", AGAIN)
        try:
            id_token = await self._oauth.exchange(
                code=code, redirect_uri=self.redirect_uri, code_verifier=login.google_verifier
            )
            claims = await self._oauth.verify_id_token(id_token)
        except OAuthError as exc:
            return await fail(
                400, f"google_{exc.reason}", "Sign-in with Google did not complete", AGAIN
            )
        nonce = claims.get("nonce")
        if not isinstance(nonce, str) or not _same(nonce, login.nonce):
            return await fail(400, "bad_nonce", "Sign-in with Google did not complete", AGAIN)
        if claims.get("email_verified") is not True:
            return await fail(
                403,
                "email_not_verified",
                "This Google account's email is not verified",
                "Verify it with Google, then run /team-relay:login again.",
            )
        email = normalise_email(claims.get("email"))
        if email is None:
            return await fail(400, "no_email", "Sign-in with Google did not complete", AGAIN)
        sub = claims.get("sub")
        if not isinstance(sub, str) or SUB_RE.fullmatch(sub) is None:
            return await fail(400, "no_sub", "Sign-in with Google did not complete", AGAIN)
        hd = claims.get("hd")
        if not self._config.google_identity_allowed(email, hd if isinstance(hd, str) else None):
            return await fail(
                403,
                "domain_not_allowed",
                "This relay is for its organisation's Google accounts only",
                "Sign in with your work Google account, then run /team-relay:login again.",
            )
        memberships = await self._teams.memberships(email, fresh=True)
        for found in memberships:
            bound = (await self._roster.snapshot(found.team)).sub_for(found.member, email)
            if bound is not None and not _same(bound, sub):
                return await fail(403, "sub_mismatch", REBOUND_TITLE, REBOUND_LINE)
        csrf = b64url(secrets.token_bytes(32))
        # M9-SPEC §3: no team is no longer the end: the page offers to create one.
        choices = [LoginChoice(team=m.team, member=m.member) for m in memberships]
        now = self._now()

        def offer(doc: LoginDoc | None) -> LoginChange[LoginDoc | None]:
            if doc is None or doc.step != STEP_EXCHANGING or now >= doc.expire_at:
                return LoginChange(result=None)
            doc.step = STEP_CHOOSE
            doc.email = email
            doc.sub = sub
            doc.choices = choices
            doc.csrf_sha256 = _key(csrf)
            return LoginChange(result=doc, login=doc)

        chosen = await self._store.mutate_login(key, offer)
        if chosen is None:
            return await fail(400, "login_expired", "This sign-in has expired", AGAIN)
        if not choices:
            log_event("login_no_team", login=key[:12])
        return await self._chooser(chosen, csrf)

    async def _chooser(
        self,
        login: LoginDoc,
        csrf: str,
        preselect: str | None = None,
        notice: str | None = None,
        status: int = 200,
    ) -> Response:
        """The chooser, with the account's open invitations (M9-SPEC §7.2); for an account
        on no team and invited nowhere, the create page (M9-SPEC §3)."""
        assert login.email is not None
        chosen = {c.team for c in login.choices}
        invitations = [
            InvitationView(
                team=row["team"],
                name=row["name"],
                member=row["member"],
                invited_by=row["invited_by_member"],
            )
            for row in await self._teams.invitations(login.email, login.sub)
            if row["team"] not in chosen
        ]
        if not login.choices and not invitations:
            # With a notice the page cannot prefill itself (it keeps what a refusal shows).
            member = suggest_member_id(login.email) if notice else ""
            form = CreateForm(CREATE_ACTION, member=member, error=notice)
            return self._create_page(login, csrf, form, status)
        names = {c.team: await self._teams.name(c.team) for c in login.choices}
        page = chooser_page(
            email=login.email,
            device=login.device,
            choices=login.choices,
            csrf=csrf,
            action="/v1/login/choose",
            names=names,
            preselect=preselect,
            invitations=invitations,
            notice=notice,
        )
        return html_response(page, status)

    def _create_page(
        self, login: LoginDoc, csrf: str, form: CreateForm, status: int = 200
    ) -> Response:
        """The create form, prefilled with a member id made from the email when empty."""
        assert login.email is not None
        if not form.member and not form.name and not form.error:
            form = CreateForm(form.action, member=suggest_member_id(login.email))
        page = create_page(
            email=login.email,
            device=login.device,
            csrf=csrf,
            form=form,
            on_team=bool(login.choices),
        )
        return html_response(page, status)

    # POST /v1/login/choose --------------------------------------------------------------------
    async def _read_form(
        self, request: Request, allowed: frozenset[str] = CHOOSE_FIELDS
    ) -> _Form | None:
        media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media != "application/x-www-form-urlencoded":
            return None
        declared = request.headers.get("content-length")
        if declared is not None and (
            not (declared.isascii() and declared.isdigit()) or int(declared) > MAX_FORM_BYTES
        ):
            return None
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_FORM_BYTES:
                return None
        try:
            pairs = parse_qsl(
                data.decode("ascii"), keep_blank_values=True, strict_parsing=bool(data)
            )
        except (UnicodeDecodeError, ValueError):
            return None
        fields: dict[str, str] = {}
        for name, value in pairs:
            if name not in allowed or name in fields:
                return None
            fields[name] = value
        return _Form(fields=fields)

    async def choose(self, request: Request) -> Response:
        if not await self._allow(request, "page", self._limits.login_pages_per_minute):
            return self._busy()
        origin = request.headers.get("origin")
        if origin is not None and origin != self.public_url:
            self._refused("cross_origin_choose")
            return self._page(403, "This request did not come from the sign-in page", AGAIN)
        cookie = self._cookie_login(request)
        if cookie is None:
            self._refused("no_login_cookie")
            return self._page(400, "This sign-in did not start in this browser", AGAIN)
        form = await self._read_form(request)
        if form is None:
            self._refused("bad_form")
            return self._page(400, "This form could not be read", AGAIN)
        key = _key(cookie)
        csrf = form.fields.get("csrf", "")
        action = form.fields.get("action", "continue")
        team = form.fields.get("team")
        # M9-SPEC §3: "new" is the chooser's "Create a new team" button.
        if action not in ("continue", "cancel", "new"):
            self._refused("bad_action")
            return self._page(400, "This form could not be read", AGAIN)
        now = self._now()

        # Read first (a transaction that writes nothing).
        current = await self._store.mutate_login(key, lambda doc: LoginChange(result=doc))
        if current is None or current.step != STEP_CHOOSE or now >= current.expire_at:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400, "This sign-in has expired or was already used", AGAIN, clear=True
            )
        if (
            current.csrf_sha256 is None
            or TOKEN_RE.fullmatch(csrf) is None
            or not _same(_key(csrf), current.csrf_sha256)
        ):
            self._refused("bad_csrf", login=key[:12])
            return self._page(403, "This form has expired", AGAIN)
        if action == "cancel":
            await self._close(key)
            log_event("login_cancelled", login=key[:12])
            return self._loopback(current, {"error": "access_denied", "state": current.state})
        if current.email is None or current.sub is None:  # a login from before §7.2
            await self._close(key)
            self._refused("login_without_sub", login=key[:12])
            return self._page(400, "This sign-in has expired", AGAIN, clear=True)
        if action == "new":
            return self._create_page(current, csrf, CreateForm(CREATE_ACTION))
        choice = next((c for c in current.choices if team is not None and c.team == team), None)
        if choice is None:
            self._refused("team_not_offered", login=key[:12])
            return self._page(400, "Choose one of your teams", AGAIN)
        # Checked again here, in one roster transaction, so a membership that ended since the
        # chooser was shown mints nothing. §7.2: the first sign-in with this email binds it to
        # this Google account; a later one must be the same account, and two first sign-ins
        # cannot both win. A team deleted meanwhile (M9-SPEC §1) mints nothing either.
        try:
            bound = await self._roster.bind(
                choice.team, choice.member, current.email, current.sub, self._retention
            )
        except TeamGone:
            bound = "gone"
        if bound == "other":
            await self._close(key)
            self._refused("sub_mismatch", login=key[:12])
            return self._page(403, REBOUND_TITLE, REBOUND_LINE, clear=True)
        if bound == "gone":
            await self._close(key)
            self._refused("membership_changed", login=key[:12])
            return self._page(
                403, "You are no longer on this team", "Ask the team owner.", clear=True
            )

        code = b64url(secrets.token_bytes(32))
        now = self._now()

        def mint(doc: LoginDoc | None) -> LoginChange[LoginDoc | None]:
            if (
                doc is None
                or doc.step != STEP_CHOOSE
                or now >= doc.expire_at
                or doc.csrf_sha256 != current.csrf_sha256
            ):
                return LoginChange(result=None)
            doc.step = STEP_DONE
            minted = LoginCode(
                key=_key(code),
                login_key=doc.key,
                team=choice.team,
                member=choice.member,
                device=doc.device,
                challenge=doc.challenge,
                created_at=now,
                expire_at=now + CODE_LIFETIME,
                email=doc.email,
            )
            return LoginChange(result=doc, login=doc, code=minted)

        done = await self._store.mutate_login(key, mint)
        if done is None:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400, "This sign-in has expired or was already used", AGAIN, clear=True
            )
        log_event("login_chosen", login=key[:12], team=choice.team, member=choice.member)
        return self._loopback(done, {"code": code, "state": done.state})

    # POST /v1/login/create (M9-SPEC §3) ----------------------------------------------------
    async def create(self, request: Request) -> Response:
        if not await self._allow(request, "page", self._limits.login_pages_per_minute):
            return self._busy()
        origin = request.headers.get("origin")
        if origin is not None and origin != self.public_url:
            self._refused("cross_origin_create")
            return self._page(403, "This request did not come from the sign-in page", AGAIN)
        cookie = self._cookie_login(request)
        if cookie is None:
            self._refused("no_login_cookie")
            return self._page(400, "This sign-in did not start in this browser", AGAIN)
        form = await self._read_form(request, CREATE_FIELDS)
        if form is None:
            self._refused("bad_form")
            return self._page(400, "This form could not be read", AGAIN)
        key = _key(cookie)
        csrf = form.fields.get("csrf", "")
        action = form.fields.get("action", "create")
        if action not in ("create", "back", "cancel"):
            self._refused("bad_action")
            return self._page(400, "This form could not be read", AGAIN)
        now = self._now()
        current = await self._store.mutate_login(key, lambda doc: LoginChange(result=doc))
        if current is None or current.step != STEP_CHOOSE or now >= current.expire_at:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400, "This sign-in has expired or was already used", AGAIN, clear=True
            )
        if (
            current.csrf_sha256 is None
            or TOKEN_RE.fullmatch(csrf) is None
            or not _same(_key(csrf), current.csrf_sha256)
        ):
            self._refused("bad_csrf", login=key[:12])
            return self._page(403, "This form has expired", AGAIN)
        if action == "cancel":
            await self._close(key)
            log_event("login_cancelled", login=key[:12])
            return self._loopback(current, {"error": "access_denied", "state": current.state})
        if current.email is None or current.sub is None:  # a login from before M6 §7.2
            await self._close(key)
            self._refused("login_without_sub", login=key[:12])
            return self._page(400, "This sign-in has expired", AGAIN, clear=True)
        if action == "back":
            return await self._chooser(current, csrf)
        name = form.fields.get("name", "")
        team = form.fields.get("team", "").strip()
        member = form.fields.get("member", "").strip()
        try:
            await self._teams.count_attempt(current.email, current.sub)  # M9-SPEC §7.4
            body: NewTeam = parse_new_team(
                {"name": name, "owner_member_id": member, **({"id": team} if team else {})}
            )
            ip_hash = sha256_hex(client_ip(request, self._on_cloud_run, self._hops))[:32]
            created = await self._teams.create(
                email=current.email, sub=current.sub, body=body, ip_hash=ip_hash, via=None
            )
        except ApiError as err:
            self._refused(f"create_{err.code}", login=key[:12])
            # A left-empty id shows the one made from the name, to edit.
            valid_name = normalise_team_name(name)
            suggested = team or (suggest_team_id(valid_name) if valid_name else "")
            refused = CreateForm(
                CREATE_ACTION,
                name=name,
                team=suggested,
                member=member,
                error=err.detail or "The team could not be created.",
            )
            return self._create_page(current, csrf, refused, status=err.status)
        choice = LoginChoice(team=created["team"], member=created["member"])
        now = self._now()

        def offer(doc: LoginDoc | None) -> LoginChange[LoginDoc | None]:
            if (
                doc is None
                or doc.step != STEP_CHOOSE
                or now >= doc.expire_at
                or doc.csrf_sha256 != current.csrf_sha256
            ):
                return LoginChange(result=None)
            doc.choices = [*doc.choices, choice]
            return LoginChange(result=doc, login=doc)

        offered = await self._store.mutate_login(key, offer)
        if offered is None:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400,
                "This sign-in has expired",
                "Your team was created. " + AGAIN,
                clear=True,
            )
        log_event("login_team_created", login=key[:12], team=choice.team, member=choice.member)
        return await self._chooser(offered, csrf, preselect=choice.team)

    # POST /v1/login/invitation (M9-SPEC §7.2) -----------------------------------------------
    async def invitation(self, request: Request) -> Response:
        if not await self._allow(request, "page", self._limits.login_pages_per_minute):
            return self._busy()
        origin = request.headers.get("origin")
        if origin is not None and origin != self.public_url:
            self._refused("cross_origin_invitation")
            return self._page(403, "This request did not come from the sign-in page", AGAIN)
        cookie = self._cookie_login(request)
        if cookie is None:
            self._refused("no_login_cookie")
            return self._page(400, "This sign-in did not start in this browser", AGAIN)
        form = await self._read_form(request, INVITATION_FIELDS)
        answers = ([(True, form.fields["accept"])] if form and "accept" in form.fields else []) + (
            [(False, form.fields["decline"])] if form and "decline" in form.fields else []
        )
        if form is None or len(answers) != 1:
            self._refused("bad_form")
            return self._page(400, "This form could not be read", AGAIN)
        accept, team = answers[0]
        key = _key(cookie)
        csrf = form.fields.get("csrf", "")
        now = self._now()
        current = await self._store.mutate_login(key, lambda doc: LoginChange(result=doc))
        if current is None or current.step != STEP_CHOOSE or now >= current.expire_at:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400, "This sign-in has expired or was already used", AGAIN, clear=True
            )
        if (
            current.csrf_sha256 is None
            or TOKEN_RE.fullmatch(csrf) is None
            or not _same(_key(csrf), current.csrf_sha256)
        ):
            self._refused("bad_csrf", login=key[:12])
            return self._page(403, "This form has expired", AGAIN)
        if current.email is None or current.sub is None:  # a login from before M6 §7.2
            await self._close(key)
            self._refused("login_without_sub", login=key[:12])
            return self._page(400, "This sign-in has expired", AGAIN, clear=True)
        try:
            answered = await self._teams.answer_invitation(
                team, email=current.email, sub=current.sub, accept=accept, via=None
            )
        except ApiError as err:
            self._refused(f"invitation_{err.code}", login=key[:12])
            if err.status == 403:  # the email is bound to another Google account
                await self._close(key)
                return self._page(403, REBOUND_TITLE, REBOUND_LINE, clear=True)
            if err.status == 429:
                notice, status = "Too many answers to invitations; try again later.", 429
            else:
                notice, status = "That invitation is no longer open.", 409
            return await self._chooser(current, csrf, notice=notice, status=status)
        if not accept:
            log_event("login_invitation_declined", login=key[:12], team=team)
            return await self._chooser(current, csrf)
        choice = LoginChoice(team=answered["team"], member=answered["member"])
        now = self._now()

        def offer(doc: LoginDoc | None) -> LoginChange[LoginDoc | None]:
            if (
                doc is None
                or doc.step != STEP_CHOOSE
                or now >= doc.expire_at
                or doc.csrf_sha256 != current.csrf_sha256
            ):
                return LoginChange(result=None)
            doc.choices = [c for c in doc.choices if c.team != choice.team] + [choice]
            return LoginChange(result=doc, login=doc)

        offered = await self._store.mutate_login(key, offer)
        if offered is None:
            self._refused("login_not_choosing", login=key[:12])
            return self._page(
                400,
                "This sign-in has expired",
                "You joined the team. " + AGAIN,
                clear=True,
            )
        log_event("login_invitation_accepted", login=key[:12], team=choice.team)
        return await self._chooser(offered, csrf, preselect=choice.team)

    def _loopback(self, login: LoginDoc, params: Mapping[str, str]) -> Response:
        # The only redirect target there is: the plugin's own listener on this machine.
        url = f"http://127.0.0.1:{int(login.port)}/callback?{urlencode(params)}"
        response = RedirectResponse(url, status_code=303, headers=dict(SECURITY_HEADERS))
        self._clear_cookie(response)
        return response

    # POST /v1/login/token ---------------------------------------------------------------------
    async def token(self, request: Request, raw: Any) -> Response:
        headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
        if not await self._allow(request, "token", self._limits.login_tokens_per_minute):
            return JSONResponse(
                {"error": "rate_limited", "detail": "Too many attempts; wait a minute."},
                429,
                headers=headers,
            )
        code = raw.get("code") if isinstance(raw, dict) else None
        verifier = raw.get("code_verifier") if isinstance(raw, dict) else None
        if (
            not isinstance(raw, dict)
            or set(raw) != {"code", "code_verifier"}
            or not isinstance(code, str)
            or TOKEN_RE.fullmatch(code) is None
            or not isinstance(verifier, str)
            or VERIFIER_RE.fullmatch(verifier) is None
        ):
            self._refused("bad_token_request")
            return JSONResponse(
                {"error": "invalid_request", "detail": "Send {code, code_verifier}."},
                400,
                headers=headers,
            )
        now = self._now()
        credential = new_credential()
        ckey = credential_key(credential)
        challenge = pkce_challenge(verifier)
        retention = self._retention

        def redeem(doc: LoginCode | None) -> Redemption[tuple[str, LoginCode | None]]:
            if doc is None:
                return Redemption(result=("unknown_code", None))
            if doc.used:
                # A code presented twice: whoever holds it, the credential it minted goes.
                minted = (doc.team, doc.credential_key) if doc.credential_key else None
                return Redemption(result=("reused_code", doc), revoke=minted)
            if now >= doc.expire_at:
                return Redemption(result=("expired_code", doc))
            doc.used = True
            if not _same(challenge, doc.challenge):
                return Redemption(result=("wrong_verifier", doc), code=doc)  # burnt
            doc.credential_key = ckey
            record = CredentialRecord(
                key=ckey,
                team=doc.team,
                member=doc.member,
                device=doc.device,
                created_at=now,
                last_used_at=now,
                expire_at=now + CREDENTIAL_LIFETIME,
                email_sha256=email_hash(doc.email) if doc.email else None,
            )
            audit = AuditEntry(
                time=now,
                team=doc.team,
                actor=doc.member,
                action="credential.create",
                outcome="created",
                expire_at=now + retention,
                member=doc.member,
                email_sha256=[email_hash(doc.email)] if doc.email else [],
                detail=f"credential {public_id(ckey)}",
            )
            return Redemption(result=("ok", doc), code=doc, credential=record, audit=[audit])

        try:
            outcome = await self._store.redeem_code(_key(code), redeem, now)
        except TeamGone:  # M9-SPEC §1: the team was deleted after the chooser
            self._refused("team_deleted")
            return JSONResponse({"error": "invalid_grant"}, 400, headers=headers)
        reason, doc = outcome.result
        if outcome.revoked:
            self._credentials.forget([r.key for r in outcome.revoked])
            why = "login code reused" if reason == "reused_code" else "device limit"
            await self._store.append_audit(
                [
                    AuditEntry(
                        time=now,
                        team=r.team,
                        actor="relay",
                        action="credential.revoke",
                        outcome="revoked",
                        expire_at=now + retention,
                        member=r.member,
                        detail=f"credential {public_id(r.key)}; {why}",
                    )
                    for r in outcome.revoked
                ]
            )
        if reason != "ok" or doc is None:
            self._refused(reason, revoked=len(outcome.revoked))
            return JSONResponse({"error": "invalid_grant"}, 400, headers=headers)
        log_event("login_completed", team=doc.team, member=doc.member, credential=public_id(ckey))
        return JSONResponse(
            {
                "credential": credential,
                "team": doc.team,
                "member": doc.member,
                "email": doc.email,
                "relay_url": self.public_url,
                "expires_at": format_time(now + CREDENTIAL_LIFETIME),
            },
            200,
            headers=headers,
        )
