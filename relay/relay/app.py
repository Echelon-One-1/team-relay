"""FastAPI app (M1-SPEC §3).

``create_app(settings, store)`` builds the app; ``relay.app:app`` builds one from the
environment on first access (so importing this module has no side effects). Bodies are read
and validated by hand, after authentication, so the order of refusals is always
401 → 400 (on-behalf header) → 404 (other team) → 403/422/… and every refusal body is
``{"error", "detail"}``.

Who the caller is (M5-SPEC §3, §4; M6-SPEC §1):
- ``Bearer trc_…``: a device credential; its team and member, while the member is on that
  team's roster (and was added no later than the credential was minted).
  A credential that records the email it was minted through stops working as soon as the
  entry no longer holds that email (M6-SPEC §7.1; the removal also revokes it).
- any other bearer token: the verifier's principal. A delegate's principal (M3-SPEC §2)
  names the member it acts for in ``X-Relay-On-Behalf-Of``; a ``google:`` principal is the
  member of the URL's team whose roster entry holds the email, and when that email is bound
  to a Google ``sub`` (M6-SPEC §7.2) the ID token's ``sub`` must be it (an unbound email is
  bound to it on the first call to its own team); a ``token:sha256:`` principal
  (development) the member the team file names for the URL's team, while on the roster. A
  principal that is a member of another team but not this one gets ``404``; one that is a
  member of no team ``401`` (M6-SPEC §7.4). A delegate's token names the console's service
  account, not the member, so the delegate path has no ``sub`` to check.

A delegate may reach only the GET routes in DELEGATE_ROUTES, and with ``manage-roster`` the
roster mutations in ROSTER_MUTATIONS (the service then requires the member it names to be an
owner, as for anyone), and with ``manage-teams`` an owner's deletion of the team
(TEAM_MUTATIONS, M9-SPEC §7.7), and with ``member-self`` the viewer's own acceptance of the
boundaries and the viewer's own questions (MEMBER_SELF_MUTATIONS, M11-SPEC §2, §4; the service
refuses a capability call from a delegate). ``PUT me/status`` is never a delegate's (M11-SPEC
§3). No route names another member's acceptance: an owner accepts for nobody. A delegate with
``team: "*"`` (M9-SPEC §5) acts in the team the URL names, for the member of that team its
header's email is; a team that is not one and a team the email is not a member of are the
same ``404`` (M9-SPEC §7.3).

``GET /setup`` (M11-SPEC §5) is unauthenticated and outside ``/v1``: the setup script, rendered
at start (:mod:`relay.setup_script`); 404 when it is not configured.

``GET /`` and ``GET /login`` (docs/SIGNIN-PAGE.md) are the public sign-in page, with its
stylesheet and fonts under ``/v1/login/``: static, rendered at start (:mod:`relay.welcome`).

A roster entry that is only invited (M9-SPEC §7.2) is not a member anywhere here: it never
resolves a principal, a delegate's email or a credential.

Before the membership check (M9-SPEC §7.9), a principal not seen by this process as a member
of the URL's team in the last KNOWN_MEMBER_TTL counts one against a per-principal, per-minute
budget in the store (``non_member_requests_per_minute``); over it: ``429 rate_limited``.

Teams (M9-SPEC §1): a team the API created is a team while its record says so, read on every
request that names it, so a deleted team is refused (``404``) and its credentials stop
working (``401``) at once, on every instance.

The account routes (M9-SPEC §2, §4) name no team: ``GET /v1/me/teams``, ``POST /v1/teams``,
``POST /v1/me/invitations/{team}`` and ``/v1/admin/teams``. They take a Google identity only:
a Google ID token, or a delegate on behalf of an email (``manage-teams`` to create or to act
for an admin, ``manage-roster`` to answer an invitation); never a device credential (it is
bound to its team) or a static token. A delegate's creation carries
``X-Relay-Client-IP-Hash`` (M9-SPEC §7.6). Every admin audit entry says ``via`` and refused
admin actions are recorded (M9-SPEC §7.5).

The login pages (M5-SPEC §2) are unauthenticated and live under ``/v1/login``.

RELAY_ALLOWED_DOMAINS (M10-SPEC §7.2), when set: a Google ID token's email must be in one of
the domains and its ``hd`` claim that same domain (the verifier has already required
``email_verified``); a delegate's on-behalf-of email must be in one of them; a device
credential works only while the email it was minted through is. Refused: ``403
domain_not_allowed``. A delegate's own principal (the console's service account) is exempt.
"""

from __future__ import annotations

import os
import re
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import Unauthenticated, Verified, Verifier, bearer_token, build_verifier
from .clock import Clock, utc_now
from .config import Delegate, Identity, Settings, normalise_email
from .credentials import looks_like_credential
from .errors import ApiError, ConfigError, not_found
from .github_app import GithubApp
from .jsonutil import BodyError, parse_json, sha256_hex
from .log import log_event
from .login import LoginService, client_ip
from .manifest import ManifestValidator
from .oauth import GoogleOAuthProvider, OAuthProvider
from .pages import stylesheet_response
from .roster import OWNER, SeedConflict, email_hash
from .service import Caller, RelayService
from .sources import GithubRateLimited
from .store import Quota, Store, TeamGone
from .teams import (
    ADMIN_LIST_DEFAULT,
    ADMIN_LIST_MAX,
    ALL_TEAMS,
    VIA_DELEGATE,
    VIA_DIRECT,
    parse_new_team,
    valid_team_id,
)
from .welcome import load_welcome
from .welcome import mount as mount_welcome

MAX_BODY_BYTES = 256 * 1024

ON_BEHALF_HEADER = "x-relay-on-behalf-of"
MAX_ON_BEHALF_LENGTH = 320
# M3-SPEC §2: the console's reads, by route template. Nothing that moves presence or
# cursors (stream reads) and nothing that writes.
DELEGATE_ROUTES = frozenset(
    {
        "/v1/teams/{team}/me",
        "/v1/teams/{team}/directory",
        "/v1/teams/{team}/activity",
        "/v1/teams/{team}/requests/{request_id}",
        # M6-SPEC §3: the console's Members panel reads the roster (masked as for the member).
        "/v1/teams/{team}/roster",
        # M7-SPEC §1: what waits for the member's answering session. A peek, not a stream
        # read: it moves no cursor and writes no presence.
        "/v1/teams/{team}/inbox/summary",
        # M10-SPEC §1: the console shows the team's boundaries (read-only to non-owners).
        "/v1/teams/{team}/boundaries",
        # M11-SPEC §2, §3, §4: the Join, Team and Ask pages: the viewer's acceptance, the
        # team's status and the viewer's own recent questions.
        "/v1/teams/{team}/me/acceptance",
        "/v1/teams/{team}/members/status",
        "/v1/teams/{team}/me/requests",
        # PICKERS-SPEC §3.5, §3.6: the boundaries form's pickers (the service requires the
        # member the delegate names to be an owner).
        "/v1/teams/{team}/sources/config",
        "/v1/teams/{team}/sources/github",
    }
)
# M6-SPEC §3: with scope manage-roster, a delegate may also make these, by (method, route).
ROSTER_MUTATIONS = frozenset(
    {
        ("POST", "/v1/teams/{team}/roster"),
        ("PATCH", "/v1/teams/{team}/roster/{member}"),
        ("DELETE", "/v1/teams/{team}/roster/{member}"),
        # M10-SPEC §1: an owner sets the team's boundaries from the console.
        ("PUT", "/v1/teams/{team}/boundaries"),
    }
)
# M9-SPEC §7.7: with scope manage-teams, a delegate may delete a team for its owner.
TEAM_MUTATIONS = frozenset({("DELETE", "/v1/teams/{team}")})
# M11-SPEC §2, §4, §8: with scope member-self, a delegate acts as its viewer for these: the
# viewer's own acceptance and the viewer's own questions (never a capability call). Never
# PUT me/status.
MEMBER_SELF_MUTATIONS = frozenset(
    {
        ("PUT", "/v1/teams/{team}/me/acceptance"),
        ("POST", "/v1/teams/{team}/requests"),
    }
)
# M9-SPEC §7.6: the console's report of the viewer's address: a salted SHA-256, hex.
CLIENT_IP_HASH_HEADER = "x-relay-client-ip-hash"
CLIENT_IP_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
# M9-SPEC §7.9: a (principal, team) that resolved to a member skips the non-member budget
# for this long, in this process; at most this many are remembered.
KNOWN_MEMBER_TTL = timedelta(seconds=60)
KNOWN_MEMBER_CACHE = 4096
PRINCIPAL_WINDOW_SECONDS = 60

_STATUS_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    415: "unsupported_media_type",
}


ACCOUNT_WINDOW_SECONDS = 60


@dataclass(frozen=True)
class Account:
    """Who calls an account route (M9-SPEC §2): a Google account by its lower-cased email,
    with the ID token's ``sub`` when it came with one; ``delegate`` when a delegate names
    it."""

    email: str
    sub: str | None = None
    delegate: Delegate | None = None


def _error(err: ApiError) -> JSONResponse:
    return JSONResponse(err.body(), status_code=err.status)


async def read_json_body(request: Request) -> Any:
    declared = request.headers.get("content-length")
    # ASCII digits only: str.isdigit() also admits "²", which int() refuses.
    if declared is not None and (
        not (declared.isascii() and declared.isdigit()) or int(declared) > MAX_BODY_BYTES
    ):
        raise ApiError(413, "too_large", f"The body is larger than {MAX_BODY_BYTES} bytes.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ApiError(413, "too_large", f"The body is larger than {MAX_BODY_BYTES} bytes.")
        chunks.append(chunk)
    try:
        return parse_json(b"".join(chunks))
    except BodyError as exc:  # lone surrogates, non-finite numbers, too deep (§11.9)
        raise ApiError(400, "invalid_json", str(exc)) from None
    except ValueError:  # UnicodeDecodeError included
        raise ApiError(400, "invalid_json", "The body is not valid JSON.") from None


# Mutations whose refusals are audited (§7). Cursor moves are transport bookkeeping.
def _audited_action(request: Request) -> str | None:
    if request.method == "GET":
        return None
    path = request.url.path
    if path.endswith("/cursor"):
        return None
    if path.endswith("/manifest"):
        return "manifest.publish"
    if path.endswith("/boundaries"):
        return "boundaries_set"
    if path.endswith("/me/acceptance"):
        return "boundaries_accepted"
    if path.endswith("/me/status"):
        return None  # M11-SPEC §3: the answerer's status, bookkeeping like a cursor move
    for suffix in ("ack", "reply", "progress"):
        if path.endswith("/" + suffix):
            return f"request.{suffix}"
    if path.endswith("/events"):
        return "request.event"
    if path.endswith("/requests"):
        return "request.create"
    if "/roster" in path:
        return {"POST": "roster.add", "PATCH": "roster.update"}.get(request.method, "roster.remove")
    if "/credentials/" in path:
        return "credential.revoke"
    if request.method == "DELETE" and path.count("/") == 3:
        return "team.delete"  # /v1/teams/{team}
    return "unknown"


def _query_int(raw: str | None, name: str, low: int, high: int, default: int) -> int:
    if raw is None:
        return default
    if not (raw.isascii() and raw.isdigit()) or len(raw) > 6 or not low <= int(raw) <= high:
        raise ApiError(400, "invalid_query", f"{name} must be {low}..{high}")
    return int(raw)


def create_app(
    settings: Settings,
    store: Store,
    *,
    clock: Clock = utc_now,
    poll_interval: float = 1.0,
    verifier: Verifier | None = None,
    oauth: OAuthProvider | None = None,
    github: GithubApp | None = None,
) -> FastAPI:
    """``oauth`` is the Google sign-in the login pages use; without it one is built from
    ``settings.oauth_client`` with Google's fixed endpoints. ``github`` is the GitHub App's
    client (PICKERS-SPEC §4.3); without it one is built from ``settings.github_app`` for
    ``api.github.com``. Tests pass fakes here, never through the environment. Without
    ``settings.public_url`` the login pages are 404."""
    manifests = ManifestValidator(settings.manifest_schema)
    welcome = load_welcome(settings.brand_name)
    if github is None and settings.github_app is not None:
        github = GithubApp(settings.github_app, settings.team_config.allowed_github_orgs)
    service = RelayService(
        settings.team_config,
        store,
        manifests,
        clock,
        poll_interval,
        settings=settings,
        github=github,
    )
    verifier = verifier if verifier is not None else build_verifier(settings)
    config = settings.team_config
    roster = service.roster
    teams = service.teams
    on_cloud_run = bool(os.environ.get("K_SERVICE"))
    login: LoginService | None = None
    if settings.public_url is not None:
        if oauth is None:
            if settings.oauth_client is None:
                raise ConfigError("the login needs an OAuth client (RELAY_OAUTH_CLIENT_FILE)")
            oauth = GoogleOAuthProvider(settings.oauth_client)
        login = LoginService(
            settings,
            store,
            roster,
            teams,
            service.credentials,
            oauth,
            service.now,
            on_cloud_run=on_cloud_run,
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # M6-SPEC §1: upsert the seed at startup. Not fatal here: each team is seeded again,
        # lazily, before its roster is first read. Except a file team that is a team the API
        # created (M9-SPEC §7.1): the relay refuses to start, naming the id.
        try:
            await roster.seed_all()
            await teams.ensure_seed_records()  # M9-SPEC §1
        except SeedConflict:
            await store.aclose()
            raise
        except Exception as exc:
            log_event("roster_seed_failed", severity="ERROR", error=type(exc).__name__)
        yield
        if github is not None:
            await github.aclose()
        await store.aclose()

    app = FastAPI(
        title="team relay",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.service = service
    app.state.store = store

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _error(exc)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        if exc.status_code == 404:
            return _error(not_found())
        return JSONResponse({"error": code, "detail": code.replace("_", " ")}, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "invalid_body", "detail": "Invalid request."}, 422)

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception) -> JSONResponse:
        log_event(
            "internal_error",
            severity="ERROR",
            error=type(exc).__name__,
            method=request.method,
            path=request.url.path,
        )
        return JSONResponse({"error": "internal", "detail": "Internal error."}, 500)

    class NotAMember(Unauthenticated):
        """A delegate named a well-formed email that is on no roster of its team."""

    class NoSuchTeam(Unauthenticated):
        """A ``team: "*"`` delegate named a team that is not a team (now)."""

    class DomainNotAllowed(Unauthenticated):
        """M10-SPEC §7.2: an identity outside RELAY_ALLOWED_DOMAINS."""

    def domain_refusal() -> ApiError:
        return ApiError(
            403,
            "domain_not_allowed",
            "This relay accepts Google accounts of its own organisation's domains only.",
        )

    def check_google(verified: Verified) -> None:
        """A Google ID token's identity, not a delegate's (M10-SPEC §7.2)."""
        if verified.principal.startswith("google:") and not config.google_identity_allowed(
            verified.principal.removeprefix("google:"), verified.hd
        ):
            raise DomainNotAllowed("domain_not_allowed")

    def on_behalf_email(request: Request) -> str:
        """Exactly one ``X-Relay-On-Behalf-Of`` naming one email, else 401. Never logged."""
        values = request.headers.getlist(ON_BEHALF_HEADER)
        if not values:
            raise Unauthenticated("missing_on_behalf")
        if len(values) != 1:
            raise Unauthenticated("repeated_on_behalf")
        if len(values[0]) > MAX_ON_BEHALF_LENGTH:
            raise Unauthenticated("unknown_on_behalf")
        email = normalise_email(values[0])
        if not email:
            raise Unauthenticated("unknown_on_behalf")
        if not config.email_allowed(email):  # M10-SPEC §7.2
            raise DomainNotAllowed("domain_not_allowed")
        return email

    async def on_behalf_of(delegate: Delegate, email: str, team: str) -> Identity:
        """The member a delegate acts for (M3-SPEC §2): the header's email is a member of the
        delegate's team on its roster, else 403 ``not_a_member``. For a ``team: "*"``
        delegate (M9-SPEC §5) the delegate's team is the URL's; a team that is not one and a
        team the email is not a member of are both ``404`` (M9-SPEC §7.3), so the answer says
        nothing about which teams exist."""
        if delegate.any_team:
            if await teams.active(team) is None:
                raise NoSuchTeam("no_such_team")
            member = (await roster.snapshot(team)).member_for_email(email)
            if member is None:
                raise NoSuchTeam("not_a_member")
            return Identity(team=team, member=member)
        member = await roster.member_for_email(delegate.team, email)
        if member is None:
            # A well-formed email that is simply not on this team's roster (M6-SPEC §4): the
            # console shows "not on this team" instead of treating it as a broken setup.
            raise NotAMember("not_a_member")
        return Identity(team=delegate.team, member=member)

    retention = timedelta(days=config.audit_retention_days)
    known_members: OrderedDict[tuple[str, str], datetime] = OrderedDict()

    async def count_unknown_principal(principal: str, team: str, request: Request) -> None:
        """M9-SPEC §7.9: before the membership check, a principal this process has not seen
        as a member of ``team`` lately counts one against its per-minute budget."""
        now = service.now()
        seen = known_members.get((principal, team))
        if seen is not None and timedelta(0) <= now - seen < KNOWN_MEMBER_TTL:
            return
        start = int(now.timestamp()) // PRINCIPAL_WINDOW_SECONDS * PRINCIPAL_WINDOW_SECONDS
        quota = Quota(
            key=f"principal.{sha256_hex(principal)[:32]}.{start}",
            limit=config.limits.non_member_requests_per_minute,
            expire_at=datetime.fromtimestamp(start + 2 * PRINCIPAL_WINDOW_SECONDS, UTC),
        )
        if not await store.count_login_quota(quota):
            log_event(
                "principal_rate_limited",
                severity="WARNING",
                method=request.method,
                path=request.url.path,
            )
            raise ApiError(429, "rate_limited", "Too many requests; wait a minute.")

    def remember_member(principal: str, team: str) -> None:
        known_members[(principal, team)] = service.now()
        known_members.move_to_end((principal, team))
        while len(known_members) > KNOWN_MEMBER_CACHE:
            known_members.popitem(last=False)

    async def member_in(verified: Verified, team: str) -> tuple[str | None, bool]:
        """The principal's member in ``team`` and whether its email still needs binding;
        ``(None, True)`` when the email is bound to another Google account."""
        principal = verified.principal
        if principal.startswith("google:"):
            email = principal.removeprefix("google:")
            snapshot = await roster.snapshot(team)
            member = snapshot.member_for_email(email)
            if member is None or verified.sub is None:
                return member, False
            bound = snapshot.sub_for(member, email)
            if bound is None:
                return member, True
            return (member, False) if bound == verified.sub else (None, True)
        member = config.token_member(principal, team)
        if member is None or member not in (await roster.snapshot(team)).entries:
            return None, False
        return member, False

    async def other_teams(verified: Verified, team: str) -> AsyncIterator[str]:
        """Every other team the principal may be on: the file's, then (a Google account)
        the created ones the account index names; looked up only when needed."""
        for candidate in config.team_ids():
            if candidate != team:
                yield candidate
        if verified.principal.startswith("google:"):
            email = verified.principal.removeprefix("google:")
            for candidate in await teams.indexed_teams(email):
                if candidate != team:
                    yield candidate

    async def resolve(verified: Verified, team: str) -> Identity:
        """The principal's membership in ``team`` (when it is a team), else in the first
        other team that has one (for the 404), else 401 (M5-SPEC §4, M6-SPEC §7.4). A
        Google account whose email is bound to another ``sub`` is not that member
        (M6-SPEC §7.2)."""
        rebound = False
        if await teams.active(team) is not None:
            member, flag = await member_in(verified, team)
            if member is not None:
                if flag:
                    # The email's first use by a Google ID token on its own team binds it.
                    assert verified.sub is not None
                    email = verified.principal.removeprefix("google:")
                    try:
                        outcome = await roster.bind(team, member, email, verified.sub, retention)
                    except TeamGone:
                        raise Unauthenticated("team_deleted") from None
                    if outcome == "other":
                        raise Unauthenticated("sub_mismatch")
                    if outcome == "gone":
                        raise Unauthenticated("not_on_roster")
                return Identity(team=team, member=member)
            rebound = flag
        async for candidate in other_teams(verified, team):
            member, flag = await member_in(verified, candidate)
            if member is None:
                rebound = rebound or flag
                continue
            return Identity(team=candidate, member=member)
        raise Unauthenticated("sub_mismatch" if rebound else "unknown_principal")

    async def from_credential(token: str, team: str) -> tuple[Identity, str]:
        record = await service.credentials.authenticate(
            token, team if valid_team_id(team) else None
        )
        if record is None:
            raise Unauthenticated("bad_credential")
        # M9-SPEC §1: a deleted team's credentials stop working at once, on every instance.
        if await teams.active(record.team) is None:
            raise Unauthenticated("team_deleted")
        entry = (await roster.snapshot(record.team)).entries.get(record.member)
        # Removed (M5-SPEC §3), or removed and added again since this credential was minted.
        if entry is None or record.created_at < entry.added_at:
            raise Unauthenticated("not_on_roster")
        # Minted through an email the entry no longer holds (M6-SPEC §7.1): the removal
        # revoked it; this holds on an instance whose credential cache has not seen that yet.
        if record.email_sha256 is not None and record.email_sha256 not in {
            email_hash(e) for e in entry.emails
        }:
            raise Unauthenticated("email_removed")
        # M10-SPEC §7.2: minted through an email outside the allowed domains (before they were
        # set): refused. A credential that records no email needs every email of its entry in.
        if config.allowed_domains:
            minted = [
                e
                for e in entry.emails
                if record.email_sha256 is None or email_hash(e) == record.email_sha256
            ]
            if not minted or not all(config.email_allowed(e) for e in minted):
                raise DomainNotAllowed("domain_not_allowed")
        return Identity(team=record.team, member=record.member), record.key

    async def authenticate(request: Request, team: str) -> Caller:
        token = bearer_token(request.headers.get("authorization"))
        delegate: Delegate | None = None
        credential: str | None = None
        email: str | None = None
        principal: str | None = None
        try:
            if token is None:
                raise Unauthenticated("missing_bearer")
            if looks_like_credential(token):
                identity, credential = await from_credential(token, team)
            else:
                verified = await verifier.verify(token)
                # A delegate is never a member (M3-SPEC §2): checked first.
                delegate = config.delegate(verified.principal)
                if delegate is not None:
                    email = on_behalf_email(request)
                    principal = "google:" + email
                    await count_unknown_principal(principal, team, request)  # §7.9
                    identity = await on_behalf_of(delegate, email, team)
                else:
                    check_google(verified)  # M10-SPEC §7.2
                    principal = verified.principal
                    await count_unknown_principal(principal, team, request)  # §7.9
                    identity = await resolve(verified, team)
                    if principal.startswith("google:"):
                        email = principal.removeprefix("google:")
        except Unauthenticated as exc:
            # Structured, and never the token (§2) or the on-behalf value.
            log_event(
                "auth_rejected",
                severity="WARNING",
                reason=exc.reason,
                method=request.method,
                path=request.url.path,
                **({"delegate": delegate.principal} if delegate is not None else {}),
            )
            if isinstance(exc, NotAMember):
                raise ApiError(
                    403, "not_a_member", "This Google account is not a member of this team."
                ) from None
            if isinstance(exc, NoSuchTeam):
                raise not_found() from None
            if isinstance(exc, DomainNotAllowed):
                raise domain_refusal() from None
            raise ApiError(401, "unauthenticated") from None

        if delegate is None:
            if ON_BEHALF_HEADER in request.headers:
                # Only meaningful for a delegate (M3-SPEC §2). Refused, never ignored: a
                # member's client that sends it is confused about who it is.
                log_event(
                    "on_behalf_refused",
                    severity="WARNING",
                    team=identity.team,
                    member=identity.member,
                    method=request.method,
                    path=request.url.path,
                )
                raise ApiError(
                    400, "bad_request", "X-Relay-On-Behalf-Of is only accepted from a delegate."
                )
            caller = Caller(
                team=identity.team, member=identity.member, credential=credential, email=email
            )
            if team != identity.team:
                err = not_found()
                action = _audited_action(request)
                if action is not None:
                    await service.audit_refusal(caller, action, err)
                raise err
            if principal is not None:
                remember_member(principal, team)
            return caller

        caller = Caller(
            team=identity.team, member=identity.member, delegate=delegate.principal, email=email
        )
        if principal is not None and team == identity.team:
            remember_member(principal, team)
        route_path = getattr(request.scope.get("route"), "path", None)
        reads = request.method == "GET" and route_path in DELEGATE_ROUTES
        route = (request.method, route_path)
        manages = (
            (delegate.manages_roster and route in ROSTER_MUTATIONS)
            or (delegate.manages_teams and route in TEAM_MUTATIONS)
            or (delegate.acts_as_member and route in MEMBER_SELF_MUTATIONS)
        )
        if team != identity.team or not (reads or manages):
            # A delegate's refusals go to stdout, never to the audit log: the member it names
            # did not attempt them (M3-SPEC §2).
            err = (
                not_found()
                if team != identity.team
                else ApiError(403, "forbidden", "A delegate may only read.")
            )
            log_event(
                "delegate_refused",
                severity="WARNING",
                delegate=delegate.principal,
                team=identity.team,
                member=identity.member,
                method=request.method,
                path=request.url.path,
                status=err.status,
            )
            raise err
        log_event(
            "delegated_read" if reads else "delegated_change",
            delegate=delegate.principal,
            team=identity.team,
            member=identity.member,
            method=request.method,
            path=request.url.path,
        )
        return caller

    CallerDep = Depends(authenticate)

    # M9-SPEC §2, §4: the account routes -----------------------------------------------------
    async def authenticate_account(request: Request) -> Account:
        """A Google identity: a Google ID token (its email and ``sub``), or a delegate naming
        an email in ``X-Relay-On-Behalf-Of``. A device credential is bound to its team and a
        static token has no email: ``403 google_identity_required``."""
        token = bearer_token(request.headers.get("authorization"))
        delegate: Delegate | None = None
        needs_google = ApiError(
            403,
            "google_identity_required",
            "This needs a Google account: sign in with Google, not a device credential.",
        )
        try:
            if token is None:
                raise Unauthenticated("missing_bearer")
            if looks_like_credential(token):
                if await service.credentials.authenticate(token) is None:
                    raise Unauthenticated("bad_credential")
                raise needs_google
            verified = await verifier.verify(token)
            delegate = config.delegate(verified.principal)
            if delegate is not None:
                account = Account(email=on_behalf_email(request), delegate=delegate)
            elif verified.principal.startswith("google:"):
                check_google(verified)  # M10-SPEC §7.2
                if ON_BEHALF_HEADER in request.headers:
                    raise ApiError(
                        400, "bad_request", "X-Relay-On-Behalf-Of is only accepted from a delegate."
                    )
                email = normalise_email(verified.principal.removeprefix("google:"))
                if email is None:
                    raise Unauthenticated("bad_email")
                account = Account(email=email, sub=verified.sub)
            else:
                raise needs_google
        except Unauthenticated as exc:
            log_event(
                "auth_rejected",
                severity="WARNING",
                reason=exc.reason,
                method=request.method,
                path=request.url.path,
                **({"delegate": delegate.principal} if delegate is not None else {}),
            )
            if isinstance(exc, DomainNotAllowed):
                raise domain_refusal() from None
            raise ApiError(401, "unauthenticated") from None
        # Every account route reads several documents: one budget per account and minute.
        now = service.now()
        start = int(now.timestamp()) // ACCOUNT_WINDOW_SECONDS * ACCOUNT_WINDOW_SECONDS
        quota = Quota(
            key=f"account.{email_hash(account.email)[:32]}.{start}",
            limit=config.limits.reads_per_minute,
            expire_at=datetime.fromtimestamp(start + 2 * ACCOUNT_WINDOW_SECONDS, UTC),
        )
        if not await store.count_login_quota(quota):
            log_event("account_rate_limited", severity="WARNING", path=request.url.path)
            raise ApiError(429, "rate_limited", "Too many requests; wait a minute.")
        return account

    def refuse_delegate(account: Account, request: Request, detail: str) -> None:
        assert account.delegate is not None
        log_event(
            "delegate_refused",
            severity="WARNING",
            delegate=account.delegate.principal,
            method=request.method,
            path=request.url.path,
            status=403,
        )
        raise ApiError(403, "forbidden", detail)

    def via_of(account: Account) -> str:
        return VIA_DELEGATE if account.delegate is not None else VIA_DIRECT

    async def admin_account(request: Request, action: str, team: str) -> Account:
        """An admin (config ``admins``), by a Google ID token or through a ``manage-teams``
        delegate. Admin is relay-wide and is not a team role (M9-SPEC §4). A refusal here is
        recorded in the admin audit (M9-SPEC §7.5)."""
        account = await authenticate_account(request)
        try:
            if account.delegate is not None and not account.delegate.manages_teams:
                refuse_delegate(account, request, "This delegate may not act for an admin.")
            if not config.is_admin(account.email):
                log_event(
                    "admin_refused",
                    severity="WARNING",
                    method=request.method,
                    path=request.url.path,
                    via_delegate=account.delegate is not None,
                )
                raise ApiError(403, "forbidden", "Only a relay admin can do this.")
        except ApiError as err:
            await teams.admin_refused(
                actor_sha256=email_hash(account.email),
                action=action,
                team=team,
                err=err,
                via=via_of(account),
            )
            raise
        return account

    @app.get("/v1/me/teams")
    async def my_teams(request: Request) -> dict[str, Any]:
        account = await authenticate_account(request)
        only = None
        if account.delegate is not None and not account.delegate.any_team:
            only = account.delegate.team  # a per-team delegate sees its own team only
        return await teams.my_teams(account.email, account.sub, only=only)

    # M9-SPEC §7.2: accept or decline an invitation.
    @app.post("/v1/me/invitations/{team}")
    async def answer_invitation(team: str, request: Request) -> dict[str, Any]:
        account = await authenticate_account(request)
        if account.delegate is not None:
            if not account.delegate.manages_roster:
                refuse_delegate(account, request, "This delegate may not answer invitations.")
            if not account.delegate.any_team and team != account.delegate.team:
                raise not_found()
        if not valid_team_id(team):
            raise not_found()
        raw = await read_json_body(request)
        if (
            not isinstance(raw, dict)
            or set(raw) != {"accept"}
            or not isinstance(raw["accept"], bool)
        ):
            raise ApiError(422, "invalid_body", 'Send {"accept": true} or {"accept": false}.')
        return await teams.answer_invitation(
            team,
            email=account.email,
            sub=account.sub,
            accept=raw["accept"],
            via=account.delegate.principal if account.delegate is not None else None,
        )

    @app.post("/v1/teams")
    async def create_team(request: Request) -> JSONResponse:
        account = await authenticate_account(request)
        if account.delegate is not None and not account.delegate.manages_teams:
            refuse_delegate(account, request, "This delegate may not create teams.")
        # M9-SPEC §7.6: the console reports its viewer's address, salted and hashed; the
        # per-address limit counts it. Without it a delegate creates nothing.
        console_ip: str | None = None
        if account.delegate is not None:
            values = request.headers.getlist(CLIENT_IP_HASH_HEADER)
            if len(values) != 1 or CLIENT_IP_HASH_RE.fullmatch(values[0]) is None:
                log_event("client_ip_hash_missing", severity="WARNING", path=request.url.path)
                raise ApiError(
                    400,
                    "bad_request",
                    "A delegate's team creation needs one X-Relay-Client-IP-Hash "
                    "(64 lower-case hex).",
                )
            console_ip = values[0]
        await teams.count_attempt(account.email, account.sub)  # M9-SPEC §7.4
        body = parse_new_team(await read_json_body(request))
        # A delegate's socket address is the console's own: the reported one counts instead.
        ip_hash = None
        if account.delegate is None:
            ip_hash = sha256_hex(client_ip(request, on_cloud_run, settings.forwarded_for_hops))[:32]
        created = await teams.create(
            email=account.email,
            sub=account.sub,
            body=body,
            ip_hash=ip_hash,
            via=account.delegate.principal if account.delegate is not None else None,
            console_ip_hash=console_ip,
        )
        return JSONResponse(created, status_code=201)

    @app.get("/v1/admin/teams")
    async def admin_teams(request: Request) -> dict[str, Any]:
        await admin_account(request, "admin.list", ALL_TEAMS)
        q = request.query_params
        after = q.get("after")
        if after is not None and not valid_team_id(after):
            raise ApiError(400, "invalid_query", "after must be a team id")
        limit = _query_int(q.get("limit"), "limit", 1, ADMIN_LIST_MAX, ADMIN_LIST_DEFAULT)
        return await teams.admin_list(after, limit)

    async def confirmation(request: Request) -> Any:
        raw = await read_json_body(request)
        if not isinstance(raw, dict) or set(raw) != {"confirm"}:
            raise ApiError(
                422, "confirm_mismatch", 'Send {"confirm": "<team id>"} to delete the team.'
            )
        return raw["confirm"]

    @app.delete("/v1/admin/teams/{team}")
    async def admin_delete_team(team: str, request: Request) -> dict[str, Any]:
        account = await admin_account(request, "team.delete", team)
        actor = email_hash(account.email)
        try:
            confirm = await confirmation(request)
            if account.delegate is not None and confirm == team:  # M9-SPEC §7.8
                await teams.count_delegate_delete(team, account.delegate.principal)
            return await teams.delete(
                team, actor_sha256=actor, confirm=confirm, via=via_of(account)
            )
        except ApiError as err:
            await teams.admin_refused(
                actor_sha256=actor, action="team.delete", team=team, err=err, via=via_of(account)
            )
            raise

    # M9-SPEC §7.7: an owner deletes a team they own (never a file team). A Google identity
    # only (an ID token, or a manage-teams delegate for the owner), as for the account routes.
    @app.delete("/v1/teams/{team}")
    async def owner_delete_team(
        team: str, request: Request, caller: Caller = CallerDep
    ) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            if caller.email is None:
                raise ApiError(
                    403,
                    "google_identity_required",
                    "Deleting a team needs a Google account: sign in with Google, not a device "
                    "credential.",
                )
            snapshot = await roster.snapshot(caller.team, fresh=True)
            if snapshot.role(caller.member) != OWNER:
                raise ApiError(403, "forbidden", "Only an owner can delete the team.")
            confirm = await confirmation(request)
            return await teams.delete(
                caller.team,
                actor_sha256=email_hash(caller.email),
                confirm=confirm,
                via=VIA_DELEGATE if caller.delegate else VIA_DIRECT,
                owner=caller.member,
            )

        return await service._guarded(caller, "team.delete", None, work)

    # docs/SIGNIN-PAGE.md: the public sign-in page; no authentication, the same for everyone.
    mount_welcome(app, welcome)

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    # M11-SPEC §5: the one-command setup script; no authentication, the same for everyone.
    @app.get("/setup")
    async def setup() -> Response:
        if settings.setup_script is None:
            raise not_found()
        return Response(
            content=settings.setup_script,
            media_type="text/x-shellscript; charset=utf-8",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    # M2-SPEC §1: Cloud Run's front end reserves some paths ending in "z", so the same
    # health check is also served here. No credentials at the app (Cloud Run IAM still
    # applies in front of it).
    @app.get("/v1/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/teams/{team}/me")
    async def me(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.me(caller)

    # M6-SPEC §2: the roster ---------------------------------------------------------------
    @app.get("/v1/teams/{team}/roster")
    async def roster_list(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.roster_list(caller)

    @app.post("/v1/teams/{team}/roster")
    async def roster_add(request: Request, caller: Caller = CallerDep) -> JSONResponse:
        raw = await _read_guarded(service, caller, "roster.add", lambda: read_json_body(request))
        return JSONResponse(await service.roster_add(caller, raw), status_code=201)

    @app.patch("/v1/teams/{team}/roster/{member}")
    async def roster_update(member: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(service, caller, "roster.update", lambda: read_json_body(request))
        return await service.roster_update(caller, member, raw)

    @app.delete("/v1/teams/{team}/roster/{member}")
    async def roster_remove(member: str, caller: Caller = CallerDep) -> Any:
        return await service.roster_remove(caller, member)

    # M10-SPEC §1: the team's boundaries -----------------------------------------------------
    @app.get("/v1/teams/{team}/boundaries")
    async def boundaries_get(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.boundaries_get(caller)

    @app.put("/v1/teams/{team}/boundaries")
    async def boundaries_put(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        raw = await _read_guarded(
            service, caller, "boundaries_set", lambda: read_json_body(request)
        )
        return await service.boundaries_set(caller, raw)

    # M11-SPEC §2: the caller's own acceptance of the boundaries. No route names a member.
    @app.get("/v1/teams/{team}/me/acceptance")
    async def acceptance_get(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.acceptance_get(caller)

    @app.put("/v1/teams/{team}/me/acceptance")
    async def acceptance_put(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        raw = await _read_guarded(
            service, caller, "boundaries_accepted", lambda: read_json_body(request)
        )
        return await service.acceptance_set(caller, raw)

    # M11-SPEC §3: the background answerer's status (the member itself only) and the team's.
    @app.put("/v1/teams/{team}/me/status")
    async def status_put(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.status_set(caller, await read_json_body(request))

    @app.get("/v1/teams/{team}/members/status")
    async def members_status(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.members_status(caller)

    # PICKERS-SPEC §3.5, §3.6: what owners pick sources from. Owners only (a delegate for an
    # owner); never cached: the config is per deployment, the listing names private
    # repositories.
    no_store_headers = {"Cache-Control": "no-store"}

    @app.get("/v1/teams/{team}/sources/config")
    async def sources_config(caller: Caller = CallerDep) -> JSONResponse:
        try:
            config = await service.sources_config(caller)
        except ApiError as err:
            return JSONResponse(err.body(), status_code=err.status, headers=no_store_headers)
        return JSONResponse(config, headers=no_store_headers)

    @app.get("/v1/teams/{team}/sources/github")
    async def sources_github(caller: Caller = CallerDep) -> JSONResponse:
        try:
            listing = await service.sources_github(caller)
        except GithubRateLimited as err:
            headers = {**no_store_headers, "Retry-After": str(err.retry_after)}
            return JSONResponse(err.body(), status_code=err.status, headers=headers)
        except ApiError as err:
            return JSONResponse(err.body(), status_code=err.status, headers=no_store_headers)
        return JSONResponse(listing, headers=no_store_headers)

    # M11-SPEC §4: the caller's own recent questions.
    @app.get("/v1/teams/{team}/me/requests")
    async def my_requests(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.my_requests(caller, request.query_params.get("limit"))

    # M10-SPEC §2a: the Desktop OAuth client members connect Drive with. Any active member
    # (a device credential or a Google identity); not a delegate (not in DELEGATE_ROUTES).
    # Never cached, never logged.
    @app.get("/v1/teams/{team}/drive-client")
    async def drive_client(caller: Caller = CallerDep) -> JSONResponse:
        no_store = {"Cache-Control": "no-store"}
        drive = settings.drive_client
        if drive is None:
            err = ApiError(404, "drive_not_configured", "Google Drive is not set up on this relay.")
            return JSONResponse(err.body(), status_code=404, headers=no_store)
        log_event("drive_client_served", team=caller.team, member=caller.member)
        return JSONResponse(
            {"client_id": drive.client_id, "client_secret": drive.client_secret},
            headers=no_store,
        )

    # M5-SPEC §3: device credentials -------------------------------------------------------
    @app.get("/v1/teams/{team}/credentials")
    async def credentials_list(caller: Caller = CallerDep) -> Any:
        return await service.credentials_list(caller)

    @app.delete("/v1/teams/{team}/credentials/{credential_id}")
    async def credential_revoke(credential_id: str, caller: Caller = CallerDep) -> Any:
        return await service.credential_revoke(caller, credential_id)

    # M5-SPEC §2: the login pages (no authentication) ------------------------------------
    def login_service() -> LoginService:
        if login is None:
            raise not_found()
        return login

    @app.get("/v1/login/style.css")
    async def login_stylesheet() -> Response:
        login_service()
        return stylesheet_response()

    @app.get("/v1/login/start")
    async def login_start(request: Request) -> Response:
        return await login_service().start(request)

    @app.get("/v1/login/callback")
    async def login_callback(request: Request) -> Response:
        return await login_service().callback(request)

    @app.post("/v1/login/choose")
    async def login_choose(request: Request) -> Response:
        return await login_service().choose(request)

    @app.post("/v1/login/create")
    async def login_create(request: Request) -> Response:
        return await login_service().create(request)

    @app.post("/v1/login/invitation")
    async def login_invitation(request: Request) -> Response:
        return await login_service().invitation(request)

    @app.post("/v1/login/token")
    async def login_token(request: Request) -> Response:
        service_ = login_service()
        try:
            raw = await read_json_body(request)
        except ApiError:
            raw = None  # the service answers 400 invalid_request for anything unreadable
        return await service_.token(request, raw)

    @app.put("/v1/teams/{team}/members/{member}/manifest")
    async def put_manifest(member: str, request: Request, caller: Caller = CallerDep) -> Any:
        if member != caller.member:
            # Before reading the body: the 403 does not depend on it.
            return await service.publish_manifest(caller, member, None)
        raw = await _read_guarded(
            service, caller, "manifest.publish", lambda: read_json_body(request)
        )
        return await service.publish_manifest(caller, member, raw)

    @app.get("/v1/teams/{team}/directory")
    async def directory(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.directory(caller)

    @app.get("/v1/teams/{team}/activity")
    async def activity(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        q = request.query_params
        return await service.activity(caller, q.get("since"), q.get("limit"))

    @app.get("/v1/teams/{team}/inbox/summary")
    async def inbox_summary(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.inbox_summary(caller)

    @app.post("/v1/teams/{team}/requests")
    async def create_request(request: Request, caller: Caller = CallerDep) -> JSONResponse:
        raw = await _read_guarded(
            service, caller, "request.create", lambda: read_json_body(request)
        )
        status, payload = await service.create_request(caller, raw)
        return JSONResponse(payload, status_code=status)

    @app.get("/v1/teams/{team}/streams/{stream}")
    async def read_stream(stream: str, request: Request, caller: Caller = CallerDep) -> Any:
        q = request.query_params
        return await service.read_stream(
            caller,
            stream,
            q.get("after"),
            q.get("wait"),
            q.get("limit"),
            request.is_disconnected,
        )

    @app.post("/v1/teams/{team}/streams/{stream}/cursor")
    async def set_cursor(stream: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await read_json_body(request)
        return await service.set_cursor(caller, stream, raw)

    @app.post("/v1/teams/{team}/requests/{request_id}/ack")
    async def ack(request_id: str, caller: Caller = CallerDep) -> Any:
        return await service.ack(caller, request_id)

    @app.post("/v1/teams/{team}/requests/{request_id}/reply")
    async def reply(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.reply", lambda: read_json_body(request), request_id
        )
        return await service.reply(caller, request_id, raw)

    @app.post("/v1/teams/{team}/requests/{request_id}/progress")
    async def progress(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.progress", lambda: read_json_body(request), request_id
        )
        payload = await service.progress(caller, request_id, raw)
        return JSONResponse(payload, status_code=201)

    @app.post("/v1/teams/{team}/requests/{request_id}/events")
    async def tool_event(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.event", lambda: read_json_body(request), request_id
        )
        payload = await service.tool_event(caller, request_id, raw)
        return JSONResponse(payload, status_code=201)

    @app.get("/v1/teams/{team}/requests/{request_id}")
    async def get_request(request_id: str, caller: Caller = CallerDep) -> Any:
        return await service.get_request(caller, request_id)

    return app


async def _read_guarded(
    service: RelayService,
    caller: Caller,
    action: str,
    read: Callable[[], Awaitable[Any]],
    request_id: str | None = None,
) -> Any:
    """Read a mutation's body; a refused body (413, bad JSON) is audited like any refusal."""
    try:
        return await read()
    except ApiError as err:
        await service.audit_refusal(caller, action, err, request_id)
        raise


def create_app_from_env() -> FastAPI:
    settings = Settings.from_env()
    from .store_firestore import FirestoreStore

    store = FirestoreStore(
        project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
        database=os.environ.get("RELAY_FIRESTORE_DATABASE") or None,
    )
    log_event(
        "relay_start",
        auth_mode=settings.auth_mode,
        teams=sorted(settings.team_config.teams),
        login=settings.login_enabled,
        drive_client=settings.drive_client is not None,
        github_app=settings.github_app is not None,
        picker=settings.picker is not None,
        setup_script=settings.setup_script is not None,
        forwarded_for_hops=settings.forwarded_for_hops,
    )
    return create_app(settings, store)


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    # `uvicorn relay.app:app` resolves `app` with getattr; build it then, from env, once.
    global _app
    if name == "app":
        if _app is None:
            _app = create_app_from_env()
        return _app
    raise AttributeError(name)
