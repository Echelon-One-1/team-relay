"""A team's boundaries (M10-SPEC §1): the body of ``PUT /v1/teams/{team}/boundaries`` and the
JSON both routes answer with. The shapes match ``plugin/src/boundaries-types.ts``.

The body is ``{"version": <current>, "boundaries": {topic, github_orgs, drives,
member_folders}}``, nothing else (strict: unknown fields, wrong types and a bool for a number
are ``400 invalid_body``):

- ``topic``: as sent, no control character except newline and tab, and no format (bidi
  overrides), surrogate, private-use, unassigned or line/paragraph-separator character;
  then trimmed, 1-500 characters (M10-SPEC §7.5). Checking before trimming means a refused
  character is refused wherever it is, so every implementation's trim agrees.
- ``github_orgs``: at most 10, each ``^[A-Za-z0-9][A-Za-z0-9-]{0,38}$``; de-duplicated
  case-insensitively (the first spelling is kept).
- ``drives``: at most 10 ``{domain, shared_drive}``; ``domain`` a lower-case DNS name
  (:func:`relay.config.valid_domain`: labels of ``a-z0-9-`` not starting or ending with
  ``-``, at least two, at most 253 characters, the last not all digits, no trailing dot) and,
  when RELAY_ALLOWED_DOMAINS is set, one of those domains (``400 domain_not_allowed``,
  M10-SPEC §7.2); ``shared_drive`` 1-100 characters, no ``/``, no control or other character
  ``topic`` refuses (newline and tab included), not ``.`` or ``..`` and no leading or trailing
  space (it names a folder under the member's "Shared drives" mount); de-duplicated.
- ``member_folders``: a bool.
- ``version``: an integer 0..2^31-1, never a bool or a float.

The caps apply to the lists as sent, before de-duplication. A refusal names the field, never
the value sent (it could be anything). ``schema/boundaries-vectors.json`` holds the shared
test vectors.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .clock import format_time
from .config import valid_domain
from .errors import ApiError
from .store import DriveBoundary, TeamBoundaries

MAX_TOPIC = 500
MAX_ORGS = 10
MAX_DRIVES = 10
MAX_DRIVE_NAME = 100
# A version is a change count; this is far beyond any team's.
MAX_VERSION = 2**31 - 1
GITHUB_ORG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")
# Unicode categories no topic or drive name may hold: controls, format characters (the bidi
# overrides among them), surrogates, private use, unassigned, line/paragraph separators.
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})
# The only control characters a topic may hold (M10-SPEC §7.5); never a drive name.
TOPIC_CONTROLS = frozenset({"\n", "\t"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Drive(_Strict):
    domain: str
    shared_drive: str


class _Boundaries(_Strict):
    topic: str
    github_orgs: list[str] = Field(max_length=MAX_ORGS)
    drives: list[_Drive] = Field(max_length=MAX_DRIVES)
    member_folders: bool


class _SetBody(_Strict):
    version: int = Field(ge=0, le=MAX_VERSION)
    boundaries: _Boundaries


_FIELDS = frozenset(
    {
        "version",
        "boundaries",
        "topic",
        "github_orgs",
        "drives",
        "member_folders",
        "domain",
        "shared_drive",
    }
)


@dataclass(frozen=True)
class Boundaries:
    topic: str
    github_orgs: list[str]
    drives: list[DriveBoundary]
    member_folders: bool


def _invalid(where: str, what: str) -> ApiError:
    return ApiError(400, "invalid_body", f"{where}: {what}")


def _where(loc: tuple[Any, ...]) -> str:
    # Only the names this body has and list positions: an unknown key is the caller's input.
    parts = [str(p) for p in loc if isinstance(p, int) or p in _FIELDS]
    return ".".join(parts) or "(body)"


def _clean_text(text: str, allowed: frozenset[str] = frozenset()) -> bool:
    return not any(
        unicodedata.category(ch) in FORBIDDEN_CATEGORIES and ch not in allowed for ch in text
    )


def parse_set_body(
    raw: Any, allowed_domains: frozenset[str] = frozenset()
) -> tuple[int, Boundaries]:
    """The version the caller read and the boundaries it sends, checked as the module says;
    ``allowed_domains`` is RELAY_ALLOWED_DOMAINS (empty: any domain). Raises
    ``ApiError(400, "invalid_body")``, or ``ApiError(400, "domain_not_allowed")``."""
    try:
        body = _SetBody.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        if first["type"] == "extra_forbidden":
            raise _invalid(_where(first["loc"][:-1]), "unknown field") from None
        raise _invalid(_where(first["loc"]), first["msg"]) from None
    b = body.boundaries
    if not _clean_text(b.topic, TOPIC_CONTROLS):
        raise _invalid(
            "boundaries.topic", "no control or formatting characters other than newline and tab"
        )
    topic = b.topic.strip()
    if not 1 <= len(topic) <= MAX_TOPIC:
        raise _invalid("boundaries.topic", f"1 to {MAX_TOPIC} characters")
    orgs: list[str] = []
    seen: set[str] = set()
    for i, org in enumerate(b.github_orgs):
        if GITHUB_ORG_RE.fullmatch(org) is None:
            raise _invalid(
                f"boundaries.github_orgs.{i}",
                "a GitHub org name: 1 to 39 letters, digits and '-', not starting with '-'",
            )
        if org.lower() not in seen:
            seen.add(org.lower())
            orgs.append(org)
    drives: list[DriveBoundary] = []
    for i, drive in enumerate(b.drives):
        where = f"boundaries.drives.{i}"
        if not valid_domain(drive.domain):
            raise _invalid(f"{where}.domain", "a lower-case domain name, e.g. example.com")
        if allowed_domains and drive.domain not in allowed_domains:
            raise ApiError(
                400,
                "domain_not_allowed",
                f"{where}.domain: must be one of this relay's own domains",
            )
        name = drive.shared_drive
        if (
            not 1 <= len(name) <= MAX_DRIVE_NAME
            or "/" in name
            or not _clean_text(name)
            or name != name.strip()
            or name in (".", "..")
        ):
            raise _invalid(
                f"{where}.shared_drive",
                f"the shared drive's name: 1 to {MAX_DRIVE_NAME} characters, no '/', no "
                "control characters, no leading or trailing spaces",
            )
        entry = DriveBoundary(domain=drive.domain, shared_drive=name)
        if entry not in drives:
            drives.append(entry)
    return body.version, Boundaries(
        topic=topic, github_orgs=orgs, drives=drives, member_folders=b.member_folders
    )


@dataclass(frozen=True)
class Since:
    """M10-SPEC §7.1: the version in which each item of a boundaries version was last added."""

    orgs: dict[str, int]
    drives: dict[DriveBoundary, int]
    member_folders: int | None


def carried_since(current: TeamBoundaries | None, version: int, new: Boundaries) -> Since:
    """When each item of ``new`` (to be stored as ``version``) was last added, given the
    stored ``current``: an item ``current`` holds keeps its version (orgs compared without
    case, drives on domain and name); an item it does not hold, added for the first time or
    added back after a removal, gets ``version``. Member folders likewise while allowed; None
    while not. Computed inside the writing transaction, from the version it replaces."""
    orgs: dict[str, int] = {}
    for org in new.github_orgs:
        key = org.lower()
        kept = current.org_since.get(key) if current is not None else None
        orgs[key] = kept if kept is not None else version
    drives: dict[DriveBoundary, int] = {}
    for drive in new.drives:
        kept = current.drive_since.get(drive) if current is not None else None
        drives[drive] = kept if kept is not None else version
    folders: int | None = None
    if new.member_folders:
        kept = (
            current.member_folders_since if current is not None and current.member_folders else None
        )
        folders = kept if kept is not None else version
    return Since(orgs=orgs, drives=drives, member_folders=folders)


def boundaries_json(
    team: str, doc: TeamBoundaries | None, allowed_domains: frozenset[str] = frozenset()
) -> dict[str, Any]:
    """``TeamBoundaries`` of ``plugin/src/boundaries-types.ts``; never set: version 0, nulls.
    ``allowed_domains`` is RELAY_ALLOWED_DOMAINS (empty: any domain): a drive saved before it
    was set whose domain is not one of them is left out (M10-SPEC §7.2), so no member is ever
    handed a drive of another domain.

    ``since`` (M10-SPEC §7.1) says in which version each item was last added: ``github_orgs``
    by lower-case org name, ``drives`` in the order of ``boundaries.drives``, and
    ``member_folders`` (null while members' folders are not allowed). A member's acceptance
    of an earlier version covers an item only when the item has been there since."""
    if doc is None:
        return {
            "team": team,
            "version": 0,
            "boundaries": None,
            "since": None,
            "updated_at": None,
            "updated_by": None,
        }
    drives = [d for d in doc.drives if not allowed_domains or d.domain in allowed_domains]
    return {
        "team": team,
        "version": doc.version,
        "boundaries": {
            "topic": doc.topic,
            "github_orgs": list(doc.github_orgs),
            "drives": [{"domain": d.domain, "shared_drive": d.shared_drive} for d in drives],
            "member_folders": doc.member_folders,
        },
        "since": {
            "github_orgs": {
                o.lower(): doc.org_since.get(o.lower(), doc.version) for o in doc.github_orgs
            },
            "drives": [
                {
                    "domain": d.domain,
                    "shared_drive": d.shared_drive,
                    "since": doc.drive_since.get(d, doc.version),
                }
                for d in drives
            ],
            "member_folders": (
                (doc.member_folders_since if doc.member_folders_since is not None else doc.version)
                if doc.member_folders
                else None
            ),
        },
        "updated_at": format_time(doc.updated_at),
        "updated_by": doc.updated_by,
    }
