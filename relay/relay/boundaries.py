"""A team's boundaries (M10-SPEC §1; schema v3, local folders only, 13 Nov 2026): the body of
``PUT /v1/teams/{team}/boundaries`` and the JSON both routes answer with. The shapes match
``plugin/src/boundaries-types.ts``; the rule is ``plugin/src/boundaries-rule.ts`` and
``schema/boundaries-vectors.json`` holds the cases every implementation's tests load.

A team's boundaries are its topic alone. Each member chooses the folders on their own Mac the
answers come from; the relay never sees them (only how many, in the member's status).

The body is ``{"version": <current>, "boundaries": {"topic": <text>}}``, both fields required
and nothing else (strict: unknown fields, a missing one, wrong types and a bool for a number are
``400 invalid_body``):

- ``topic``: as sent, no control character except newline and tab, and no format (bidi
  overrides), surrogate, private-use or line/paragraph-separator character (unassigned code
  points are not refused, 11 Nov 2026: Unicode tables differ by side); then trimmed
  (``str.strip()``), 1-500 characters (M10-SPEC §7.5). Checking before trimming means a
  refused character is refused wherever it is, so every implementation's trim agrees.
- ``version``: an integer 0..2^31-1, never a bool or a float.

A ``boundaries`` object holding a field of the earlier schemas (the first of
:data:`REMOVED_FIELDS` it holds) is refused naming that field, so an older console or plugin is
told why rather than "unknown field".

A refusal names the field, never the value sent (it could be anything).
"""

from __future__ import annotations

import unicodedata
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .clock import format_time
from .errors import ApiError
from .store import TeamBoundaries

MAX_TOPIC = 500
# A version is a change count; this is far beyond any team's.
MAX_VERSION = 2**31 - 1
# Fields of the earlier schemas (M10, PICKERS-SPEC's v2), in the order a refusal names them.
REMOVED_FIELDS = ("github_orgs", "github_repos", "drive_folders", "drives", "member_folders")
REMOVED_DETAIL = "no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)"
# Unicode categories the topic may not hold: controls, format characters (the bidi overrides
# among them), surrogates, private use, line/paragraph separators. Not unassigned (Cn): Python's
# Unicode tables are older than the browsers' and members' Node (correction of 11 Nov 2026).
TOPIC_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
# The only control characters a topic may hold (M10-SPEC §7.5).
TOPIC_CONTROLS = frozenset({"\n", "\t"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Boundaries(_Strict):
    topic: str


class _SetBody(_Strict):
    version: int = Field(ge=0, le=MAX_VERSION)
    boundaries: _Boundaries


_FIELDS = frozenset({"version", "boundaries", "topic"})


def _invalid(where: str, what: str) -> ApiError:
    return ApiError(400, "invalid_body", f"{where}: {what}")


def _where(loc: tuple[Any, ...]) -> str:
    # Only the names this body has: an unknown key is the caller's input.
    parts = [str(p) for p in loc if p in _FIELDS]
    return ".".join(parts) or "(body)"


def topic_ok(text: str) -> bool:
    """No control character but newline and tab, and no character of
    :data:`TOPIC_FORBIDDEN_CATEGORIES` (checked before trimming)."""
    return not any(
        unicodedata.category(ch) in TOPIC_FORBIDDEN_CATEGORIES and ch not in TOPIC_CONTROLS
        for ch in text
    )


def parse_set_body(raw: Any) -> tuple[int, str]:
    """The version the caller read and the topic it sends, checked and trimmed as the module
    says. Raises ``ApiError(400, "invalid_body", ...)``."""
    if isinstance(raw, dict) and isinstance(raw.get("boundaries"), dict):
        for name in REMOVED_FIELDS:
            if name in raw["boundaries"]:
                raise _invalid(f"boundaries.{name}", REMOVED_DETAIL)
    try:
        body = _SetBody.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        if first["type"] == "extra_forbidden":
            raise _invalid(_where(first["loc"][:-1]), "unknown field") from None
        raise _invalid(_where(first["loc"]), first["msg"]) from None
    if not topic_ok(body.boundaries.topic):
        raise _invalid(
            "boundaries.topic", "no control or formatting characters other than newline and tab"
        )
    topic = body.boundaries.topic.strip()
    if not 1 <= len(topic) <= MAX_TOPIC:
        raise _invalid("boundaries.topic", f"1 to {MAX_TOPIC} characters")
    return body.version, topic


def boundaries_json(team: str, doc: TeamBoundaries | None) -> dict[str, Any]:
    """``TeamBoundaries`` of ``plugin/src/boundaries-types.ts``; never set: version 0, nulls."""
    if doc is None:
        return {
            "team": team,
            "version": 0,
            "boundaries": None,
            "updated_at": None,
            "updated_by": None,
        }
    return {
        "team": team,
        "version": doc.version,
        "boundaries": {"topic": doc.topic},
        "updated_at": format_time(doc.updated_at),
        "updated_by": doc.updated_by,
    }
