#!/usr/bin/env bash
# One-time Google Cloud setup for the team relay (docs/M2-SPEC.md §1). Idempotent: every
# step checks first and prints `exists`, `created` or `updated`, so it is safe to re-run.
#
# Usage: bash scripts/gcp-bootstrap.sh
#        TEAM_CONFIG=config/team.local.yaml bash scripts/gcp-bootstrap.sh
#        OAUTH_CLIENT_FILE=<web client JSON> DRIVE_CLIENT_FILE=<desktop client JSON> \
#          bash scripts/gcp-bootstrap.sh
#        GITHUB_APP_ID=<app id> GITHUB_APP_SLUG=<app slug> GITHUB_APP_KEY_FILE=<.pem> \
#          bash scripts/gcp-bootstrap.sh
#        PICKER_CLIENT_ID=<web client id> PICKER_API_KEY=<browser API key> \
#          bash scripts/gcp-bootstrap.sh
#
# Every resource is namespaced team-relay*. Nothing here reads, writes or grants anything on
# other resources that may share the project, and nothing here shares a service account,
# bucket, database or secret with them.
#
# Run the gcloud-auth-refresh skill before this; an expired token fails these silently.
set -euo pipefail

# Deployment settings come from config/deploy.local.env (git-ignored; copy
# config/deploy.example.env) or the environment. Nothing about a particular project is
# hardcoded here.
cd "$(dirname "$0")/.."
if [[ -f config/deploy.local.env ]]; then
  # shellcheck disable=SC1091
  source config/deploy.local.env
fi
PROJECT="${PROJECT:?set PROJECT in config/deploy.local.env or the environment}"
REGION="${REGION:-australia-southeast1}"
DATABASE="team-relay"
REPO="team-relay-images"
RUNTIME_SA="team-relay-runtime"
CONSOLE_SA="team-relay-console"
BUILDER_SA="team-relay-builder"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT}-team-relay-build}"
SECRET="team-relay-team-config"
KEEP_IMAGES=10
BUILD_OBJECT_TTL_DAYS=7

TEAM_CONFIG="${TEAM_CONFIG:-config/team.local.yaml}"

RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"
BUILDER_EMAIL="${BUILDER_SA}@${PROJECT}.iam.gserviceaccount.com"
CONSOLE_EMAIL="${CONSOLE_SA}@${PROJECT}.iam.gserviceaccount.com"

if [[ ! -f "$TEAM_CONFIG" ]]; then
  echo "error: no ${TEAM_CONFIG}; copy config/team.example.yaml and fill in the real members" >&2
  exit 1
fi

# PICKERS-SPEC §4.2: the GitHub App's three settings go together, and so do the Picker's two;
# all are checked before anything changes.
GITHUB_SET=0
for name in GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_KEY_FILE; do
  if [[ -n "${!name:-}" ]]; then GITHUB_SET=$((GITHUB_SET + 1)); fi
done
if [[ "$GITHUB_SET" != 0 && "$GITHUB_SET" != 3 ]]; then
  echo "error: GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_KEY_FILE go together" >&2
  exit 1
fi
if [[ -n "${PICKER_CLIENT_ID:-}" && -z "${PICKER_API_KEY:-}" ]] ||
    [[ -z "${PICKER_CLIENT_ID:-}" && -n "${PICKER_API_KEY:-}" ]]; then
  echo "error: PICKER_CLIENT_ID and PICKER_API_KEY go together" >&2
  exit 1
fi
if [[ "$GITHUB_SET" == 3 ]]; then
  if [[ ! "$GITHUB_APP_ID" =~ ^[0-9]{1,12}$ ]]; then
    echo "error: GITHUB_APP_ID must be the app's numeric id (1 to 12 digits)" >&2
    exit 1
  fi
  if [[ ! "$GITHUB_APP_SLUG" =~ ^[a-z0-9][a-z0-9-]{0,99}$ ]]; then
    echo "error: GITHUB_APP_SLUG must be the last part of the app's public link, such as example-relay-sources" >&2
    exit 1
  fi
  # An unencrypted RSA key of 2048 bits or more, as the relay requires. Only the size of its
  # public half is read; the key itself is never printed.
  if [[ ! -f "$GITHUB_APP_KEY_FILE" ]] ||
      ! openssl rsa -in "$GITHUB_APP_KEY_FILE" -passin pass: -check -noout >/dev/null 2>&1; then
    echo "error: GITHUB_APP_KEY_FILE must be the app's unencrypted RSA private key (.pem)" >&2
    exit 1
  fi
  KEY_BITS="$(openssl rsa -in "$GITHUB_APP_KEY_FILE" -passin pass: -pubout 2>/dev/null |
    openssl rsa -pubin -noout -text 2>/dev/null | sed -n 's/.*(\([0-9][0-9]*\) bit).*/\1/p' | head -1)"
  if [[ -z "$KEY_BITS" || "$KEY_BITS" -lt 2048 ]]; then
    echo "error: GITHUB_APP_KEY_FILE must be an RSA key of 2048 bits or more" >&2
    exit 1
  fi
fi
if [[ -n "${PICKER_CLIENT_ID:-}" ]]; then
  if [[ ! "$PICKER_CLIENT_ID" =~ ^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$ ]]; then
    echo "error: PICKER_CLIENT_ID must be the picker's Web OAuth client id (ending .apps.googleusercontent.com)" >&2
    exit 1
  fi
  if [[ ! "$PICKER_API_KEY" =~ ^AIza[0-9A-Za-z_-]{35}$ ]]; then
    echo "error: PICKER_API_KEY must be a Google API key (AIza and 35 more characters)" >&2
    exit 1
  fi
fi

OPERATOR="${OPERATOR:-$(gcloud config get-value account 2>/dev/null || true)}"
if [[ -z "$OPERATOR" || "$OPERATOR" == "(unset)" ]]; then
  echo "error: no active gcloud account and no OPERATOR set" >&2
  exit 1
fi
if [[ "$OPERATOR" == *.gserviceaccount.com ]]; then
  OPERATOR_MEMBER="serviceAccount:${OPERATOR}"
else
  OPERATOR_MEMBER="user:${OPERATOR}"
fi

echo "project=${PROJECT} region=${REGION} operator=${OPERATOR_MEMBER}"
echo

has_binding() {  # stdin: csv role,member rows; $1 role; $2 member
  grep -qx "$1,$2"
}

# ---------------------------------------------------------------- 1. services
echo "1. services"
ENABLED="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)')"
# compute: the load balancer of scripts/deploy-lb.sh (M10-SPEC §5). cloudresourcemanager: the
# IAP access step reads and changes IAM policies through it (M11-SPEC §7). picker and drive: the
# console's Drive folder picker (PICKERS-SPEC §5), which runs on the owner's own Google sign-in.
for api in run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com firestore.googleapis.com iam.googleapis.com iap.googleapis.com \
    compute.googleapis.com cloudresourcemanager.googleapis.com picker.googleapis.com \
    drive.googleapis.com; do
  if grep -qx "$api" <<<"$ENABLED"; then
    echo "   ${api}: exists"
  else
    gcloud services enable "$api" --project="$PROJECT" --quiet
    echo "   ${api}: created"
  fi
done

# ------------------------------------------------------- 2. artifact registry
echo "2. artifact registry"
if gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT" \
    >/dev/null 2>&1; then
  echo "   repo ${REPO}: exists"
else
  gcloud artifacts repositories create "$REPO" --repository-format=docker \
    --location="$REGION" --project="$PROJECT" --description="Team relay images" --quiet
  echo "   repo ${REPO}: created"
fi
if gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT" \
    --format='value(cleanupPolicies)' | grep -q "keep-last-${KEEP_IMAGES}"; then
  echo "   cleanup policy: exists"
else
  CLEANUP_FILE="$(mktemp)"
  cat > "$CLEANUP_FILE" <<JSON
[
  {"name": "keep-last-${KEEP_IMAGES}", "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": ${KEEP_IMAGES}}},
  {"name": "delete-the-rest", "action": {"type": "Delete"}, "condition": {"tagState": "ANY"}}
]
JSON
  gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" \
    --project="$PROJECT" --policy="$CLEANUP_FILE" --quiet >/dev/null
  rm -f "$CLEANUP_FILE"
  echo "   cleanup policy: created (keep the last ${KEEP_IMAGES})"
fi

# ------------------------------------------------------- 3. service accounts
echo "3. service accounts"
for pair in "${RUNTIME_SA}:Team relay runtime" "${BUILDER_SA}:Team relay Cloud Build" \
    "${CONSOLE_SA}:Team relay hosted console"; do
  sa="${pair%%:*}"
  display="${pair#*:}"
  if gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" \
      --project="$PROJECT" >/dev/null 2>&1; then
    echo "   sa ${sa}: exists"
  else
    gcloud iam service-accounts create "$sa" --project="$PROJECT" \
      --display-name="$display" --quiet
    echo "   sa ${sa}: created"
  fi
done

PROJECT_POLICY="$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
  --format='csv[no-heading](bindings.role,bindings.members)')"
for member in "serviceAccount:${RUNTIME_EMAIL}" "serviceAccount:${BUILDER_EMAIL}" \
    "serviceAccount:${CONSOLE_EMAIL}"; do
  if has_binding roles/logging.logWriter "$member" <<<"$PROJECT_POLICY"; then
    echo "   logging.logWriter for ${member#serviceAccount:}: exists"
  else
    gcloud projects add-iam-policy-binding "$PROJECT" --member="$member" \
      --role=roles/logging.logWriter --condition=None --quiet >/dev/null
    echo "   logging.logWriter for ${member#serviceAccount:}: created"
  fi
done

# Firestore access for the runtime, on the relay's own database only. roles/datastore.user
# is a project-level role; the condition narrows it to projects/<p>/databases/team-relay, so
# this identity cannot read or write any other Firestore database in the shared project.
DB_CONDITION="expression=resource.name == \"projects/${PROJECT}/databases/${DATABASE}\",title=team-relay-database-only"
if gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members,bindings.condition.title)' \
    | grep -qx "roles/datastore.user,serviceAccount:${RUNTIME_EMAIL},team-relay-database-only"; then
  echo "   datastore.user (team-relay database only): exists"
else
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_EMAIL}" \
    --role=roles/datastore.user --condition="$DB_CONDITION" --quiet >/dev/null
  echo "   datastore.user (team-relay database only): created"
fi

# The builder pushes to its one repo and nothing else; it gets no serviceAccountUser
# anywhere, because a build does not deploy (scripts/deploy.sh does, as the operator).
if gcloud artifacts repositories get-iam-policy "$REPO" --location="$REGION" --project="$PROJECT" \
    --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
    | has_binding roles/artifactregistry.writer "serviceAccount:${BUILDER_EMAIL}"; then
  echo "   artifactregistry.writer on ${REPO}: exists"
else
  gcloud artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" \
    --project="$PROJECT" --member="serviceAccount:${BUILDER_EMAIL}" \
    --role=roles/artifactregistry.writer --quiet >/dev/null
  echo "   artifactregistry.writer on ${REPO}: created"
fi

# ------------------------------------------------------- 4. build bucket
echo "4. build bucket"
if gcloud storage buckets describe "gs://${BUILD_BUCKET}" --project="$PROJECT" >/dev/null 2>&1; then
  echo "   bucket ${BUILD_BUCKET}: exists"
else
  gcloud storage buckets create "gs://${BUILD_BUCKET}" --project="$PROJECT" \
    --location="$REGION" --uniform-bucket-level-access --public-access-prevention --quiet
  echo "   bucket ${BUILD_BUCKET}: created"
fi
if gcloud storage buckets describe "gs://${BUILD_BUCKET}" --project="$PROJECT" \
    --format='value(lifecycle_config)' | grep -q "'age': ${BUILD_OBJECT_TTL_DAYS}"; then
  echo "   lifecycle (${BUILD_OBJECT_TTL_DAYS}d delete): exists"
else
  LIFECYCLE_FILE="$(mktemp)"
  echo "{\"rule\": [{\"action\": {\"type\": \"Delete\"}, \"condition\": {\"age\": ${BUILD_OBJECT_TTL_DAYS}}}]}" \
    > "$LIFECYCLE_FILE"
  gcloud storage buckets update "gs://${BUILD_BUCKET}" --project="$PROJECT" \
    --lifecycle-file="$LIFECYCLE_FILE" --quiet >/dev/null
  rm -f "$LIFECYCLE_FILE"
  echo "   lifecycle (${BUILD_OBJECT_TTL_DAYS}d delete): created"
fi
BUCKET_POLICY="$(gcloud storage buckets get-iam-policy "gs://${BUILD_BUCKET}" --project="$PROJECT" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)')"
for grant in "roles/storage.admin,${OPERATOR_MEMBER}" \
    "roles/storage.objectAdmin,serviceAccount:${BUILDER_EMAIL}" \
    "roles/storage.legacyBucketReader,serviceAccount:${BUILDER_EMAIL}"; do
  role="${grant%%,*}"
  member="${grant#*,}"
  if has_binding "$role" "$member" <<<"$BUCKET_POLICY"; then
    echo "   ${role} for ${member#*:}: exists"
  else
    gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" --project="$PROJECT" \
      --member="$member" --role="$role" --quiet >/dev/null
    echo "   ${role} for ${member#*:}: created"
  fi
done

# ------------------------------------------------------- 5. firestore
echo "5. firestore"
if gcloud firestore databases describe --database="$DATABASE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "   database ${DATABASE}: exists"
else
  gcloud firestore databases create --database="$DATABASE" --project="$PROJECT" \
    --location="$REGION" --type=firestore-native --delete-protection --quiet >/dev/null
  echo "   database ${DATABASE}: created"
fi

if gcloud firestore indexes composite list --database="$DATABASE" --project="$PROJECT" \
    --format='value(fields[].fieldPath.list())' 2>/dev/null | grep -q "asker,next_deadline"; then
  echo "   index requests(asker, next_deadline): exists"
else
  gcloud firestore indexes composite create --database="$DATABASE" --project="$PROJECT" \
    --collection-group=requests --query-scope=COLLECTION \
    --field-config=field-path=asker,order=ascending \
    --field-config=field-path=next_deadline,order=ascending --async --quiet >/dev/null
  echo "   index requests(asker, next_deadline): created (building)"
fi

# M11-SPEC §4: a member's own recent questions (GET me/requests), newest first.
if gcloud firestore indexes composite list --database="$DATABASE" --project="$PROJECT" \
    --format='value(fields[].fieldPath.list())' 2>/dev/null | grep -q "asker,kind,created_at"; then
  echo "   index requests(asker, kind, created_at desc): exists"
else
  gcloud firestore indexes composite create --database="$DATABASE" --project="$PROJECT" \
    --collection-group=requests --query-scope=COLLECTION \
    --field-config=field-path=asker,order=ascending \
    --field-config=field-path=kind,order=ascending \
    --field-config=field-path=created_at,order=descending --async --quiet >/dev/null
  echo "   index requests(asker, kind, created_at desc): created (building)"
fi

# TTL deletes expired documents lazily (typically within a day); the relay filters expired
# documents on every read regardless, so this is storage hygiene, not correctness.
TTLS="$(gcloud firestore fields ttls list --database="$DATABASE" --project="$PROJECT" \
  --format='csv[no-heading](name,ttlConfig.state)' 2>/dev/null || true)"
for group in messages requests answers progress idempotency audit counters credentials logins \
    login_codes login_limits retired credential_teams admin_audit; do
  state="$(grep "/collectionGroups/${group}/fields/expire_at," <<<"$TTLS" | cut -d, -f2 || true)"
  if [[ "$state" == "ACTIVE" || "$state" == "CREATING" ]]; then
    echo "   ttl ${group}.expire_at: exists (${state})"
  else
    gcloud firestore fields ttls update expire_at --collection-group="$group" \
      --database="$DATABASE" --project="$PROJECT" --enable-ttl --async --quiet >/dev/null 2>&1
    echo "   ttl ${group}.expire_at: created"
  fi
done

# ------------------------------------------------------- 6. team config secret
echo "6. team config secret"
if gcloud secrets describe "$SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  CURRENT="$(gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" \
    2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
  WANTED="$(shasum -a 256 < "$TEAM_CONFIG" | cut -d' ' -f1)"
  if [[ "$CURRENT" == "$WANTED" ]]; then
    echo "   secret ${SECRET}: exists (current)"
  else
    gcloud secrets versions add "$SECRET" --project="$PROJECT" --data-file="$TEAM_CONFIG" \
      --quiet >/dev/null
    echo "   secret ${SECRET}: updated (new version; redeploy to pick it up)"
  fi
else
  gcloud secrets create "$SECRET" --project="$PROJECT" --replication-policy=user-managed \
    --locations="$REGION" --data-file="$TEAM_CONFIG" --quiet >/dev/null
  echo "   secret ${SECRET}: created"
fi
if gcloud secrets get-iam-policy "$SECRET" --project="$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)' \
    | has_binding roles/secretmanager.secretAccessor "serviceAccount:${RUNTIME_EMAIL}"; then
  echo "   accessor on ${SECRET}: exists"
else
  gcloud secrets add-iam-policy-binding "$SECRET" --project="$PROJECT" \
    --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
  echo "   accessor on ${SECRET}: created"
fi

# ------------------------------------------------------- 7. IAP service agent
# The identity IAP uses to invoke the hosted console (M3-SPEC §1). Creating it is idempotent.
echo "7. IAP service agent"
gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT" \
  --quiet >/dev/null 2>&1
echo "   service-<number>@gcp-sa-iap: exists"

# ------------------------------------------------------- 8. login OAuth client (M5)
# The relay's Google sign-in (docs/M5-SPEC.md §5) uses a Web OAuth client created in the
# Cloud Console. Given OAUTH_CLIENT_FILE (the client's downloaded JSON), its id and secret
# are stored as the secret team-relay-oauth-client; the value is never printed.
OAUTH_SECRET="team-relay-oauth-client"
echo "8. login OAuth client"
if [[ -n "${OAUTH_CLIENT_FILE:-}" ]]; then
  WANTED_OAUTH="$(python3 - "$OAUTH_CLIENT_FILE" <<'PYEOF'
import json, sys
web = json.load(open(sys.argv[1], encoding="utf-8")).get("web") or {}
if not web.get("client_id") or not web.get("client_secret"):
    sys.exit("error: not a Web application OAuth client JSON")
print(json.dumps({"client_id": web["client_id"], "client_secret": web["client_secret"]},
                 sort_keys=True, separators=(",", ":")))
PYEOF
)"
  if gcloud secrets describe "$OAUTH_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
    CURRENT_OAUTH="$(gcloud secrets versions access latest --secret="$OAUTH_SECRET" \
      --project="$PROJECT" 2>/dev/null || true)"
    if [[ "$CURRENT_OAUTH" == "$WANTED_OAUTH" ]]; then
      echo "   secret ${OAUTH_SECRET}: exists (current)"
    else
      printf '%s' "$WANTED_OAUTH" | gcloud secrets versions add "$OAUTH_SECRET" \
        --project="$PROJECT" --data-file=- --quiet >/dev/null
      echo "   secret ${OAUTH_SECRET}: updated (redeploy the relay)"
    fi
  else
    printf '%s' "$WANTED_OAUTH" | gcloud secrets create "$OAUTH_SECRET" --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION" --data-file=- --quiet >/dev/null
    echo "   secret ${OAUTH_SECRET}: created"
  fi
  unset WANTED_OAUTH CURRENT_OAUTH
fi
if gcloud secrets describe "$OAUTH_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  if gcloud secrets get-iam-policy "$OAUTH_SECRET" --project="$PROJECT" --flatten='bindings[].members' \
      --format='csv[no-heading](bindings.role,bindings.members)' \
      | has_binding roles/secretmanager.secretAccessor "serviceAccount:${RUNTIME_EMAIL}"; then
    echo "   accessor on ${OAUTH_SECRET}: exists"
  else
    gcloud secrets add-iam-policy-binding "$OAUTH_SECRET" --project="$PROJECT" \
      --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/secretmanager.secretAccessor \
      --quiet >/dev/null
    echo "   accessor on ${OAUTH_SECRET}: created"
  fi
else
  echo "   secret ${OAUTH_SECRET}: skipped (set OAUTH_CLIENT_FILE=<client JSON> to create it)"
fi

# ------------------------------------------------------- 9. console IP-hash salt (M9)
# The hosted console hashes each viewer's address with this salt before telling the relay
# (M9-SPEC §7.6); a random value created once, never printed, readable only by the console.
SALT_SECRET="team-relay-console-ip-salt"
echo "9. console IP-hash salt"
if gcloud secrets describe "$SALT_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "   secret ${SALT_SECRET}: exists"
else
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$SALT_SECRET" --project="$PROJECT" \
    --replication-policy=user-managed --locations="$REGION" --data-file=- --quiet >/dev/null
  echo "   secret ${SALT_SECRET}: created (value not shown)"
fi
if gcloud secrets get-iam-policy "$SALT_SECRET" --project="$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)' \
    | has_binding roles/secretmanager.secretAccessor "serviceAccount:${CONSOLE_EMAIL}"; then
  echo "   accessor on ${SALT_SECRET}: exists"
else
  gcloud secrets add-iam-policy-binding "$SALT_SECRET" --project="$PROJECT" \
    --member="serviceAccount:${CONSOLE_EMAIL}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
  echo "   accessor on ${SALT_SECRET}: created"
fi

# ------------------------------------------------------- 10. Drive OAuth client (M10)
# The Desktop OAuth client members connect Google Drive with (M10-SPEC §2a: loopback + PKCE,
# scope drive.readonly). Given DRIVE_CLIENT_FILE (the client's downloaded JSON), its id and
# installed-app secret are stored as the secret team-relay-drive-client, readable by the relay's
# runtime only, which serves them to active members; the value is never printed. Optional:
# without it the relay answers drive-client with 404 drive_not_configured.
DRIVE_SECRET="team-relay-drive-client"
echo "10. Drive OAuth client"
if [[ -n "${DRIVE_CLIENT_FILE:-}" ]]; then
  WANTED_DRIVE="$(python3 - "$DRIVE_CLIENT_FILE" <<'PYEOF'
import json, re, sys
installed = json.load(open(sys.argv[1], encoding="utf-8")).get("installed") or {}
client_id, secret = installed.get("client_id"), installed.get("client_secret")
if not client_id or not re.fullmatch(r"[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com", client_id):
    sys.exit("error: not a Desktop app OAuth client JSON (no installed.client_id)")
if not secret or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", secret):
    sys.exit("error: the Desktop client JSON has no usable client_secret")
print(json.dumps({"client_id": client_id, "client_secret": secret}, sort_keys=True, separators=(",", ":")))
PYEOF
)"
  if gcloud secrets describe "$DRIVE_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
    CURRENT_DRIVE="$(gcloud secrets versions access latest --secret="$DRIVE_SECRET" \
      --project="$PROJECT" 2>/dev/null || true)"
    if [[ "$CURRENT_DRIVE" == "$WANTED_DRIVE" ]]; then
      echo "   secret ${DRIVE_SECRET}: exists (current)"
    else
      printf '%s' "$WANTED_DRIVE" | gcloud secrets versions add "$DRIVE_SECRET" \
        --project="$PROJECT" --data-file=- --quiet >/dev/null
      echo "   secret ${DRIVE_SECRET}: updated (redeploy the relay)"
    fi
  else
    printf '%s' "$WANTED_DRIVE" | gcloud secrets create "$DRIVE_SECRET" --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION" --data-file=- --quiet >/dev/null
    echo "   secret ${DRIVE_SECRET}: created"
  fi
  unset WANTED_DRIVE CURRENT_DRIVE
fi
if gcloud secrets describe "$DRIVE_SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  if gcloud secrets get-iam-policy "$DRIVE_SECRET" --project="$PROJECT" --flatten='bindings[].members' \
      --format='csv[no-heading](bindings.role,bindings.members)' \
      | has_binding roles/secretmanager.secretAccessor "serviceAccount:${RUNTIME_EMAIL}"; then
    echo "   accessor on ${DRIVE_SECRET}: exists"
  else
    gcloud secrets add-iam-policy-binding "$DRIVE_SECRET" --project="$PROJECT" \
      --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/secretmanager.secretAccessor \
      --quiet >/dev/null
    echo "   accessor on ${DRIVE_SECRET}: created"
  fi
else
  echo "   secret ${DRIVE_SECRET}: skipped (set DRIVE_CLIENT_FILE=<Desktop client JSON> to create it)"
fi

# A JSON secret readable by the relay's runtime only, from $2 (sent on stdin, never printed):
# created, updated when it differs, or left as it is.
store_runtime_secret() {  # $1 secret name, $2 the value
  local current
  if gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; then
    current="$(gcloud secrets versions access latest --secret="$1" --project="$PROJECT" \
      2>/dev/null || true)"
    if [[ "$current" == "$2" ]]; then
      echo "   secret $1: exists (current)"
    else
      printf '%s' "$2" | gcloud secrets versions add "$1" --project="$PROJECT" --data-file=- \
        --quiet >/dev/null
      echo "   secret $1: updated (redeploy the relay)"
    fi
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION" --data-file=- --quiet >/dev/null
    echo "   secret $1: created"
  fi
}

runtime_accessor() {  # $1 secret name, $2 how to create it when it does not exist
  if gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; then
    if gcloud secrets get-iam-policy "$1" --project="$PROJECT" --flatten='bindings[].members' \
        --format='csv[no-heading](bindings.role,bindings.members)' |
        has_binding roles/secretmanager.secretAccessor "serviceAccount:${RUNTIME_EMAIL}"; then
      echo "   accessor on $1: exists"
    else
      gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT" \
        --member="serviceAccount:${RUNTIME_EMAIL}" --role=roles/secretmanager.secretAccessor \
        --quiet >/dev/null
      echo "   accessor on $1: created"
    fi
  else
    echo "   secret $1: skipped ($2)"
  fi
}

# ------------------------------------------------------- 11. GitHub App (PICKERS-SPEC §4.2)
# The read-only GitHub App owners pick repositories from: its id, its slug and its private key,
# stored as the JSON secret team-relay-github-app ({"app_id", "slug", "private_key"}), readable
# by the relay's runtime only. The key is never printed; delete the .pem afterwards (or keep it
# only in a password manager). Optional: without it owners paste repository links. While it
# exists, scripts/deploy.sh needs GITHUB_ORGS.
GITHUB_SECRET="team-relay-github-app"
echo "11. GitHub App"
if [[ "$GITHUB_SET" == 3 ]]; then
  WANTED_GITHUB="$(python3 - "$GITHUB_APP_ID" "$GITHUB_APP_SLUG" "$GITHUB_APP_KEY_FILE" <<'PYEOF'
import json, sys
with open(sys.argv[3], encoding="ascii") as key:
    pem = key.read()
print(json.dumps({"app_id": sys.argv[1], "slug": sys.argv[2], "private_key": pem},
                 sort_keys=True, separators=(",", ":")))
PYEOF
)"
  store_runtime_secret "$GITHUB_SECRET" "$WANTED_GITHUB"
  unset WANTED_GITHUB
fi
runtime_accessor "$GITHUB_SECRET" \
  "set GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_KEY_FILE to create it"

# ------------------------------------------------------- 12. Drive picker (PICKERS-SPEC §5)
# The Google Picker's settings: its own Web OAuth client id (JavaScript origin
# https://PUBLIC_HOST), the browser API key (restricted to the Picker API and the console's host)
# and this project's number, read here. Public by design (Google restricts them); stored as
# team-relay-picker ({"client_id", "api_key", "app_id"}) so the relay hands them to owners only.
# Optional: without it owners paste Drive folder links.
PICKER_SECRET="team-relay-picker"
echo "12. Drive picker"
if [[ -n "${PICKER_CLIENT_ID:-}" ]]; then
  PICKER_APP_ID="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  if [[ ! "$PICKER_APP_ID" =~ ^[0-9]{6,20}$ ]]; then
    echo "error: could not read the project number of ${PROJECT}" >&2
    exit 1
  fi
  # Through the environment, never argv (a command line shows in ps).
  WANTED_PICKER="$(TR_PICKER_CLIENT_ID="$PICKER_CLIENT_ID" TR_PICKER_API_KEY="$PICKER_API_KEY" \
    TR_PICKER_APP_ID="$PICKER_APP_ID" python3 - <<'PYEOF'
import json, os
print(json.dumps({"client_id": os.environ["TR_PICKER_CLIENT_ID"],
                  "api_key": os.environ["TR_PICKER_API_KEY"],
                  "app_id": os.environ["TR_PICKER_APP_ID"]},
                 sort_keys=True, separators=(",", ":")))
PYEOF
)"
  store_runtime_secret "$PICKER_SECRET" "$WANTED_PICKER"
  unset WANTED_PICKER
fi
runtime_accessor "$PICKER_SECRET" "set PICKER_CLIENT_ID and PICKER_API_KEY to create it"

echo
if [[ -n "${PUBLIC_HOST:-}" ]]; then
  echo "Bootstrap complete. Next: bash scripts/deploy-lb.sh, then bash scripts/deploy.sh and bash scripts/deploy-console.sh"
else
  echo "Bootstrap complete. Deploy with: bash scripts/deploy.sh, then bash scripts/deploy-console.sh"
fi
