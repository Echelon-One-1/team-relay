"""Firestore store (M1-SPEC §6): ``google.cloud.firestore.AsyncClient`` with async
transactions. Inside every transaction all reads happen before any write.

Representation choices:
- Every document that can expire carries ``expire_at`` as a Timestamp (the TTL field).
- JSON blobs whose shape the relay does not control (a manifest, capability params, an
  envelope's ``data``) are stored as canonical JSON strings: Firestore cannot hold
  integers beyond 64 bits or some map keys that JSON allows, and a string round-trips
  exactly, so both stores return identical values.
- Recipient order is kept in a list; Firestore maps do not preserve key order.
- Per-sender quotas are counter documents under ``teams/{team}/counters/{key}`` holding
  ``{count, expire_at}``; the window is part of the key.
- A request's ``updated_at`` (M2-SPEC §3.5) is written only when set, never below the stored
  value plus 1 ms (§7.1, stamped in the writing transaction), and the activity feed
  queries it with one single-field range or equality filter, ordered by it alone; Firestore
  breaks ties by document id (the request id), which is the order MemoryStore uses. The
  automatic single-field index serves every such query, so no composite index is needed.
- The roster (M6-SPEC §1) is ``teams/{team}/roster/{member}``; ``teams/{team}`` holds
  ``roster_version``. Device credentials are ``teams/{team}/credentials/{sha256}``; logins,
  one-time codes and the per-IP login counters are top-level (``logins``, ``login_codes``,
  ``login_limits``), since no team is known yet. A removed member's id is kept in
  ``teams/{team}/retired/{member}`` for a while. Every one of them but the roster carries
  ``expire_at``. The credential queries filter on ``member`` alone (automatic index).
- A request document stays well under Firestore's 1 MiB: a question is at most 8000
  characters, each recipient carries at most a 2000-character answer preview and 50 tool
  events, and a team has at most 50 members.
- Teams (M9-SPEC §1): ``teams/{team}`` also holds the team's record (id, name, status,
  ``seed``, who created it and when, the roster counts, and once deleted when and until when
  its id stays reserved). A document with ``roster_version`` alone predates M9 and reads as
  an active seed team. Team documents never expire. ``accounts/{sha256(email)}`` indexes
  the memberships of the teams the API created and the teams an account created;
  ``credential_teams/{key}`` points a credential at its team (``expire_at`` rolls with the
  credential's); ``admin_audit`` is relay-wide. Team creations count against the relay-wide
  counters in ``login_limits``. The team listing orders by document id alone, so none of
  this needs an index beyond the automatic ones.
- Boundaries (M10-SPEC §1): ``teams/{team}/settings/boundaries``, ``drives`` a list of
  ``{domain, shared_drive, since}`` maps, ``orgs_since`` a map of lower-case org name to the
  version it was last added in, ``member_folders_since`` likewise (M10-SPEC §7.1). Never
  expires; a team's purge removes it with every other document under the team.
"""

from __future__ import annotations

import asyncio
import json
import random
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from google.api_core import exceptions as gexc
from google.cloud import firestore
from google.cloud.firestore_v1.async_transaction import AsyncTransaction
from google.cloud.firestore_v1.base_query import FieldFilter
from google.cloud.firestore_v1.field_path import FieldPath

from .jsonutil import canonical_json
from .store import (
    DELIVERY_SCAN_LIMIT,
    MAX_LIVE_CREDENTIALS,
    MEMBER_ACTIVE,
    MEMBER_INVITED,
    PURGE_BATCH,
    STREAM_SCAN_LIMIT,
    TEAM_ACTIVE,
    TEAM_DELETED,
    AccountRecord,
    AdminAuditEntry,
    AuditEntry,
    BeyondHead,
    BoundariesFn,
    CreateOutcome,
    CredentialRecord,
    DriveBoundary,
    Envelope,
    IdempotencyRecord,
    LoginChoice,
    LoginCode,
    LoginDoc,
    LoginFn,
    MemberDoc,
    MutateFn,
    ProgressEntry,
    Quota,
    QuotaExceeded,
    RecipientState,
    RedeemFn,
    RedeemOutcome,
    RequestDoc,
    RetiredId,
    RosterEntry,
    RosterFn,
    RosterOutcome,
    RosterState,
    StreamPage,
    TeamBoundaries,
    TeamCreateFn,
    TeamDeleteFn,
    TeamGone,
    TeamRecord,
    ToolEvent,
    account_key,
    credentials_over_cap,
    membership_changes,
    monotonic_updated_at,
    revocable_by_email,
    roster_counts,
    stamp_deliveries,
)

_TXN_ATTEMPTS = 8
_MAX_SCAN_PAGE = 250
# One team listing reads team documents in pages of this many (seed teams are skipped).
_TEAM_PAGE = 200


def _dt(value: Any) -> datetime | None:
    """Firestore returns DatetimeWithNanoseconds; hand back a plain aware datetime."""
    if value is None:
        return None
    value = value.astimezone(UTC)
    return datetime(
        value.year,
        value.month,
        value.day,
        value.hour,
        value.minute,
        value.second,
        value.microsecond,
        tzinfo=UTC,
    )


def _int_field(snap: Any, name: str) -> int:
    if not snap.exists:
        return 0
    return int((snap.to_dict() or {}).get(name) or 0)


def _seq_id(seq: int, width: int) -> str:
    return str(seq).zfill(width)


# Encoding ------------------------------------------------------------------------------


def _envelope_to_doc(env: Envelope) -> dict[str, Any]:
    return {
        "id": env.id,
        "seq": env.seq,
        "team": env.team,
        "stream": env.stream,
        "type": env.type,
        "from": env.sender,
        "to": env.to,
        "request_id": env.request_id,
        "broadcast": env.broadcast,
        "time": env.time,
        "expire_at": env.expire_at,
        "data_json": canonical_json(env.data),
    }


def _envelope_from_doc(doc: dict[str, Any]) -> Envelope:
    return Envelope(
        id=doc["id"],
        seq=doc["seq"],
        team=doc["team"],
        stream=doc["stream"],
        type=doc["type"],
        sender=doc["from"],
        to=doc["to"],
        request_id=doc["request_id"],
        broadcast=doc["broadcast"],
        time=_dt(doc["time"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        data=json.loads(doc["data_json"]),
    )


def _request_to_doc(req: RequestDoc) -> dict[str, Any]:
    capability = None
    if req.capability is not None:
        capability = {
            "name": req.capability["name"],
            "environment": req.capability["environment"],
            "params_json": canonical_json(req.capability["params"]),
        }
    doc: dict[str, Any] = {
        "request_id": req.request_id,
        "team": req.team,
        "kind": req.kind,
        "asker": req.asker,
        "broadcast": req.broadcast,
        "question": req.question,
        "capability": capability,
        "created_at": req.created_at,
        "ack_deadline": req.ack_deadline,
        "answer_deadline": req.answer_deadline,
        "expire_at": req.expire_at,
        "next_deadline": req.next_deadline,
        "recipient_order": list(req.recipients),
        "recipients": {
            m: {
                "status": r.status,
                "acked_at": r.acked_at,
                "answered_at": r.answered_at,
                "reply_key": r.reply_key,
                "reply_message_id": r.reply_message_id,
                "progress_count": r.progress_count,
                "delivered_at": r.delivered_at,
                "answer_delivered_at": r.answer_delivered_at,
                "tools": [
                    {
                        "tool": t.tool,
                        "status": t.status,
                        "at": t.at,
                        "duration_ms": t.duration_ms,
                    }
                    for t in r.tools
                ],
                "last_progress_pct": r.last_progress_pct,
                "answer_preview": r.answer_preview,
            }
            for m, r in req.recipients.items()
        },
        "progress_head": req.progress_head,
    }
    if req.updated_at is not None:
        doc["updated_at"] = req.updated_at
    return doc


def _request_from_doc(doc: dict[str, Any]) -> RequestDoc:
    capability = None
    if doc.get("capability") is not None:
        cap = doc["capability"]
        capability = {
            "name": cap["name"],
            "params": json.loads(cap["params_json"]),
            "environment": cap["environment"],
        }
    recipients = {}
    for member in doc["recipient_order"]:
        r = doc["recipients"][member]
        recipients[member] = RecipientState(
            status=r["status"],
            acked_at=_dt(r.get("acked_at")),
            answered_at=_dt(r.get("answered_at")),
            reply_key=r.get("reply_key"),
            reply_message_id=r.get("reply_message_id"),
            progress_count=r.get("progress_count", 0),
            delivered_at=_dt(r.get("delivered_at")),
            answer_delivered_at=_dt(r.get("answer_delivered_at")),
            tools=[
                ToolEvent(
                    tool=t["tool"],
                    status=t["status"],
                    at=_dt(t["at"]),  # type: ignore[arg-type]
                    duration_ms=t.get("duration_ms"),
                )
                for t in r.get("tools") or []
            ],
            last_progress_pct=r.get("last_progress_pct"),
            answer_preview=r.get("answer_preview"),
        )
    return RequestDoc(
        request_id=doc["request_id"],
        team=doc["team"],
        kind=doc["kind"],
        asker=doc["asker"],
        broadcast=doc["broadcast"],
        question=doc.get("question"),
        capability=capability,
        created_at=_dt(doc["created_at"]),  # type: ignore[arg-type]
        ack_deadline=_dt(doc["ack_deadline"]),  # type: ignore[arg-type]
        answer_deadline=_dt(doc["answer_deadline"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        next_deadline=_dt(doc.get("next_deadline")),
        recipients=recipients,
        progress_head=doc.get("progress_head", 0),
        updated_at=_dt(doc.get("updated_at")),
    )


def _progress_to_doc(entry: ProgressEntry) -> dict[str, Any]:
    return {
        "seq": entry.seq,
        "member": entry.member,
        "kind": entry.kind,
        "text": entry.text,
        "pct": entry.pct,
        "tool": entry.tool,
        "status": entry.status,
        "duration_ms": entry.duration_ms,
        "time": entry.time,
        "expire_at": entry.expire_at,
    }


def _progress_from_doc(doc: dict[str, Any]) -> ProgressEntry:
    return ProgressEntry(
        seq=doc["seq"],
        member=doc["member"],
        kind=doc.get("kind") or "progress",  # entries written before M2 are progress
        text=doc.get("text"),
        pct=doc.get("pct"),
        tool=doc.get("tool"),
        status=doc.get("status"),
        duration_ms=doc.get("duration_ms"),
        time=_dt(doc["time"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
    )


def _idem_to_doc(rec: IdempotencyRecord) -> dict[str, Any]:
    return {
        "request_id": rec.request_id,
        "body_hash": rec.body_hash,
        "recipients": list(rec.recipients),
        "ack_deadline": rec.ack_deadline,
        "answer_deadline": rec.answer_deadline,
        "expire_at": rec.expire_at,
    }


def _idem_from_doc(doc: dict[str, Any]) -> IdempotencyRecord:
    return IdempotencyRecord(
        request_id=doc["request_id"],
        body_hash=doc["body_hash"],
        recipients=list(doc["recipients"]),
        ack_deadline=_dt(doc["ack_deadline"]),  # type: ignore[arg-type]
        answer_deadline=_dt(doc["answer_deadline"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
    )


def _audit_to_doc(entry: AuditEntry) -> dict[str, Any]:
    doc = {
        "time": entry.time,
        "team": entry.team,
        "actor": entry.actor,
        "action": entry.action,
        "outcome": entry.outcome,
        "request_id": entry.request_id,
        "message_id": entry.message_id,
        "envelope_type": entry.envelope_type,
        "to": list(entry.to),
        "content_sha256": entry.content_sha256,
        "content_length": entry.content_length,
        "detail": entry.detail,
        "expire_at": entry.expire_at,
    }
    if entry.member is not None:
        doc["member"] = entry.member
    if entry.email_sha256:
        doc["email_sha256"] = list(entry.email_sha256)
    return doc


def _audit_from_doc(doc: dict[str, Any]) -> AuditEntry:
    return AuditEntry(
        time=_dt(doc["time"]),  # type: ignore[arg-type]
        team=doc["team"],
        actor=doc["actor"],
        action=doc["action"],
        outcome=doc["outcome"],
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        request_id=doc.get("request_id"),
        message_id=doc.get("message_id"),
        envelope_type=doc.get("envelope_type"),
        to=list(doc.get("to") or []),
        content_sha256=doc.get("content_sha256"),
        content_length=doc.get("content_length"),
        detail=doc.get("detail"),
        member=doc.get("member"),
        email_sha256=list(doc.get("email_sha256") or []),
    )


def _roster_to_doc(entry: RosterEntry) -> dict[str, Any]:
    return {
        "member": entry.member,
        "emails": list(entry.emails),
        "role": entry.role,
        "added_by": entry.added_by,
        "added_at": entry.added_at,
        "updated_at": entry.updated_at,
        # A list, not a map: an email is not a safe Firestore field name.
        "subs": [{"email": e, "sub": entry.subs[e]} for e in sorted(entry.subs)],
        "status": entry.status,
    }


def _roster_from_doc(doc: dict[str, Any]) -> RosterEntry:
    return RosterEntry(
        member=doc["member"],
        emails=list(doc.get("emails") or []),
        role=doc["role"],
        added_by=doc["added_by"],
        added_at=_dt(doc["added_at"]),  # type: ignore[arg-type]
        updated_at=_dt(doc["updated_at"]),  # type: ignore[arg-type]
        subs={b["email"]: b["sub"] for b in doc.get("subs") or []},
        # M9-SPEC §7.2: no status is an entry from before invitations: active. Anything but
        # "active" grants nothing.
        status=MEMBER_ACTIVE if doc.get("status") in (None, MEMBER_ACTIVE) else MEMBER_INVITED,
    )


def _retired_to_doc(tomb: RetiredId) -> dict[str, Any]:
    return {
        "member": tomb.member,
        "email_sha256": list(tomb.email_sha256),
        "retired_at": tomb.retired_at,
        "expire_at": tomb.expire_at,
    }


def _retired_from_doc(doc: dict[str, Any]) -> RetiredId:
    return RetiredId(
        member=doc["member"],
        email_sha256=list(doc.get("email_sha256") or []),
        retired_at=_dt(doc["retired_at"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
    )


def _credential_to_doc(record: CredentialRecord) -> dict[str, Any]:
    return {
        "team": record.team,
        "member": record.member,
        "device": record.device,
        "created_at": record.created_at,
        "last_used_at": record.last_used_at,
        "expire_at": record.expire_at,
        "revoked": record.revoked,
        "revoked_at": record.revoked_at,
        "email_sha256": record.email_sha256,
    }


def _credential_from_doc(key: str, doc: dict[str, Any]) -> CredentialRecord:
    return CredentialRecord(
        key=key,
        team=doc["team"],
        member=doc["member"],
        device=doc["device"],
        created_at=_dt(doc["created_at"]),  # type: ignore[arg-type]
        last_used_at=_dt(doc["last_used_at"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        revoked=bool(doc.get("revoked")),
        revoked_at=_dt(doc.get("revoked_at")),
        email_sha256=doc.get("email_sha256"),
    )


def _login_to_doc(login: LoginDoc) -> dict[str, Any]:
    return {
        "port": login.port,
        "state": login.state,
        "challenge": login.challenge,
        "device": login.device,
        "step": login.step,
        "nonce": login.nonce,
        "google_verifier": login.google_verifier,
        "created_at": login.created_at,
        "expire_at": login.expire_at,
        "csrf_sha256": login.csrf_sha256,
        "email": login.email,
        "choices": [{"team": c.team, "member": c.member} for c in login.choices],
        "sub": login.sub,
    }


def _login_from_doc(key: str, doc: dict[str, Any]) -> LoginDoc:
    return LoginDoc(
        key=key,
        port=doc["port"],
        state=doc["state"],
        challenge=doc["challenge"],
        device=doc["device"],
        step=doc["step"],
        nonce=doc["nonce"],
        google_verifier=doc["google_verifier"],
        created_at=_dt(doc["created_at"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        csrf_sha256=doc.get("csrf_sha256"),
        email=doc.get("email"),
        choices=[LoginChoice(team=c["team"], member=c["member"]) for c in doc.get("choices") or []],
        sub=doc.get("sub"),
    )


def _code_to_doc(code: LoginCode) -> dict[str, Any]:
    return {
        "login_key": code.login_key,
        "team": code.team,
        "member": code.member,
        "device": code.device,
        "challenge": code.challenge,
        "created_at": code.created_at,
        "expire_at": code.expire_at,
        "used": code.used,
        "credential_key": code.credential_key,
        "email": code.email,
    }


def _code_from_doc(key: str, doc: dict[str, Any]) -> LoginCode:
    return LoginCode(
        key=key,
        login_key=doc["login_key"],
        team=doc["team"],
        member=doc["member"],
        device=doc["device"],
        challenge=doc["challenge"],
        created_at=_dt(doc["created_at"]),  # type: ignore[arg-type]
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        used=bool(doc.get("used")),
        credential_key=doc.get("credential_key"),
        email=doc.get("email"),
    )


def _team_to_doc(record: TeamRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "name": record.name,
        "status": record.status,
        "seed": record.seed,
        "created_at": record.created_at,
        "created_by_member": record.created_by_member,
        "created_by_email_sha256": record.created_by_email_sha256,
        "created_by_sub_sha256": record.created_by_sub_sha256,
        "roster_version": record.roster_version,
        "members": record.members,
        "owners": record.owners,
        "deleted_at": record.deleted_at,
        "deleted_by_email_sha256": record.deleted_by_email_sha256,
        "reserved_until": record.reserved_until,
        "purge_complete": record.purge_complete,
    }


def _team_from_doc(team: str, doc: dict[str, Any]) -> TeamRecord:
    # A document written before M9 holds roster_version alone: an active seed team.
    return TeamRecord(
        id=team,
        name=doc.get("name") or team,
        status=doc.get("status") or TEAM_ACTIVE,
        seed=doc.get("seed", True) is not False,
        created_at=_dt(doc.get("created_at")),
        created_by_member=doc.get("created_by_member"),
        created_by_email_sha256=doc.get("created_by_email_sha256"),
        created_by_sub_sha256=doc.get("created_by_sub_sha256"),
        roster_version=int(doc.get("roster_version") or 0),
        members=doc.get("members"),
        owners=doc.get("owners"),
        deleted_at=_dt(doc.get("deleted_at")),
        deleted_by_email_sha256=doc.get("deleted_by_email_sha256"),
        reserved_until=_dt(doc.get("reserved_until")),
        purge_complete=bool(doc.get("purge_complete")),
    )


def _account_to_doc(record: AccountRecord) -> dict[str, Any]:
    return {
        # Lists, not maps: the documents stay free of field-name escaping.
        "memberships": [
            {"team": team, "member": record.memberships[team]}
            for team in sorted(record.memberships)
        ],
        "created": list(record.created),
    }


def _account_from_doc(key: str, doc: dict[str, Any]) -> AccountRecord:
    return AccountRecord(
        key=key,
        memberships={m["team"]: m["member"] for m in doc.get("memberships") or []},
        created=list(doc.get("created") or []),
    )


def _admin_audit_to_doc(entry: AdminAuditEntry) -> dict[str, Any]:
    return {
        "time": entry.time,
        "actor_email_sha256": entry.actor_email_sha256,
        "action": entry.action,
        "team": entry.team,
        "outcome": entry.outcome,
        "detail": entry.detail,
        "via": entry.via,
        "expire_at": entry.expire_at,
    }


def _admin_audit_from_doc(doc: dict[str, Any]) -> AdminAuditEntry:
    return AdminAuditEntry(
        time=_dt(doc["time"]),  # type: ignore[arg-type]
        actor_email_sha256=doc["actor_email_sha256"],
        action=doc["action"],
        team=doc["team"],
        outcome=doc["outcome"],
        detail=doc.get("detail"),
        expire_at=_dt(doc["expire_at"]),  # type: ignore[arg-type]
        via=doc.get("via") or "direct",
    )


def _boundaries_to_doc(doc: TeamBoundaries) -> dict[str, Any]:
    return {
        "version": doc.version,
        "topic": doc.topic,
        "github_orgs": list(doc.github_orgs),
        "orgs_since": {o.lower(): doc.org_since[o.lower()] for o in doc.github_orgs},
        "drives": [
            {"domain": d.domain, "shared_drive": d.shared_drive, "since": doc.drive_since[d]}
            for d in doc.drives
        ],
        "member_folders": doc.member_folders,
        "member_folders_since": doc.member_folders_since if doc.member_folders else None,
        "updated_at": doc.updated_at,
        "updated_by": doc.updated_by,
    }


def _boundaries_from_doc(doc: dict[str, Any]) -> TeamBoundaries:
    # M10-SPEC §7.1: a document saved before ``since`` was recorded counts each item as added
    # in its own version, so a member's acceptance of an earlier version does not cover it.
    version = int(doc["version"])
    orgs = list(doc.get("github_orgs") or [])
    kept = doc.get("orgs_since") or {}
    drives = [
        (DriveBoundary(domain=d["domain"], shared_drive=d["shared_drive"]), d.get("since"))
        for d in doc.get("drives") or []
    ]
    member_folders = bool(doc["member_folders"])
    folders_since = doc.get("member_folders_since")
    return TeamBoundaries(
        version=version,
        topic=doc["topic"],
        github_orgs=orgs,
        drives=[d for d, _ in drives],
        member_folders=member_folders,
        updated_at=_dt(doc["updated_at"]),  # type: ignore[arg-type]
        updated_by=doc["updated_by"],
        org_since={o.lower(): int(kept[o.lower()]) if o.lower() in kept else version for o in orgs},
        drive_since={d: int(n) if n is not None else version for d, n in drives},
        member_folders_since=(
            (int(folders_since) if folders_since is not None else version)
            if member_folders
            else None
        ),
    )


class FirestoreStore:
    def __init__(
        self,
        project: str | None = None,
        database: str | None = None,
        client: firestore.AsyncClient | None = None,
    ) -> None:
        self._project = project
        self._database = database
        self._client = client

    # The client is created on first use, inside the running event loop (grpc.aio binds
    # to the loop that creates its channel).
    def _db(self) -> firestore.AsyncClient:
        if self._client is None:
            self._client = firestore.AsyncClient(project=self._project, database=self._database)
        return self._client

    async def aclose(self) -> None:
        client, self._client = self._client, None
        api = getattr(client, "_firestore_api_internal", None) if client else None
        if api is not None:
            await api.transport.close()

    # Paths --------------------------------------------------------------------------------
    def _team(self, team: str):
        return self._db().collection("teams").document(team)

    def _member(self, team: str, member: str):
        return self._team(team).collection("members").document(member)

    def _stream(self, team: str, member: str, stream: str):
        return self._member(team, member).collection("streams").document(stream)

    def _request(self, team: str, request_id: str):
        return self._team(team).collection("requests").document(request_id)

    def _idem(self, team: str, key_id: str):
        return self._team(team).collection("idempotency").document(key_id)

    def _audit_col(self, team: str):
        return self._team(team).collection("audit")

    def _counter(self, team: str, key: str):
        return self._team(team).collection("counters").document(key)

    def _roster_col(self, team: str):
        return self._team(team).collection("roster")

    def _retired_col(self, team: str):
        return self._team(team).collection("retired")

    def _boundaries(self, team: str):
        return self._team(team).collection("settings").document("boundaries")

    def _credential(self, team: str, key: str):
        return self._team(team).collection("credentials").document(key)

    def _login(self, key: str):
        return self._db().collection("logins").document(key)

    def _code(self, key: str):
        return self._db().collection("login_codes").document(key)

    def _login_counter(self, key: str):
        return self._db().collection("login_limits").document(key)

    def _account(self, key: str):
        return self._db().collection("accounts").document(key)

    def _pointer(self, key: str):
        return self._db().collection("credential_teams").document(key)

    def _admin_audit_col(self):
        return self._db().collection("admin_audit")

    async def _read_accounts(
        self, txn: AsyncTransaction, keys: Sequence[str]
    ) -> dict[str, AccountRecord | None]:
        """The account documents ``keys`` (None for a missing one), read in ``txn``."""
        keys = list(dict.fromkeys(keys))
        found: dict[str, AccountRecord | None] = {key: None for key in keys}
        if keys:
            refs = [self._account(key) for key in keys]
            async for snap in self._db().get_all(refs, transaction=txn):
                if snap.exists:
                    found[snap.id] = _account_from_doc(snap.id, snap.to_dict() or {})
        return found

    def _write_account(self, txn: AsyncTransaction, record: AccountRecord) -> None:
        if record.memberships or record.created:
            txn.set(self._account(record.key), _account_to_doc(record))
        else:
            txn.delete(self._account(record.key))

    # Transactions -------------------------------------------------------------------------
    async def _run[T](self, body: Callable[[AsyncTransaction], Awaitable[T]]) -> T:
        """Run ``body`` in a transaction, retrying contention (Aborted) from reads as well
        as from the commit. Anything else, including an ApiError from a mutation
        function, rolls back and propagates."""
        wrapped = firestore.async_transactional(body)
        for attempt in range(_TXN_ATTEMPTS):
            txn = self._db().transaction(max_attempts=1)
            try:
                return await wrapped(txn)
            except (gexc.Aborted, ValueError) as exc:
                aborted = isinstance(exc, gexc.Aborted) or isinstance(exc.__cause__, gexc.Aborted)
                if not aborted or attempt == _TXN_ATTEMPTS - 1:
                    raise
                await asyncio.sleep(random.uniform(0.01, 0.05) * (2**attempt))
        raise RuntimeError("unreachable")

    async def _write_envelopes(self, txn: AsyncTransaction, envelopes: Sequence[Envelope]) -> None:
        """Assign seqs and stage the writes. Reads every target stream head first."""
        targets: dict[tuple[str, str, str], Any] = {}
        for env in envelopes:
            key = (env.team, env.to, env.stream)
            if key not in targets:
                targets[key] = self._stream(*key)
        heads: dict[tuple[str, str, str], tuple[int, bool]] = {}
        for key, ref in targets.items():
            snap = await ref.get(transaction=txn)
            heads[key] = (_int_field(snap, "head"), snap.exists)
        # All reads are done; writes from here on.
        next_seq = {key: head for key, (head, _) in heads.items()}
        for env in envelopes:
            key = (env.team, env.to, env.stream)
            next_seq[key] += 1
            env.seq = next_seq[key]
            msg_ref = targets[key].collection("messages").document(_seq_id(env.seq, 12))
            txn.create(msg_ref, _envelope_to_doc(env))
        for key, head in next_seq.items():
            if heads[key][1]:
                txn.update(targets[key], {"head": head})
            else:
                txn.set(targets[key], {"head": head, "cursor": 0})

    def _write_audit(self, txn: AsyncTransaction, entries: Sequence[AuditEntry]) -> None:
        for entry in entries:
            txn.set(self._audit_col(entry.team).document(), _audit_to_doc(entry))

    async def _read_quotas(
        self, txn: AsyncTransaction, team: str, quotas: Sequence[Quota]
    ) -> list[int]:
        """Read every quota's count (a read: call before any write) and refuse when one is
        at its limit."""
        counts = []
        for quota in quotas:
            snap = await self._counter(team, quota.key).get(transaction=txn)
            count = _int_field(snap, "count")
            if count >= quota.limit:
                raise QuotaExceeded(quota)
            counts.append(count)
        return counts

    def _write_quotas(
        self, txn: AsyncTransaction, team: str, quotas: Sequence[Quota], counts: Sequence[int]
    ) -> None:
        for quota, count in zip(quotas, counts, strict=True):
            txn.set(
                self._counter(team, quota.key),
                {"count": count + 1, "expire_at": quota.expire_at},
            )

    # Members ------------------------------------------------------------------------------
    async def get_members(self, team: str, members: Sequence[str]) -> dict[str, MemberDoc]:
        if not members:
            return {}
        refs = [self._member(team, m) for m in members]
        out: dict[str, MemberDoc] = {}
        async for snap in self._db().get_all(refs):
            if not snap.exists:
                continue
            doc = snap.to_dict() or {}
            manifest_json = doc.get("manifest_json")
            presence = {
                stream: _dt(entry.get("last_seen"))
                for stream, entry in (doc.get("presence") or {}).items()
                if isinstance(entry, dict) and entry.get("last_seen") is not None
            }
            out[snap.id] = MemberDoc(
                manifest=json.loads(manifest_json) if manifest_json else None,
                published_at=_dt(doc.get("published_at")),
                last_seen=_dt(doc.get("last_seen")),
                presence=presence,  # type: ignore[arg-type]
            )
        return {m: out[m] for m in members if m in out}

    async def put_manifest(
        self,
        team: str,
        member: str,
        manifest: dict[str, Any],
        published_at: datetime,
        audit: Sequence[AuditEntry],
    ) -> None:
        async def body(txn: AsyncTransaction) -> None:
            txn.set(
                self._member(team, member),
                {"manifest_json": canonical_json(manifest), "published_at": published_at},
                merge=True,
            )
            self._write_audit(txn, audit)

        await self._run(body)

    async def touch_presence(
        self, team: str, member: str, stream: str, now: datetime, min_interval: timedelta
    ) -> None:
        ref = self._member(team, member)
        snap = await ref.get(field_paths=[f"presence.{stream}.last_seen", "last_seen"])
        doc = (snap.to_dict() or {}) if snap.exists else {}
        entry = (doc.get("presence") or {}).get(stream) or {}
        last = _dt(entry.get("last_seen")) if isinstance(entry, dict) else None
        if last is None or now - last >= min_interval:
            seen = _dt(doc.get("last_seen"))
            # Unconditional merge (it merges nested maps field by field, so the other
            # stream's presence stays): two racing polls both write, which is harmless.
            await ref.set(
                {
                    "presence": {stream: {"last_seen": now}},
                    "last_seen": now if seen is None or now > seen else seen,
                },
                merge=True,
            )

    # Requests -----------------------------------------------------------------------------
    async def get_idempotency(
        self, team: str, key_id: str, now: datetime
    ) -> IdempotencyRecord | None:
        snap = await self._idem(team, key_id).get()
        if not snap.exists:
            return None
        record = _idem_from_doc(snap.to_dict() or {})
        return None if record.expire_at <= now else record

    async def create_request(
        self,
        team: str,
        key_id: str,
        record: IdempotencyRecord,
        request: RequestDoc,
        envelopes: Sequence[Envelope],
        audit: Sequence[AuditEntry],
        now: datetime,
        quotas: Sequence[Quota] = (),
    ) -> CreateOutcome:
        async def body(txn: AsyncTransaction) -> CreateOutcome:
            idem_ref = self._idem(team, key_id)
            snap = await idem_ref.get(transaction=txn)
            if snap.exists:
                existing = _idem_from_doc(snap.to_dict() or {})
                if existing.expire_at > now:
                    return CreateOutcome(created=False, record=existing)
            counts = await self._read_quotas(txn, team, quotas)  # raising writes nothing
            # Envelope seqs are assigned on copies so a retried attempt starts clean.
            staged = [Envelope(**{**env.__dict__, "seq": 0}) for env in envelopes]
            await self._write_envelopes(txn, staged)  # reads heads, then stages writes
            self._write_quotas(txn, team, quotas, counts)
            txn.set(idem_ref, _idem_to_doc(record))
            txn.create(self._request(team, request.request_id), _request_to_doc(request))
            self._write_audit(txn, audit)
            return CreateOutcome(created=True, record=record)

        return await self._run(body)

    async def get_request(self, team: str, request_id: str) -> RequestDoc | None:
        snap = await self._request(team, request_id).get()
        if not snap.exists:
            return None
        return _request_from_doc(snap.to_dict() or {})

    async def list_progress(self, team: str, request_id: str) -> list[ProgressEntry]:
        query = self._request(team, request_id).collection("progress").order_by("seq")
        return [_progress_from_doc(snap.to_dict() or {}) async for snap in query.stream()]

    async def mutate_request[T](self, team: str, request_id: str, fn: MutateFn[T]) -> T:
        async def body(txn: AsyncTransaction) -> T:
            ref = self._request(team, request_id)
            snap = await ref.get(transaction=txn)
            current = _request_from_doc(snap.to_dict() or {}) if snap.exists else None
            previous = current.updated_at if current is not None else None
            mutation = fn(current)
            staged = [Envelope(**{**env.__dict__, "seq": 0}) for env in mutation.envelopes]
            await self._write_envelopes(txn, staged)  # the last reads; writes follow
            if mutation.request is not None:
                if mutation.request.request_id != request_id:
                    raise RuntimeError("a mutation may only write its own request")
                # M2-SPEC §7.1, on the value this attempt read: a retry after another
                # writer committed reads that writer's value and stamps past it.
                mutation.request.updated_at = monotonic_updated_at(
                    mutation.request.updated_at, previous
                )
                txn.set(ref, _request_to_doc(mutation.request))
            for entry in mutation.progress:
                txn.create(
                    ref.collection("progress").document(_seq_id(entry.seq, 6)),
                    _progress_to_doc(entry),
                )
            self._write_audit(txn, mutation.audit)
            return mutation.result

        return await self._run(body)

    async def due_requests(self, team: str, asker: str, now: datetime, limit: int) -> list[str]:
        query = (
            self._team(team)
            .collection("requests")
            .where(filter=FieldFilter("asker", "==", asker))
            .where(filter=FieldFilter("next_deadline", "<=", now))
            .order_by("next_deadline")
            .limit(limit)
            .select(["next_deadline"])
        )
        return [snap.id async for snap in query.stream()]

    async def requests_updated_after(
        self, team: str, since: datetime, limit: int, *, descending: bool = False
    ) -> list[RequestDoc]:
        direction = firestore.Query.DESCENDING if descending else firestore.Query.ASCENDING
        query = (
            self._team(team)
            .collection("requests")
            .where(filter=FieldFilter("updated_at", ">", since))
            .order_by("updated_at", direction=direction)
            .limit(limit)
        )
        return [_request_from_doc(snap.to_dict() or {}) async for snap in query.stream()]

    async def requests_updated_at(self, team: str, at: datetime, limit: int) -> list[RequestDoc]:
        query = (
            self._team(team)
            .collection("requests")
            .where(filter=FieldFilter("updated_at", "==", at))
            .limit(limit)
        )
        docs = [_request_from_doc(snap.to_dict() or {}) async for snap in query.stream()]
        return sorted(docs, key=lambda d: d.request_id)

    # Streams ------------------------------------------------------------------------------
    async def read_stream(
        self,
        team: str,
        member: str,
        stream: str,
        after: int | None,
        limit: int,
        now: datetime,
        *,
        advance: bool = True,
    ) -> StreamPage:
        ref = self._stream(team, member, stream)
        snap = await ref.get()
        head = _int_field(snap, "head")
        cursor = _int_field(snap, "cursor")
        out: list[Envelope] = []
        start = cursor if after is None else after
        position = start
        expired_through = start  # the end of the expired run right after ``start``
        scanned = 0
        page = limit
        # Only up to the head read above, so the returned head is never below a returned seq.
        while len(out) < limit and position < head and scanned < STREAM_SCAN_LIMIT:
            page = min(page, STREAM_SCAN_LIMIT - scanned)
            query = (
                ref.collection("messages")
                .where(filter=FieldFilter("seq", ">", position))
                .where(filter=FieldFilter("seq", "<=", head))
                .order_by("seq")
                .limit(page)
            )
            batch = [snap.to_dict() or {} async for snap in query.stream()]
            if not batch:
                break
            for doc in batch:
                scanned += 1
                position = doc["seq"]
                if _dt(doc["expire_at"]) > now:  # type: ignore[operator]
                    if len(out) < limit:
                        out.append(_envelope_from_doc(doc))
                elif not out:
                    expired_through = position
            if len(batch) < page:
                break
            # Past a full page of expired envelopes, read bigger pages: fewer round trips.
            page = min(page * 2, _MAX_SCAN_PAGE)
        if advance and start == cursor and expired_through > cursor:
            cursor = await self._advance_cursor(team, ref, expired_through, now)
        return StreamPage(messages=out, cursor=cursor, head=head)

    async def _advance_cursor(self, team: str, ref: Any, to: int, now: datetime) -> int:
        """Move the cursor to ``to`` unless it is already there or beyond (§11.5), stamping
        the deliveries it passes (M2-SPEC §3.2)."""

        async def body(txn: AsyncTransaction) -> int:
            snap = await ref.get(transaction=txn)
            current = _int_field(snap, "cursor")
            if to > current:
                await self._advance(txn, team, ref, current, to, now)
                return to
            return current

        return await self._run(body)

    async def _advance(
        self, txn: AsyncTransaction, team: str, ref: Any, cursor: int, to: int, now: datetime
    ) -> None:
        """Inside a transaction that has read the stream document: read the first
        DELIVERY_SCAN_LIMIT messages in ``(cursor, to]`` and their requests (the last reads),
        then stage the cursor move and the stamped requests."""
        query = (
            ref.collection("messages")
            .where(filter=FieldFilter("seq", ">", cursor))
            .where(filter=FieldFilter("seq", "<=", to))
            .order_by("seq")
            .limit(DELIVERY_SCAN_LIMIT)
        )
        passed = [
            _envelope_from_doc(snap.to_dict() or {}) async for snap in query.stream(transaction=txn)
        ]
        request_ids = list(dict.fromkeys(env.request_id for env in passed))
        requests: dict[str, RequestDoc] = {}
        if request_ids:
            refs = [self._request(team, rid) for rid in request_ids]
            async for snap in self._db().get_all(refs, transaction=txn):
                if snap.exists:
                    requests[snap.id] = _request_from_doc(snap.to_dict() or {})
        changed = stamp_deliveries(passed, requests, now)
        # All reads are done; writes from here on.
        txn.update(ref, {"cursor": to})
        for doc in changed:
            txn.set(self._request(team, doc.request_id), _request_to_doc(doc))

    async def set_cursor(
        self, team: str, member: str, stream: str, acked_seq: int, now: datetime
    ) -> int:
        async def body(txn: AsyncTransaction) -> int:
            ref = self._stream(team, member, stream)
            snap = await ref.get(transaction=txn)
            head = _int_field(snap, "head")
            cursor = _int_field(snap, "cursor")
            if acked_seq > head:
                raise BeyondHead()
            if acked_seq > cursor:
                await self._advance(txn, team, ref, cursor, acked_seq, now)
                return acked_seq
            return cursor

        return await self._run(body)

    # Audit --------------------------------------------------------------------------------
    async def append_audit(self, entries: Sequence[AuditEntry]) -> None:
        if not entries:
            return
        batch = self._db().batch()
        for entry in entries:
            batch.set(self._audit_col(entry.team).document(), _audit_to_doc(entry))
        await batch.commit()

    async def append_audit_capped(
        self, team: str, entries: Sequence[AuditEntry], quota: Quota
    ) -> bool:
        async def body(txn: AsyncTransaction) -> bool:
            try:
                counts = await self._read_quotas(txn, team, [quota])
            except QuotaExceeded:
                return False
            self._write_quotas(txn, team, [quota], counts)
            self._write_audit(txn, entries)
            return True

        return await self._run(body)

    async def list_audit(self, team: str, limit: int = 1000) -> list[AuditEntry]:
        query = self._audit_col(team).order_by("time").limit(limit)
        return [_audit_from_doc(snap.to_dict() or {}) async for snap in query.stream()]

    async def count_quota(self, team: str, quota: Quota) -> bool:
        async def body(txn: AsyncTransaction) -> bool:
            try:
                counts = await self._read_quotas(txn, team, [quota])
            except QuotaExceeded:
                return False
            self._write_quotas(txn, team, [quota], counts)
            return True

        return await self._run(body)

    # Roster -------------------------------------------------------------------------------
    async def roster_version(self, team: str) -> int:
        snap = await self._team(team).get(field_paths=["roster_version"])
        return _int_field(snap, "roster_version")

    async def _read_roster(
        self, txn: AsyncTransaction, team: str
    ) -> tuple[RosterState, TeamRecord | None]:
        snap = await self._team(team).get(transaction=txn)
        entries = {
            doc.id: _roster_from_doc(doc.to_dict() or {})
            async for doc in self._roster_col(team).stream(transaction=txn)
        }
        retired = {
            doc.id: _retired_from_doc(doc.to_dict() or {})
            async for doc in self._retired_col(team).stream(transaction=txn)
        }
        record = _team_from_doc(team, snap.to_dict() or {}) if snap.exists else None
        state = RosterState(
            version=_int_field(snap, "roster_version"), entries=entries, retired=retired
        )
        return state, record

    async def read_roster(self, team: str) -> RosterState:
        async def body(txn: AsyncTransaction) -> RosterState:
            return (await self._read_roster(txn, team))[0]

        return await self._run(body)

    async def mutate_roster[T](
        self, team: str, fn: RosterFn[T], now: datetime, quotas: Sequence[Quota] = ()
    ) -> RosterOutcome[T]:
        async def body(txn: AsyncTransaction) -> RosterOutcome[T]:
            state, record = await self._read_roster(txn, team)
            if record is not None and record.status == TEAM_DELETED:
                raise TeamGone(team)
            before = dict(state.entries)
            change = fn(state)
            if not change.changed:
                return RosterOutcome(result=change.result, version=state.version, revoked=[])
            counts = await self._read_quotas(txn, team, quotas)  # raising writes nothing
            to_revoke: set[str] = set()
            by_email: dict[str, list[str]] = {}
            for member, email_sha256 in change.revoke_email:
                by_email.setdefault(member, []).append(email_sha256)
            for member in sorted(set(change.remove) | set(by_email)):
                query = (
                    self._team(team)
                    .collection("credentials")
                    .where(filter=FieldFilter("member", "==", member))
                )
                async for snap in query.stream(transaction=txn):
                    cred = _credential_from_doc(snap.id, snap.to_dict() or {})
                    if not cred.live(now):
                        continue
                    if member in change.remove or any(
                        revocable_by_email(cred, member, h) for h in by_email.get(member, ())
                    ):
                        to_revoke.add(cred.key)
            # M9-SPEC §1: the account index, for a team the API created only.
            moved: dict[str, str | None] = {}
            accounts: dict[str, AccountRecord | None] = {}
            if record is not None and not record.seed:
                moved = membership_changes(before, change.put, change.remove)
                accounts = await self._read_accounts(txn, [account_key(e) for e in moved])
            # All reads are done; writes from here on.
            self._write_quotas(txn, team, quotas, counts)
            for key in sorted(to_revoke):
                txn.update(self._credential(team, key), {"revoked": True, "revoked_at": now})
            for member in change.remove:
                txn.delete(self._roster_col(team).document(member))
            for entry in change.put:
                txn.set(self._roster_col(team).document(entry.member), _roster_to_doc(entry))
            for tomb in change.retire:
                txn.set(self._retired_col(team).document(tomb.member), _retired_to_doc(tomb))
            members, owners = roster_counts(before, change.put, change.remove)
            txn.set(
                self._team(team),
                {"roster_version": state.version + 1, "members": members, "owners": owners},
                merge=True,
            )
            for email, member in moved.items():
                key = account_key(email)
                account = accounts.get(key) or AccountRecord(key=key)
                if member is None:
                    account.memberships.pop(team, None)
                else:
                    account.memberships[team] = member
                self._write_account(txn, account)
            self._write_audit(txn, change.audit)
            return RosterOutcome(
                result=change.result, version=state.version + 1, revoked=sorted(to_revoke)
            )

        return await self._run(body)

    # Teams --------------------------------------------------------------------------------
    async def get_teams(self, teams: Sequence[str]) -> dict[str, TeamRecord]:
        ids = list(dict.fromkeys(teams))
        if not ids:
            return {}
        found: dict[str, TeamRecord] = {}
        async for snap in self._db().get_all([self._team(t) for t in ids]):
            if snap.exists:
                found[snap.id] = _team_from_doc(snap.id, snap.to_dict() or {})
        return {t: found[t] for t in ids if t in found}

    async def list_teams(self, after: str | None, limit: int) -> list[TeamRecord]:
        out: list[TeamRecord] = []
        position = after
        while len(out) < limit:
            query = self._db().collection("teams").order_by(FieldPath.document_id())
            if position is not None:
                query = query.where(
                    filter=FieldFilter(FieldPath.document_id(), ">", self._team(position))
                )
            page = [snap async for snap in query.limit(_TEAM_PAGE).stream()]
            for snap in page:
                position = snap.id
                record = _team_from_doc(snap.id, snap.to_dict() or {})
                if not record.seed:
                    out.append(record)
                    if len(out) >= limit:
                        break
            if len(page) < _TEAM_PAGE:
                break
        return out

    async def ensure_seed_team(self, team: str, name: str, now: datetime) -> TeamRecord:
        async def body(txn: AsyncTransaction) -> TeamRecord:
            snap = await self._team(team).get(transaction=txn)
            doc = (snap.to_dict() or {}) if snap.exists else {}
            record = _team_from_doc(team, doc)
            # M9-SPEC §7.1: a record the API created is never adopted, active or deleted.
            if snap.exists and (record.status == TEAM_DELETED or not record.seed):
                return record
            update: dict[str, Any] = {}
            if doc.get("id") != team:
                update["id"] = team
            if doc.get("status") is None:
                update["status"] = TEAM_ACTIVE
            if doc.get("seed") is not True:
                update["seed"] = True
            if doc.get("created_at") is None:
                update["created_at"] = now
                update["name"] = name
            if doc.get("members") is None or doc.get("owners") is None:
                entries = {
                    e.id: _roster_from_doc(e.to_dict() or {})
                    async for e in self._roster_col(team).stream(transaction=txn)
                }
                update["members"], update["owners"] = roster_counts(entries, [], [])
            if update:
                txn.set(self._team(team), update, merge=True)
            return _team_from_doc(team, {**doc, **update})

        return await self._run(body)

    async def team_has_documents(self, team: str) -> bool:
        snap = await self._team(team).get(field_paths=["roster_version"])
        return snap.exists or bool(await self._descendants(team, 1))

    async def create_team[T](
        self,
        team: str,
        email_sha256: str,
        fn: TeamCreateFn[T],
        quotas: Sequence[Quota] = (),
        sub_key: str | None = None,
    ) -> T:
        async def body(txn: AsyncTransaction) -> T:
            snap = await self._team(team).get(transaction=txn)
            current = _team_from_doc(team, snap.to_dict() or {}) if snap.exists else None
            keys = [email_sha256, *([sub_key] if sub_key else [])]
            creators = await self._read_accounts(txn, keys)
            creator = creators[email_sha256]
            by_sub = creators.get(sub_key) if sub_key else None
            creation = fn(current, creator, by_sub)
            if creation.team is None:
                return creation.result
            if creation.team.id != team:
                raise RuntimeError("a creation may only write its own team")
            owner = creation.owner
            owner_keys = [account_key(e) for e in owner.emails] if owner is not None else []
            others = await self._read_accounts(txn, [k for k in owner_keys if k not in keys])
            counts = []
            for quota in quotas:  # relay-wide counters; raising writes nothing
                qsnap = await self._login_counter(quota.key).get(transaction=txn)
                count = _int_field(qsnap, "count")
                if count >= quota.limit:
                    raise QuotaExceeded(quota)
                counts.append(count)
            # All reads are done; writes from here on.
            for quota, count in zip(quotas, counts, strict=True):
                txn.set(
                    self._login_counter(quota.key),
                    {"count": count + 1, "expire_at": quota.expire_at},
                )
            txn.set(self._team(team), _team_to_doc(creation.team))
            if owner is not None:
                txn.set(self._roster_col(team).document(owner.member), _roster_to_doc(owner))
            accounts = {key: creators[key] or AccountRecord(key=key) for key in keys}
            for key, record in others.items():
                accounts[key] = record or AccountRecord(key=key)
            for key in keys:
                if team not in accounts[key].created:
                    accounts[key].created.append(team)
            if owner is not None:
                for key in owner_keys:
                    accounts[key].memberships[team] = owner.member
            for record in accounts.values():
                self._write_account(txn, record)
            self._write_audit(txn, creation.audit)
            for entry in creation.admin_audit:
                txn.set(self._admin_audit_col().document(), _admin_audit_to_doc(entry))
            return creation.result

        return await self._run(body)

    async def delete_team[T](self, team: str, fn: TeamDeleteFn[T]) -> T:
        async def body(txn: AsyncTransaction) -> T:
            snap = await self._team(team).get(transaction=txn)
            current = _team_from_doc(team, snap.to_dict() or {}) if snap.exists else None
            keys = (
                [k for k in (current.created_by_email_sha256, current.created_by_sub_sha256) if k]
                if current is not None
                else []
            )
            creators = await self._read_accounts(txn, keys)
            deletion = fn(current)
            # All reads are done; writes from here on.
            if deletion.team is not None:
                if deletion.team.id != team:
                    raise RuntimeError("a deletion may only write its own team")
                was_deleted = current is not None and current.status == TEAM_DELETED
                txn.set(self._team(team), _team_to_doc(deletion.team))
                if deletion.team.status == TEAM_DELETED and not was_deleted:
                    for creator in creators.values():
                        if creator is not None and team in creator.created:
                            creator.created.remove(team)
                            self._write_account(txn, creator)
            for entry in deletion.admin_audit:
                txn.set(self._admin_audit_col().document(), _admin_audit_to_doc(entry))
            return deletion.result

        return await self._run(body)

    async def _still_deleted(self, txn: AsyncTransaction, team: str) -> bool:
        snap = await self._team(team).get(transaction=txn)
        return snap.exists and (snap.to_dict() or {}).get("status") == TEAM_DELETED

    async def _purge_roster(self, team: str) -> int | None:
        """Delete every roster entry and take its emails' memberships of ``team`` off the
        account index, in one transaction (a team has at most 50 entries). None when the
        team is not deleted."""

        async def body(txn: AsyncTransaction) -> int | None:
            if not await self._still_deleted(txn, team):
                return None
            entries = {
                e.id: _roster_from_doc(e.to_dict() or {})
                async for e in self._roster_col(team).stream(transaction=txn)
            }
            keys = [account_key(email) for entry in entries.values() for email in entry.emails]
            accounts = await self._read_accounts(txn, keys)
            # All reads are done; writes from here on.
            for record in accounts.values():
                if record is not None and team in record.memberships:
                    record.memberships.pop(team)
                    self._write_account(txn, record)
            for member in entries:
                txn.delete(self._roster_col(team).document(member))
            return len(entries)

        return await self._run(body)

    async def _purge_batch(self, team: str, refs: Sequence[Any]) -> bool:
        async def body(txn: AsyncTransaction) -> bool:
            if not await self._still_deleted(txn, team):
                return False
            for ref in refs:
                txn.delete(ref)
            return True

        return await self._run(body)

    async def _descendants(self, team: str, limit: int) -> list[Any]:
        """Up to ``limit`` document references anywhere under ``teams/{team}``."""
        refs: list[Any] = []
        async for collection in self._team(team).collections():
            if len(refs) >= limit:
                break
            query = (
                collection.recursive().select([FieldPath.document_id()]).limit(limit - len(refs))
            )
            refs.extend([snap.reference async for snap in query.stream()])
        return refs

    async def purge_team(self, team: str, budget: int) -> bool:
        removed = await self._purge_roster(team)
        if removed is None:
            return False
        # Credentials with their pointers, then everything else under the team.
        credentials = self._team(team).collection("credentials")
        while removed < budget:
            size = min(PURGE_BATCH // 2, budget - removed)
            query = credentials.select([FieldPath.document_id()]).limit(size)
            snaps = [snap async for snap in query.stream()]
            if not snaps:
                break
            refs = [snap.reference for snap in snaps] + [self._pointer(s.id) for s in snaps]
            if not await self._purge_batch(team, refs):
                return False
            removed += len(snaps)
        while removed < budget:
            refs = await self._descendants(team, min(PURGE_BATCH, budget - removed))
            if not refs:
                break
            if not await self._purge_batch(team, refs):
                return False
            removed += len(refs)
        if await self._descendants(team, 1):
            return False

        async def mark(txn: AsyncTransaction) -> bool:
            if not await self._still_deleted(txn, team):
                return False
            txn.update(self._team(team), {"purge_complete": True})
            return True

        return await self._run(mark)

    # Boundaries (M10-SPEC §1) -------------------------------------------------------------
    async def get_boundaries(self, team: str) -> TeamBoundaries | None:
        snap = await self._boundaries(team).get()
        return _boundaries_from_doc(snap.to_dict() or {}) if snap.exists else None

    async def set_boundaries[T](
        self, team: str, member: str, fn: BoundariesFn[T], quotas: Sequence[Quota] = ()
    ) -> T:
        async def body(txn: AsyncTransaction) -> T:
            team_snap = await self._team(team).get(transaction=txn)
            if team_snap.exists and (team_snap.to_dict() or {}).get("status") == TEAM_DELETED:
                raise TeamGone(team)
            snap = await self._boundaries(team).get(transaction=txn)
            entry_snap = await self._roster_col(team).document(member).get(transaction=txn)
            current = _boundaries_from_doc(snap.to_dict() or {}) if snap.exists else None
            actor = _roster_from_doc(entry_snap.to_dict() or {}) if entry_snap.exists else None
            change = fn(current, actor)
            if change.boundaries is None:
                return change.result
            counts = await self._read_quotas(txn, team, quotas)  # raising writes nothing
            # All reads are done; writes from here on.
            self._write_quotas(txn, team, quotas, counts)
            txn.set(self._boundaries(team), _boundaries_to_doc(change.boundaries))
            self._write_audit(txn, change.audit)
            return change.result

        return await self._run(body)

    async def get_account(self, email_sha256: str) -> AccountRecord | None:
        snap = await self._account(email_sha256).get()
        return _account_from_doc(snap.id, snap.to_dict() or {}) if snap.exists else None

    async def append_admin_audit(self, entries: Sequence[AdminAuditEntry]) -> None:
        if not entries:
            return
        batch = self._db().batch()
        for entry in entries:
            batch.set(self._admin_audit_col().document(), _admin_audit_to_doc(entry))
        await batch.commit()

    async def list_admin_audit(self, limit: int = 1000) -> list[AdminAuditEntry]:
        query = self._admin_audit_col().order_by("time").limit(limit)
        return [_admin_audit_from_doc(snap.to_dict() or {}) async for snap in query.stream()]

    # Device credentials -------------------------------------------------------------------
    async def find_credential(self, teams: Sequence[str], key: str) -> CredentialRecord | None:
        teams = list(dict.fromkeys(teams))
        found: dict[str, CredentialRecord] = {}
        pointer: str | None = None
        refs = [self._credential(t, key) for t in teams] + [self._pointer(key)]
        async for snap in self._db().get_all(refs):
            if not snap.exists:
                continue
            doc = snap.to_dict() or {}
            if snap.reference.parent.id == "credential_teams":
                pointer = doc.get("team") if isinstance(doc.get("team"), str) else None
            else:
                record = _credential_from_doc(snap.id, doc)
                found[record.team] = record
        hit = next((found[t] for t in teams if t in found), None)
        if hit is not None or pointer is None or pointer in teams:
            return hit
        snap = await self._credential(pointer, key).get()
        return _credential_from_doc(snap.id, snap.to_dict() or {}) if snap.exists else None

    async def touch_credential(
        self, team: str, key: str, last_used_at: datetime, expire_at: datetime
    ) -> None:
        async def body(txn: AsyncTransaction) -> None:
            ref = self._credential(team, key)
            snap = await ref.get(transaction=txn)
            if not snap.exists or (snap.to_dict() or {}).get("revoked"):
                return
            txn.update(ref, {"last_used_at": last_used_at, "expire_at": expire_at})
            txn.set(self._pointer(key), {"team": team, "expire_at": expire_at})

        await self._run(body)

    async def list_credentials(self, team: str, member: str) -> list[CredentialRecord]:
        query = (
            self._team(team)
            .collection("credentials")
            .where(filter=FieldFilter("member", "==", member))
        )
        return [
            _credential_from_doc(snap.id, snap.to_dict() or {}) async for snap in query.stream()
        ]

    async def revoke_credential(
        self, team: str, key: str, member: str, now: datetime, audit: Sequence[AuditEntry]
    ) -> CredentialRecord | None:
        async def body(txn: AsyncTransaction) -> CredentialRecord | None:
            ref = self._credential(team, key)
            snap = await ref.get(transaction=txn)
            if not snap.exists:
                return None
            record = _credential_from_doc(key, snap.to_dict() or {})
            if record.member != member or not record.live(now):
                return None
            txn.update(ref, {"revoked": True, "revoked_at": now})
            self._write_audit(txn, audit)
            record.revoked, record.revoked_at = True, now
            return record

        return await self._run(body)

    # Login --------------------------------------------------------------------------------
    async def create_login(self, login: LoginDoc) -> None:
        await self._login(login.key).create(_login_to_doc(login))

    async def mutate_login[T](self, key: str, fn: LoginFn[T]) -> T:
        async def body(txn: AsyncTransaction) -> T:
            ref = self._login(key)
            snap = await ref.get(transaction=txn)
            change = fn(_login_from_doc(key, snap.to_dict() or {}) if snap.exists else None)
            if change.login is not None:
                if change.login.key != key:
                    raise RuntimeError("a login change may only write its own login")
                txn.set(ref, _login_to_doc(change.login))
            if change.code is not None:
                txn.create(self._code(change.code.key), _code_to_doc(change.code))
            return change.result

        return await self._run(body)

    async def redeem_code[T](self, key: str, fn: RedeemFn[T], now: datetime) -> RedeemOutcome[T]:
        async def body(txn: AsyncTransaction) -> RedeemOutcome[T]:
            ref = self._code(key)
            snap = await ref.get(transaction=txn)
            plan = fn(_code_from_doc(key, snap.to_dict() or {}) if snap.exists else None)
            if plan.credential is not None and await self._still_deleted(txn, plan.credential.team):
                raise TeamGone(plan.credential.team)  # M9-SPEC §1: before any write
            over: list[CredentialRecord] = []
            reused: CredentialRecord | None = None
            if plan.code is not None and plan.code.key != key:
                raise RuntimeError("a redemption may only write its own code")
            if plan.credential is not None:
                cred = plan.credential
                query = (
                    self._team(cred.team)
                    .collection("credentials")
                    .where(filter=FieldFilter("member", "==", cred.member))
                )
                existing = [
                    _credential_from_doc(s.id, s.to_dict() or {})
                    async for s in query.stream(transaction=txn)
                ]
                over = credentials_over_cap(existing, now, MAX_LIVE_CREDENTIALS - 1)
            if plan.revoke is not None:
                minted = await self._credential(*plan.revoke).get(transaction=txn)
                if minted.exists:
                    record = _credential_from_doc(minted.id, minted.to_dict() or {})
                    reused = record if record.live(now) else None
            # All reads are done; writes from here on.
            revoked: list[CredentialRecord] = []
            for record in [*over, *([reused] if reused else [])]:
                txn.update(
                    self._credential(record.team, record.key),
                    {"revoked": True, "revoked_at": now},
                )
                record.revoked, record.revoked_at = True, now
                revoked.append(record)
            if plan.code is not None:
                txn.set(ref, _code_to_doc(plan.code))
            if plan.credential is not None:
                txn.create(
                    self._credential(plan.credential.team, plan.credential.key),
                    _credential_to_doc(plan.credential),
                )
                txn.set(
                    self._pointer(plan.credential.key),
                    {"team": plan.credential.team, "expire_at": plan.credential.expire_at},
                )
            self._write_audit(txn, plan.audit)
            return RedeemOutcome(result=plan.result, revoked=revoked)

        return await self._run(body)

    async def count_login_quota(self, quota: Quota) -> bool:
        async def body(txn: AsyncTransaction) -> bool:
            ref = self._login_counter(quota.key)
            snap = await ref.get(transaction=txn)
            count = _int_field(snap, "count")
            if count >= quota.limit:
                return False
            txn.set(ref, {"count": count + 1, "expire_at": quota.expire_at})
            return True

        return await self._run(body)
