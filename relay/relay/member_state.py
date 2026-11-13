"""A member's own state on the relay (M11-SPEC §2, §3): the body of ``PUT me/acceptance`` and of
``PUT me/status``, and the JSON the routes answer with. The shapes match
``plugin/src/boundaries-types.ts`` (``Acceptance``, ``MemberStatusBody``).

``PUT me/acceptance``: ``{"version": int}``, nothing else; an integer 0..2^31-1, never a bool or
a float.

``PUT me/status``, every field required and nothing else (strict: unknown fields, a missing one,
wrong types and a bool for a number are refused):

- ``daemon``: ``version`` a string of at most 32 characters with no control or formatting
  character; ``started_at`` an RFC 3339 time with a zone.
- ``claude``: ``found``, ``signed_in`` bools.
- ``folder_count``: how many folders the member chose on their Mac (local folders only, 13 Nov
  2026), an integer 0..20, never a bool or a float; never a path or a folder name.
- ``folders_ok``: a bool; false when the member's folders file cannot be used, and then
  ``folder_count`` is 0.
- ``self_test``: ``ok`` a bool, ``at`` an RFC 3339 time with a zone, ``reason`` null or at most
  200 characters with no control or formatting character other than newline and tab.

An older plugin's body (with ``folders``, ``drive`` or ``sources``) is refused as an unknown
field. A status such a plugin stored earlier still reads: its ``folder_count`` and ``folders_ok``
are null (:func:`stored_folder_count`, :func:`stored_folders_ok`).

Times are stored and answered in the relay's own form (UTC, milliseconds, ``Z``). A refusal is
``400 invalid_body`` naming the field, never the value sent.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .clock import format_time
from .errors import ApiError
from .store import Acceptance

MAX_VERSION = 2**31 - 1
MAX_DAEMON_VERSION = 32
MAX_REASON = 200
MAX_TIME_LENGTH = 40
# The most folders a member chooses (the plugin's MAX_FOLDERS).
MAX_FOLDERS = 20
RFC3339 = re.compile(
    r"(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})"
)
# As for the boundaries' text (M10-SPEC §7.5): controls, format characters (the bidi overrides
# among them), surrogates, private use, unassigned, line/paragraph separators.
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})
REASON_CONTROLS = frozenset({"\n", "\t"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _AcceptBody(_Strict):
    version: int = Field(ge=0, le=MAX_VERSION)


class _Daemon(_Strict):
    version: str = Field(max_length=MAX_DAEMON_VERSION)
    started_at: str = Field(max_length=MAX_TIME_LENGTH)


class _Claude(_Strict):
    found: bool
    signed_in: bool


class _SelfTest(_Strict):
    ok: bool
    at: str = Field(max_length=MAX_TIME_LENGTH)
    reason: str | None = Field(max_length=MAX_REASON)


class _StatusBody(_Strict):
    daemon: _Daemon
    claude: _Claude
    folder_count: int = Field(ge=0, le=MAX_FOLDERS)
    folders_ok: bool
    self_test: _SelfTest


_FIELDS = frozenset(
    {
        "version",
        "daemon",
        "started_at",
        "claude",
        "found",
        "signed_in",
        "folder_count",
        "folders_ok",
        "self_test",
        "ok",
        "at",
        "reason",
    }
)


def _invalid(where: str, what: str) -> ApiError:
    return ApiError(400, "invalid_body", f"{where}: {what}")


def _where(loc: tuple[Any, ...]) -> str:
    # Only the names this body has: an unknown key is the caller's input.
    parts = [str(p) for p in loc if p in _FIELDS]
    return ".".join(parts) or "(body)"


def _validate[M: BaseModel](model: type[M], raw: Any) -> M:
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        if first["type"] == "extra_forbidden":
            raise _invalid(_where(first["loc"][:-1]), "unknown field") from None
        # The message only: pydantic's "input_value" is never echoed.
        raise _invalid(_where(first["loc"]), first["msg"]) from None


def _clean(text: str, allowed: frozenset[str] = frozenset()) -> bool:
    return not any(
        unicodedata.category(ch) in FORBIDDEN_CATEGORIES and ch not in allowed for ch in text
    )


def _time(raw: str, where: str) -> str:
    """An RFC 3339 time with a zone, in the relay's form (fractions past ms truncated)."""
    match = RFC3339.fullmatch(raw)
    if match is None:
        raise _invalid(where, "an RFC 3339 time with a zone")
    date, clock, fraction, zone = match.groups()
    text = f"{date}T{clock}"
    if fraction:
        text += "." + fraction[:6].ljust(6, "0")
    text += "+00:00" if zone in ("Z", "z") else zone
    try:
        parsed = datetime.fromisoformat(text).astimezone(UTC)
    except ValueError:
        raise _invalid(where, "an RFC 3339 time with a zone") from None
    formatted = format_time(parsed)
    assert formatted is not None
    return formatted


def parse_accept_body(raw: Any) -> int:
    """The version a member accepts; ``400 invalid_body`` for anything but the module's body."""
    return _validate(_AcceptBody, raw).version


def parse_status_body(raw: Any) -> dict[str, Any]:
    """The status as it is stored: the body checked as the module says, times normalised."""
    body = _validate(_StatusBody, raw)
    if not _clean(body.daemon.version):
        raise _invalid("daemon.version", "no control or formatting characters")
    if not body.folders_ok and body.folder_count != 0:
        raise _invalid("folder_count", "0 when folders_ok is false")
    reason = body.self_test.reason
    if reason is not None and not _clean(reason, REASON_CONTROLS):
        raise _invalid(
            "self_test.reason", "no control or formatting characters other than newline and tab"
        )
    return {
        "daemon": {
            "version": body.daemon.version,
            "started_at": _time(body.daemon.started_at, "daemon.started_at"),
        },
        "claude": {"found": body.claude.found, "signed_in": body.claude.signed_in},
        "folder_count": body.folder_count,
        "folders_ok": body.folders_ok,
        "self_test": {
            "ok": body.self_test.ok,
            "at": _time(body.self_test.at, "self_test.at"),
            "reason": reason,
        },
    }


def stored_folder_count(status: dict[str, Any]) -> int | None:
    """The folder count a stored status holds; None when it has none (a status an older plugin
    reported, before 13 Nov 2026) or anything but an integer 0..20."""
    count = status.get("folder_count")
    if type(count) is int and 0 <= count <= MAX_FOLDERS:
        return count
    return None


def stored_folders_ok(status: dict[str, Any]) -> bool | None:
    """Whether the member's folders file could be used, as a stored status says; None when it
    does not say (a status stored before it) or holds anything but a bool."""
    ok = status.get("folders_ok")
    return ok if isinstance(ok, bool) else None


def status_json(status: dict[str, Any], seen_at: datetime) -> dict[str, Any]:
    """A stored status as the routes answer it: ``daemon``, ``claude``, ``self_test`` in their
    order, then ``seen_at``. Re-built field by field, so a stored document never hands out
    more: never the folder count or ``folders_ok`` (the member's entry carries them, to whom
    the owner rule allows), and nothing an older plugin's status held besides these groups."""
    return {
        "daemon": {
            "version": status["daemon"]["version"],
            "started_at": status["daemon"]["started_at"],
        },
        "claude": {
            "found": status["claude"]["found"],
            "signed_in": status["claude"]["signed_in"],
        },
        "self_test": {
            "ok": status["self_test"]["ok"],
            "at": status["self_test"]["at"],
            "reason": status["self_test"]["reason"],
        },
        "seen_at": format_time(seen_at),
    }


def acceptance_json(accepted: Acceptance | None) -> dict[str, Any]:
    """``Acceptance`` of ``plugin/src/boundaries-types.ts``; never accepted: version 0."""
    if accepted is None:
        return {"version": 0, "accepted_at": None}
    return {"version": accepted.version, "accepted_at": format_time(accepted.accepted_at)}
