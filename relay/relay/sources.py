"""What owners pick sources from (PICKERS-SPEC §3.5, §3.6): the JSON of ``GET
/v1/teams/{team}/sources/config`` and ``GET /v1/teams/{team}/sources/github``.

Neither answer ever holds the GitHub App's key, an installation token or a token of any kind:
the config names whether the app is set up and where an org owner installs it, and the Google
Picker's public settings (restricted by Google: an API key limited to the Picker API and the
console's host, an OAuth client limited to one JavaScript origin); the listing names the
repositories of the app's installations on the relay's allowed orgs only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .clock import format_time
from .config import Settings
from .errors import ApiError
from .github_app import MISCONFIGURED, RATE_LIMITED, GithubApp, GithubError


class GithubRateLimited(ApiError):
    """``503 github_rate_limited``, answered with ``Retry-After: retry_after``."""

    def __init__(self, retry_after: int) -> None:
        super().__init__(
            503, RATE_LIMITED, "GitHub's request budget is spent for now; try again later."
        )
        self.retry_after = retry_after


def config_json(settings: Settings | None) -> dict[str, Any]:
    """``SourcesConfig`` of ``plugin/src/boundaries-types.ts``: ``github`` says whether the app
    is configured and its install link; ``google_picker`` is null without the picker's
    settings."""
    app = settings.github_app if settings is not None else None
    picker = settings.picker if settings is not None else None
    return {
        "github": {
            "configured": app is not None,
            "install_url": app.install_url if app is not None else None,
        },
        "google_picker": (
            {"client_id": picker.client_id, "api_key": picker.api_key, "app_id": picker.app_id}
            if picker is not None
            else None
        ),
    }


async def github_json(app: GithubApp | None, orgs: frozenset[str]) -> dict[str, Any]:
    """``GithubListing`` of ``plugin/src/boundaries-types.ts``: every installation of the app on
    one of ``orgs`` (RELAY_GITHUB_ORGS) with its repositories, and when it was read from GitHub
    (the oldest of the installations' times). Raises ``ApiError``: ``404
    github_not_configured``, ``502 github_unavailable`` (GitHub's 5xx, a timeout, a malformed
    answer), ``502 github_app_misconfigured`` (GitHub refused the app's JWT) or
    :class:`GithubRateLimited`. GitHub's own words are never passed on."""
    if app is None:
        raise ApiError(404, "github_not_configured", "This relay has no GitHub app set up.")
    try:
        found = await app.list_installations()
    except GithubError as exc:
        if exc.code == RATE_LIMITED:
            raise GithubRateLimited(exc.retry_after or 60) from None
        if exc.code == MISCONFIGURED:
            raise ApiError(
                502, MISCONFIGURED, "GitHub refused the relay's app (its id or key is wrong)."
            ) from None
        raise ApiError(502, "github_unavailable", "GitHub didn't answer just now.") from None
    installations = [i for i in found if i.account.lower() in orgs]
    fetched = min((i.fetched_at for i in installations), default=None)
    return {
        "installations": [
            {
                "account": i.account,
                "state": i.state,
                "repository_selection": i.repository_selection,
                "repos": [
                    {"name": r.name, "id": r.id, "private": r.private, "archived": r.archived}
                    for r in i.repos
                ],
                "truncated": i.truncated,
            }
            for i in installations
        ],
        "fetched_at": format_time(
            datetime.fromtimestamp(fetched if fetched is not None else app.now(), UTC)
        ),
    }
