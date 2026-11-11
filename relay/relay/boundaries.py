"""A team's boundaries (M10-SPEC §1, PICKERS-SPEC §2): the body of ``PUT
/v1/teams/{team}/boundaries``, the item keys, ``since`` and the JSON both routes answer with.
The shapes match ``plugin/src/boundaries-types.ts``; the rule is ``plugin/src/boundaries-rule.ts``
and ``schema/boundaries-vectors.json`` holds the cases both implementations' tests load.

The body is ``{"version": <current>, "boundaries": {topic, github_orgs, github_repos,
drive_folders, drives, member_folders}}``, every field required and nothing else (strict:
unknown fields, a missing one, wrong types and a bool for a number are ``400 invalid_body``):

- ``topic``: as sent, no control character except newline and tab, and no format (bidi
  overrides), surrogate, private-use or line/paragraph-separator character (unassigned code
  points are not refused, 11 Nov 2026: Unicode tables differ by side);
  then trimmed (``str.strip()``), 1-500 characters (M10-SPEC §7.5). Checking before trimming
  means a refused character is refused wherever it is, so every implementation's trim agrees.
- ``github_orgs``: at most 10 whole orgs, each ``^[A-Za-z0-9][A-Za-z0-9-]{0,38}$``.
- ``github_repos``: at most 100 ``{org, repo, id}``; ``org`` as above, ``repo``
  ``^[A-Za-z0-9._-]{1,100}$`` and not all dots, ``id`` an integer 1..2^53-1 or null (pasted,
  not checked against GitHub).
- ``drive_folders``: at most 20 ``{domain, drive_id, folder_id, folder_name, drive_name}``;
  ``domain`` a lower-case DNS name (:func:`relay.config.valid_domain`), ``folder_id``
  ``^[A-Za-z0-9_-]{10,200}$``, ``drive_id`` the same or null (pasted), ``folder_name`` 1-255
  characters with no control or other character ``topic`` refuses (newline and tab included;
  like the topic, unassigned code points are not refused, 11 Nov 2026) and no leading or trailing
  space (``/`` allowed: display text and a search hint, never a
  path), ``drive_name`` null or the same rule capped at 100.
- ``drives``: the legacy name-matched drives (M10), at most 10 ``{domain, shared_drive}``;
  ``shared_drive`` 1-100 characters, no ``/``, the same refused characters plus unassigned code
  points, not ``.`` or
  ``..``, no leading or trailing space. A write may keep only drives the stored document
  already holds (:func:`legacy_drives_ok`; ``400 legacy_drive``), never add one.
- ``member_folders``: a bool. ``version``: an integer 0..2^31-1, never a bool or a float.

The caps apply to the lists as sent, before de-duplication. Then (:func:`parse_set_body`) the
first of duplicate orgs and repositories (compared without case), folders (on ``folder_id``)
and legacy drives (exactly) is kept, and a repository of a whole-org entry is dropped.

The relay's allowlists (PICKERS-SPEC §2.1, M10-SPEC §7.2), each empty when unset:
RELAY_ALLOWED_DOMAINS (every drive's and folder's domain, ``400 domain_not_allowed``),
RELAY_GITHUB_ORGS (every whole org and repository's org, ``400 org_not_allowed``) and
RELAY_ALLOWED_SHARED_DRIVES (every folder's ``drive_id``; a pasted folder whose ``folder_id``
is one of them is a whole drive and gets it as its ``drive_id``; ``400 drive_not_allowed``).
:func:`visible` leaves stored entries outside them out of everything the relay hands out.

A refusal names the field, never the value sent (it could be anything).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .clock import format_time
from .config import valid_domain
from .errors import ApiError
from .store import DriveBoundary, FolderBoundary, RepoBoundary, TeamBoundaries

MAX_TOPIC = 500
MAX_ORGS = 10
MAX_DRIVES = 10
MAX_REPOS = 100
MAX_FOLDERS = 20
MAX_DRIVE_NAME = 100
MAX_FOLDER_NAME = 255
# A picked folder's shared drive name: at most as long as a legacy shared drive's name.
MAX_PICKED_DRIVE_NAME = MAX_DRIVE_NAME
# The largest repository id: JavaScript's largest safe integer (the console and plugin read it).
MAX_REPO_ID = 2**53 - 1
# A version is a change count; this is far beyond any team's.
MAX_VERSION = 2**31 - 1
# PICKERS-SPEC §2.2, §3.3: an item key is at most this long; a status names at most this many.
MAX_ITEM_KEY = 400
MAX_MISSING = 140
GITHUB_ORG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")
GITHUB_REPO_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")
# A Google Drive id: of a folder, or of a shared drive (also its top folder's id).
DRIVE_ITEM_ID_RE = re.compile(r"[A-Za-z0-9_-]{10,200}")
# Unicode categories a legacy drive name may not hold: controls, format characters (the bidi
# overrides among them), surrogates, private use, unassigned, line/paragraph separators.
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})
# The topic and picked folder and drive names: the same without the unassigned (Cn) check, because
# Python's Unicode tables are older than the browsers' and members' Node, so a new emoji passed the
# console and failed here (PICKERS-SPEC, correction of 11 Nov 2026).
PICKED_NAME_FORBIDDEN_CATEGORIES = FORBIDDEN_CATEGORIES - {"Cn"}
# The only control characters a topic may hold (M10-SPEC §7.5); never a name.
TOPIC_CONTROLS = frozenset({"\n", "\t"})
# PICKERS-SPEC §3.3: a missing-source key holds no control or format character.
KEY_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf"})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Drive(_Strict):
    domain: str
    shared_drive: str


class _Repo(_Strict):
    org: str
    repo: str
    id: int | None


class _Folder(_Strict):
    domain: str
    drive_id: str | None
    folder_id: str
    folder_name: str
    drive_name: str | None


class _Boundaries(_Strict):
    topic: str
    github_orgs: list[str] = Field(max_length=MAX_ORGS)
    github_repos: list[_Repo] = Field(max_length=MAX_REPOS)
    drive_folders: list[_Folder] = Field(max_length=MAX_FOLDERS)
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
        "github_repos",
        "drive_folders",
        "drives",
        "member_folders",
        "domain",
        "shared_drive",
        "org",
        "repo",
        "id",
        "drive_id",
        "folder_id",
        "folder_name",
        "drive_name",
    }
)


@dataclass(frozen=True)
class Boundaries:
    """A valid body's boundaries as the relay stores them (normalised)."""

    topic: str
    github_orgs: list[str]
    drives: list[DriveBoundary]
    member_folders: bool
    github_repos: list[RepoBoundary]
    drive_folders: list[FolderBoundary]


def _invalid(where: str, what: str) -> ApiError:
    return ApiError(400, "invalid_body", f"{where}: {what}")


def _where(loc: tuple[Any, ...]) -> str:
    # Only the names this body has and list positions: an unknown key is the caller's input.
    parts = [str(p) for p in loc if isinstance(p, int) or p in _FIELDS]
    return ".".join(parts) or "(body)"


def _clean_text(
    text: str,
    allowed: frozenset[str] = frozenset(),
    categories: frozenset[str] = FORBIDDEN_CATEGORIES,
) -> bool:
    return not any(unicodedata.category(ch) in categories and ch not in allowed for ch in text)


def org_ok(org: str) -> bool:
    return GITHUB_ORG_RE.fullmatch(org) is not None


def repo_name_ok(name: str) -> bool:
    """``^[A-Za-z0-9._-]{1,100}$`` and not all dots."""
    return GITHUB_REPO_RE.fullmatch(name) is not None and name.strip(".") != ""


def repo_id_ok(repo_id: Any) -> bool:
    """A whole number 1..2^53-1 (never a bool), or None (pasted)."""
    if repo_id is None:
        return True
    return type(repo_id) is int and 1 <= repo_id <= MAX_REPO_ID


def drive_item_id_ok(item_id: Any) -> bool:
    return isinstance(item_id, str) and DRIVE_ITEM_ID_RE.fullmatch(item_id) is not None


def folder_name_ok(name: str, limit: int = MAX_FOLDER_NAME) -> bool:
    """1..``limit`` code points, no control or invisible characters, no surrounding space."""
    return (
        1 <= len(name) <= limit
        and not any(unicodedata.category(ch) in PICKED_NAME_FORBIDDEN_CATEGORIES for ch in name)
        and name == name.strip()
    )


def _drive_name_ok(name: str) -> bool:
    return (
        1 <= len(name) <= MAX_DRIVE_NAME
        and "/" not in name
        and _clean_text(name)
        and name == name.strip()
        and name not in (".", "..")
    )


def parse_set_body(
    raw: Any,
    allowed_domains: frozenset[str] = frozenset(),
    allowed_orgs: frozenset[str] = frozenset(),
    allowed_drives: frozenset[str] = frozenset(),
) -> tuple[int, Boundaries]:
    """The version the caller read and the boundaries it sends, checked and normalised as the
    module says. ``allowed_domains`` is RELAY_ALLOWED_DOMAINS, ``allowed_orgs`` RELAY_GITHUB_ORGS
    (lower case) and ``allowed_drives`` RELAY_ALLOWED_SHARED_DRIVES (each empty: any). Raises
    ``ApiError(400, ...)``: ``invalid_body``, ``domain_not_allowed``, ``org_not_allowed`` or
    ``drive_not_allowed``. Legacy drives against the stored document are
    :func:`legacy_drives_ok`'s to check."""
    try:
        body = _SetBody.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        if first["type"] == "extra_forbidden":
            raise _invalid(_where(first["loc"][:-1]), "unknown field") from None
        raise _invalid(_where(first["loc"]), first["msg"]) from None
    b = body.boundaries
    if not _clean_text(b.topic, TOPIC_CONTROLS, PICKED_NAME_FORBIDDEN_CATEGORIES):
        raise _invalid(
            "boundaries.topic", "no control or formatting characters other than newline and tab"
        )
    topic = b.topic.strip()
    if not 1 <= len(topic) <= MAX_TOPIC:
        raise _invalid("boundaries.topic", f"1 to {MAX_TOPIC} characters")

    org_rule = "a GitHub org name: 1 to 39 letters, digits and '-', not starting with '-'"
    for i, org in enumerate(b.github_orgs):
        if not org_ok(org):
            raise _invalid(f"boundaries.github_orgs.{i}", org_rule)
    for i, r in enumerate(b.github_repos):
        where = f"boundaries.github_repos.{i}"
        if not org_ok(r.org):
            raise _invalid(f"{where}.org", org_rule)
        if not repo_name_ok(r.repo):
            raise _invalid(
                f"{where}.repo",
                "a repository name: 1 to 100 letters, digits, '.', '_' and '-', not all dots",
            )
        if not repo_id_ok(r.id):
            raise _invalid(f"{where}.id", "GitHub's repository id (a positive integer) or null")
    for i, f in enumerate(b.drive_folders):
        where = f"boundaries.drive_folders.{i}"
        if not valid_domain(f.domain):
            raise _invalid(f"{where}.domain", "a lower-case domain name, e.g. example.com")
        if f.drive_id is not None and not drive_item_id_ok(f.drive_id):
            raise _invalid(f"{where}.drive_id", "a Google Drive id or null")
        if not drive_item_id_ok(f.folder_id):
            raise _invalid(f"{where}.folder_id", "a Google Drive id")
        if not folder_name_ok(f.folder_name):
            raise _invalid(
                f"{where}.folder_name",
                f"1 to {MAX_FOLDER_NAME} characters, no control characters, no leading or "
                "trailing spaces",
            )
        if f.drive_name is not None and not folder_name_ok(f.drive_name, MAX_PICKED_DRIVE_NAME):
            raise _invalid(
                f"{where}.drive_name",
                f"null or 1 to {MAX_PICKED_DRIVE_NAME} characters, no control characters, no "
                "leading or trailing spaces",
            )
    for i, d in enumerate(b.drives):
        where = f"boundaries.drives.{i}"
        if not valid_domain(d.domain):
            raise _invalid(f"{where}.domain", "a lower-case domain name, e.g. example.com")
        if not _drive_name_ok(d.shared_drive):
            raise _invalid(
                f"{where}.shared_drive",
                f"the shared drive's name: 1 to {MAX_DRIVE_NAME} characters, no '/', no "
                "control characters, no leading or trailing spaces",
            )

    # The relay's allowlists, once every entry is well formed.
    if allowed_domains:
        for name, entries in (("drive_folders", b.drive_folders), ("drives", b.drives)):
            for i, entry in enumerate(entries):
                if entry.domain not in allowed_domains:
                    raise ApiError(
                        400,
                        "domain_not_allowed",
                        f"boundaries.{name}.{i}.domain: must be one of this relay's own domains",
                    )
    if allowed_orgs:
        org_refusal = "must be one of this relay's GitHub organisations"
        for i, org in enumerate(b.github_orgs):
            if org.lower() not in allowed_orgs:
                raise ApiError(400, "org_not_allowed", f"boundaries.github_orgs.{i}: {org_refusal}")
        for i, r in enumerate(b.github_repos):
            if r.org.lower() not in allowed_orgs:
                raise ApiError(
                    400, "org_not_allowed", f"boundaries.github_repos.{i}.org: {org_refusal}"
                )
    folders: list[FolderBoundary] = []
    for i, f in enumerate(b.drive_folders):
        drive_id = f.drive_id
        if allowed_drives:
            # A pasted link (no drive id) is allowed only as one of the drives itself.
            if drive_id is None and f.folder_id in allowed_drives:
                drive_id = f.folder_id
            if drive_id not in allowed_drives:
                raise ApiError(
                    400,
                    "drive_not_allowed",
                    f"boundaries.drive_folders.{i}.drive_id: must be one of this relay's "
                    "shared drives",
                )
        folders.append(
            FolderBoundary(
                domain=f.domain,
                drive_id=drive_id,
                folder_id=f.folder_id,
                folder_name=f.folder_name,
                drive_name=f.drive_name,
            )
        )

    # De-duplicated: the first of each is kept, as spelt, in the order sent.
    orgs: list[str] = []
    org_seen: set[str] = set()
    for org in b.github_orgs:
        if org.lower() not in org_seen:
            org_seen.add(org.lower())
            orgs.append(org)
    repos: list[RepoBoundary] = []
    repo_seen: set[str] = set()
    for r in b.github_repos:
        key = repo_key_of(r.org, r.repo)
        if r.org.lower() in org_seen or key in repo_seen:
            continue  # the whole org already covers it, or a duplicate
        repo_seen.add(key)
        repos.append(RepoBoundary(org=r.org, repo=r.repo, id=r.id))
    kept_folders: list[FolderBoundary] = []
    folder_seen: set[str] = set()
    for f in folders:
        if f.folder_id not in folder_seen:
            folder_seen.add(f.folder_id)
            kept_folders.append(f)
    drives: list[DriveBoundary] = []
    for d in b.drives:
        entry = DriveBoundary(domain=d.domain, shared_drive=d.shared_drive)
        if entry not in drives:
            drives.append(entry)
    return body.version, Boundaries(
        topic=topic,
        github_orgs=orgs,
        drives=drives,
        member_folders=b.member_folders,
        github_repos=repos,
        drive_folders=kept_folders,
    )


def legacy_drives_ok(stored: Iterable[DriveBoundary] | None, sent: Iterable[DriveBoundary]) -> bool:
    """PICKERS-SPEC §2.1: name-matched drives can be kept, never added. True when every drive
    ``sent`` is one ``stored`` (None: nothing stored) holds, exactly on domain and name."""
    held = set(stored or ())
    return all(d in held for d in sent)


def legacy_drive_refusal(stored: Iterable[DriveBoundary] | None, sent: list[DriveBoundary]) -> None:
    """``400 legacy_drive`` naming the first drive of ``sent`` that ``stored`` does not hold."""
    held = set(stored or ())
    for i, d in enumerate(sent):
        if d not in held:
            raise ApiError(
                400,
                "legacy_drive",
                f"boundaries.drives.{i}: Pick shared-drive folders instead of typing drive names.",
            )


# PICKERS-SPEC §2.2: item keys ---------------------------------------------------------------


def repo_key_of(org: str, repo: str) -> str:
    """A repository's ``since`` key: lower-case ``org/repo``."""
    return f"{org.lower()}/{repo.lower()}"


def org_key(org: str) -> str:
    return f"org:{org.lower()}"


def repo_key(r: RepoBoundary) -> str:
    return f"repo:{repo_key_of(r.org, r.repo)}"


def folder_key(folder_id: str) -> str:
    return f"folder:{folder_id}"


def drive_key(d: DriveBoundary) -> str:
    return f"drive:{d.domain}/{d.shared_drive}"


def item_keys(doc: TeamBoundaries) -> list[str]:
    """The key of every item of a stored document (stored normalised): whole orgs, then
    repositories, Drive folders and legacy drives, each in document order."""
    return [
        *(org_key(o) for o in doc.github_orgs),
        *(repo_key(r) for r in doc.github_repos),
        *(folder_key(f.folder_id) for f in doc.drive_folders),
        *(drive_key(d) for d in doc.drives),
    ]


def known_item_keys(doc: TeamBoundaries | None, keys: Iterable[str]) -> list[str]:
    """PICKERS-SPEC §3.3-§3.4: of reported keys, those that are keys of items of ``doc`` (None:
    no item), in the order given, each once. The relay keeps only these, on write and again on
    read, so nothing but the team's own item names is ever stored or shown."""
    known = set(item_keys(doc)) if doc is not None else set()
    out: list[str] = []
    for key in keys:
        if key in known:
            known.discard(key)
            out.append(key)
    return out


def key_ok(key: Any) -> bool:
    """PICKERS-SPEC §3.3: 1-400 characters with no control or format character."""
    return (
        isinstance(key, str)
        and 1 <= len(key) <= MAX_ITEM_KEY
        and not any(unicodedata.category(ch) in KEY_FORBIDDEN_CATEGORIES for ch in key)
    )


# M10-SPEC §7.1, PICKERS-SPEC §2.3: since ------------------------------------------------------


@dataclass(frozen=True)
class Since:
    """The version in which each item of a boundaries version was last added: orgs by
    lower-case name, repositories by lower-case ``org/repo``, folders by folder id, legacy
    drives by domain and name; member folders while allowed (None while not)."""

    orgs: dict[str, int]
    drives: dict[DriveBoundary, int]
    member_folders: int | None
    repos: dict[str, int]
    folders: dict[str, int]


def _held(current: TeamBoundaries) -> dict[str, int]:
    """Each item key of ``current`` and its ``since`` (an item its maps lack: its version)."""
    held: dict[str, int] = {}
    for o in current.github_orgs:
        held[org_key(o)] = current.org_since.get(o.lower(), current.version)
    for r in current.github_repos:
        held[repo_key(r)] = current.repo_since.get(repo_key_of(r.org, r.repo), current.version)
    for f in current.drive_folders:
        held[folder_key(f.folder_id)] = current.folder_since.get(f.folder_id, current.version)
    for d in current.drives:
        held[drive_key(d)] = current.drive_since.get(d, current.version)
    return held


def carried_since(current: TeamBoundaries | None, version: int, new: Boundaries) -> Since:
    """When each item of ``new`` (to be stored as ``version``) was last added, given the stored
    ``current`` (PICKERS-SPEC §2.3), each item in order:

    1. its ``since`` in ``current`` when ``current`` holds the same item (same key);
    2. else, for a repository whose org is a whole-org entry of ``current``: that org's;
    3. else, for a folder with a ``drive_id`` when ``current`` holds that whole drive (an entry
       whose ``folder_id`` and ``drive_id`` are this ``drive_id``): that entry's;
    4. else ``version`` (new, or added back after a removal).

    Rules 2 and 3 never apply to legacy drives. Member folders keep theirs while allowed;
    None while not. Computed inside the writing transaction, from the version it replaces."""
    held = _held(current) if current is not None else {}
    whole_drives = (
        {f.folder_id for f in current.drive_folders if f.drive_id == f.folder_id}
        if current is not None
        else set()
    )
    orgs = {o.lower(): held.get(org_key(o), version) for o in new.github_orgs}
    repos: dict[str, int] = {}
    for r in new.github_repos:
        kept = held.get(repo_key(r))
        if kept is None:
            kept = held.get(org_key(r.org))
        repos[repo_key_of(r.org, r.repo)] = kept if kept is not None else version
    folders: dict[str, int] = {}
    for f in new.drive_folders:
        kept = held.get(folder_key(f.folder_id))
        if kept is None and f.drive_id is not None and f.drive_id in whole_drives:
            kept = held.get(folder_key(f.drive_id))
        folders[f.folder_id] = kept if kept is not None else version
    drives = {d: held.get(drive_key(d), version) for d in new.drives}
    member_folders: int | None = None
    if new.member_folders:
        kept = (
            current.member_folders_since if current is not None and current.member_folders else None
        )
        member_folders = kept if kept is not None else version
    return Since(
        orgs=orgs, drives=drives, member_folders=member_folders, repos=repos, folders=folders
    )


# What the relay hands out ---------------------------------------------------------------------


def visible(
    doc: TeamBoundaries,
    allowed_domains: frozenset[str] = frozenset(),
    allowed_orgs: frozenset[str] = frozenset(),
    allowed_drives: frozenset[str] = frozenset(),
) -> TeamBoundaries:
    """``doc`` without the stored entries outside the relay's allowlists (each empty: any), so
    no member is ever handed (or reports) a source of another domain, org or shared drive
    (M10-SPEC §7.2, PICKERS-SPEC §2.1). A pasted folder (no drive id) counts as the drive its
    own id names. The ``since`` maps are kept whole (only listed items are read from them)."""
    return replace(
        doc,
        github_orgs=[o for o in doc.github_orgs if not allowed_orgs or o.lower() in allowed_orgs],
        github_repos=[
            r for r in doc.github_repos if not allowed_orgs or r.org.lower() in allowed_orgs
        ],
        drive_folders=[
            f
            for f in doc.drive_folders
            if (not allowed_domains or f.domain in allowed_domains)
            and (
                not allowed_drives
                or (f.drive_id if f.drive_id is not None else f.folder_id) in allowed_drives
            )
        ],
        drives=[d for d in doc.drives if not allowed_domains or d.domain in allowed_domains],
    )


def boundaries_json(
    team: str,
    doc: TeamBoundaries | None,
    allowed_domains: frozenset[str] = frozenset(),
    allowed_orgs: frozenset[str] = frozenset(),
    allowed_drives: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """``TeamBoundaries`` of ``plugin/src/boundaries-types.ts``; never set: version 0, nulls.
    Entries outside the relay's allowlists are left out (:func:`visible`).

    ``since`` (M10-SPEC §7.1, PICKERS-SPEC §2.3) says in which version each item was last
    added: ``github_orgs`` by lower-case org name, ``github_repos`` by lower-case ``org/repo``,
    ``drive_folders`` by folder id, ``drives`` in the order of ``boundaries.drives``, and
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
    shown = visible(doc, allowed_domains, allowed_orgs, allowed_drives)
    return {
        "team": team,
        "version": doc.version,
        "boundaries": {
            "topic": doc.topic,
            "github_orgs": list(shown.github_orgs),
            "github_repos": [
                {"org": r.org, "repo": r.repo, "id": r.id} for r in shown.github_repos
            ],
            "drive_folders": [
                {
                    "domain": f.domain,
                    "drive_id": f.drive_id,
                    "folder_id": f.folder_id,
                    "folder_name": f.folder_name,
                    "drive_name": f.drive_name,
                }
                for f in shown.drive_folders
            ],
            "drives": [{"domain": d.domain, "shared_drive": d.shared_drive} for d in shown.drives],
            "member_folders": doc.member_folders,
        },
        "since": {
            "github_orgs": {
                o.lower(): doc.org_since.get(o.lower(), doc.version) for o in shown.github_orgs
            },
            "github_repos": {
                repo_key_of(r.org, r.repo): doc.repo_since.get(
                    repo_key_of(r.org, r.repo), doc.version
                )
                for r in shown.github_repos
            },
            "drive_folders": {
                f.folder_id: doc.folder_since.get(f.folder_id, doc.version)
                for f in shown.drive_folders
            },
            "drives": [
                {
                    "domain": d.domain,
                    "shared_drive": d.shared_drive,
                    "since": doc.drive_since.get(d, doc.version),
                }
                for d in shown.drives
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
