#!/usr/bin/env bash
# Build and deploy the team relay to Cloud Run (docs/M2-SPEC.md §1). Run
# scripts/gcp-bootstrap.sh once first, and the gcloud-auth-refresh skill before this.
#
# Usage: bash scripts/deploy.sh
#
# With PUBLIC_HOST set (M10-SPEC §5; scripts/deploy-lb.sh made the load balancer), the relay
# is reached only through https://PUBLIC_HOST: ingress internal-and-cloud-load-balancing (the
# run.app URL answers nothing from outside), RELAY_PUBLIC_URL and the audience are that
# address, and RELAY_FORWARDED_FOR_HOPS=2 tells it the balancer adds two X-Forwarded-For entries.
# Without PUBLIC_HOST, the run.app URL as before (ingress all).
#
# Either way the service runs with --no-invoker-iam-check (M11-SPEC §7): Cloud Run does not check
# the caller's IAM, and the relay authenticates every /v1 request itself. That replaces granting
# allUsers the invoker role, which organisations with domain-restricted sharing refuse. A stale
# allUsers invoker binding from an earlier deploy is removed.
#
# PLUGIN_MARKETPLACE (M11-SPEC §5; owner/repo of the GitHub repository whose
# .claude-plugin/marketplace.json lists the plugin) becomes RELAY_PLUGIN_MARKETPLACE: the relay
# then serves the one-command setup at https://PUBLIC_HOST/setup. It needs PUBLIC_HOST (the script
# sends members to the console at the same address). Unset, /setup answers 404.
#
# ALLOWED_DOMAINS (M10-SPEC §7.2; comma-separated lower-case domains, e.g. example.com) becomes
# RELAY_ALLOWED_DOMAINS: the relay then refuses every Google account outside those domains, on
# every route. Unset, any Google account can sign in and use the relay's API (create a team,
# for one); with PUBLIC_HOST set that needs CONFIRM_OPEN_RELAY=1, a deliberate choice.
#
# The Drive OAuth client (M10-SPEC §2a), when the secret team-relay-drive-client exists
# (gcp-bootstrap.sh with DRIVE_CLIENT_FILE), is mounted at /secrets/drive-oauth/client.json.
#
# Membership lives in the relay's roster and owners change it in the console (M6-SPEC).
# config/team.local.yaml holds the teams, their seed members (at least one owner each),
# limits and delegates; after changing it, run scripts/gcp-bootstrap.sh (a new secret
# version) and then this script (a revision pinned to that version).
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
SERVICE="team-relay"
DATABASE="team-relay"
SECRET="team-relay-team-config"
RUNTIME_EMAIL="team-relay-runtime@${PROJECT}.iam.gserviceaccount.com"
BUILDER_EMAIL="team-relay-builder@${PROJECT}.iam.gserviceaccount.com"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT}-team-relay-build}"
# gcloud's own OAuth client id: the audience of `gcloud auth print-identity-token` for a user
# account, which is how members authenticate (M2-SPEC §2).
GCLOUD_CLIENT_ID="32555940559.apps.googleusercontent.com"

TEAM_CONFIG="${TEAM_CONFIG:-config/team.local.yaml}"

# M10-SPEC §7.2: who may use the relay at all, checked before anything is built or deployed.
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
ALLOWED=""
ALLOWED_RAW="${ALLOWED_DOMAINS:-}"
if [[ -n "${ALLOWED_RAW//[[:space:],]/}" ]]; then
  IFS=',' read -r -a DOMAIN_ENTRIES <<<"$ALLOWED_RAW"
  for entry in "${DOMAIN_ENTRIES[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    if [[ -z "$entry" || ${#entry} -gt 253 || ! "$entry" =~ $DOMAIN_RE || "${entry##*.}" =~ ^[0-9]+$ ]]; then
      echo "error: ALLOWED_DOMAINS must be comma-separated lower-case domain names, such as example.com,example.org" >&2
      exit 1
    fi
    ALLOWED="${ALLOWED:+${ALLOWED},}${entry}"
  done
elif [[ -n "$ALLOWED_RAW" ]]; then
  echo "error: ALLOWED_DOMAINS must be comma-separated lower-case domain names, such as example.com,example.org" >&2
  exit 1
fi
if [[ -z "$ALLOWED" ]]; then
  echo "warning: ALLOWED_DOMAINS is not set, so ANY Google account (any company's, or a personal" >&2
  echo "         one) can sign in to the relay and use its API, for example to create a team." >&2
  echo "         Set ALLOWED_DOMAINS=<your domain> in config/deploy.local.env to allow only yours." >&2
  if [[ -n "${PUBLIC_HOST:-}" && "${CONFIRM_OPEN_RELAY:-}" != "1" ]]; then
    echo "error: with PUBLIC_HOST set, an open relay is a deliberate choice: set ALLOWED_DOMAINS," >&2
    echo "       or run again with CONFIRM_OPEN_RELAY=1 to keep it open to every Google account." >&2
    exit 1
  fi
fi

# M11-SPEC §5: where the setup script installs the plugin from, checked before anything is built.
MARKETPLACE_RE='^[A-Za-z0-9]([A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$'
MARKETPLACE="${PLUGIN_MARKETPLACE:-}"
if [[ -n "$MARKETPLACE" ]]; then
  if [[ ! "$MARKETPLACE" =~ $MARKETPLACE_RE || "${MARKETPLACE#*/}" == "." || "${MARKETPLACE#*/}" == ".." ]]; then
    echo "error: PLUGIN_MARKETPLACE must be a GitHub owner/repo, such as example-org/team-relay" >&2
    exit 1
  fi
  if [[ -z "${PUBLIC_HOST:-}" ]]; then
    echo "error: PLUGIN_MARKETPLACE needs PUBLIC_HOST: the setup command sends members to the console" >&2
    echo "       at the relay's address, which only the load balancer provides (scripts/deploy-lb.sh)" >&2
    exit 1
  fi
fi

if [[ -n "$(git status --porcelain -- relay schema)" ]]; then
  echo "error: relay/ or schema/ has uncommitted changes; the image is tagged by commit" >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/team-relay-images/${SERVICE}:${SHA}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUN_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
if [[ -n "${PUBLIC_HOST:-}" ]]; then
  if [[ ! "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
    echo "error: PUBLIC_HOST must be a lower-case host name, without a scheme, port or path" >&2
    exit 1
  fi
  if ! gcloud compute backend-services describe team-relay-backend --global --project="$PROJECT" >/dev/null 2>&1; then
    echo "error: no load balancer for ${PUBLIC_HOST} yet; run scripts/deploy-lb.sh first" >&2
    exit 1
  fi
  # Only through the load balancer, which adds two X-Forwarded-For entries.
  URL="https://${PUBLIC_HOST}"
  INGRESS="internal-and-cloud-load-balancing"
  PROXY_HOPS=2
else
  URL="$RUN_URL"
  INGRESS="all"
  PROXY_HOPS=1
fi

echo "Building ${IMAGE}"
gcloud builds submit \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="projects/${PROJECT}/serviceAccounts/${BUILDER_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source" \
  --gcs-log-dir="gs://${BUILD_BUCKET}/logs" \
  --config=relay/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

# The team config's current numeric version, pinned on the revision: every instance of one
# revision runs the same allowlist, and a membership change is a new secret version plus a
# redeploy (M2-SPEC §7.9), never instances drifting apart on `:latest`.
SECRET_VERSION="$(gcloud secrets versions list "$SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')"
if [[ -z "$SECRET_VERSION" ]]; then
  echo "error: no enabled version of ${SECRET}; run scripts/gcp-bootstrap.sh" >&2
  exit 1
fi

# The Drive OAuth client (M10-SPEC §2a) is optional: mounted when the secret exists.
DRIVE_SECRET="team-relay-drive-client"
DRIVE_VERSION="$(gcloud secrets versions list "$DRIVE_SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())' 2>/dev/null || true)"

# The digest, so the revision runs exactly what was built.
DIGEST="$(gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" \
  --format='value(image_summary.digest)')"
IMAGE_BY_DIGEST="${IMAGE%:*}@${DIGEST}"

OAUTH_SECRET="team-relay-oauth-client"
OAUTH_VERSION="$(gcloud secrets versions list "$OAUTH_SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')"
if [[ -z "$OAUTH_VERSION" ]]; then
  echo "error: no enabled version of ${OAUTH_SECRET}; run OAUTH_CLIENT_FILE=... scripts/gcp-bootstrap.sh" >&2
  exit 1
fi

# Reachable without Cloud Run IAM (M5-SPEC §5): the browser has to reach the sign-in pages
# before anyone is signed in, and /setup is fetched by curl with no identity. Every other
# endpoint authenticates in the app (a device credential, a Google ID token or a delegate),
# against the team's roster.
#
# Behind the load balancer the same holds: it forwards without an identity (no IAP on the
# relay's backend), so the invoker IAM check is off (--no-invoker-iam-check, M11-SPEC §7; no
# allUsers grant), and the ingress setting is what keeps the run.app URL closed from outside.
#
# --update-env-vars, never --set-env-vars. RELAY_AUDIENCE holds a comma, so the list uses
# gcloud's alternate delimiter syntax (^;^). --set-secrets lists every secret each time, so a
# secret left out is unmounted.
SECRETS="/secrets/team/team.yaml=${SECRET}:${SECRET_VERSION},/secrets/oauth/client.json=${OAUTH_SECRET}:${OAUTH_VERSION}"
ENV_VARS="^;^RELAY_AUTH_MODE=google;RELAY_AUDIENCE=${GCLOUD_CLIENT_ID},${URL};RELAY_FIRESTORE_DATABASE=${DATABASE};GOOGLE_CLOUD_PROJECT=${PROJECT};RELAY_TEAM_CONFIG=/secrets/team/team.yaml;RELAY_OAUTH_CLIENT_FILE=/secrets/oauth/client.json;RELAY_PUBLIC_URL=${URL};RELAY_FORWARDED_FOR_HOPS=${PROXY_HOPS};RELAY_HOST=0.0.0.0;APP_VERSION=${SHA}"
REMOVE_VARS=()
if [[ -n "$ALLOWED" ]]; then
  ENV_VARS="${ENV_VARS};RELAY_ALLOWED_DOMAINS=${ALLOWED}"
  DOMAINS_NOTE="Google accounts of ${ALLOWED} only"
else
  # Removed, not left over from an earlier deploy: the open relay was confirmed above.
  REMOVE_VARS+=(RELAY_ALLOWED_DOMAINS)
  DOMAINS_NOTE="any Google account"
fi
if [[ -n "$MARKETPLACE" ]]; then
  ENV_VARS="${ENV_VARS};RELAY_PLUGIN_MARKETPLACE=${MARKETPLACE}"
  SETUP_NOTE="setup from ${MARKETPLACE}"
else
  # Not configured: the relay answers /setup with 404.
  REMOVE_VARS+=(RELAY_PLUGIN_MARKETPLACE)
  SETUP_NOTE="no setup command"
fi
if [[ -n "$DRIVE_VERSION" ]]; then
  SECRETS="${SECRETS},/secrets/drive-oauth/client.json=${DRIVE_SECRET}:${DRIVE_VERSION}"
  ENV_VARS="${ENV_VARS};RELAY_DRIVE_CLIENT_FILE=/secrets/drive-oauth/client.json"
  DRIVE_NOTE="drive client v${DRIVE_VERSION}"
else
  # Not configured: the relay answers drive-client with 404 drive_not_configured.
  REMOVE_VARS+=(RELAY_DRIVE_CLIENT_FILE)
  DRIVE_NOTE="no drive client"
fi
REMOVE_FLAG=()
if [[ ${#REMOVE_VARS[@]} -gt 0 ]]; then
  REMOVE_FLAG=("--remove-env-vars=$(IFS=','; echo "${REMOVE_VARS[*]}")")
fi

echo "Deploying ${SERVICE} (${IMAGE_BY_DIGEST}, team config v${SECRET_VERSION}, oauth v${OAUTH_VERSION}, ${DRIVE_NOTE}, ${DOMAINS_NOTE}, ${SETUP_NOTE}, ingress ${INGRESS})"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_BY_DIGEST" \
  --service-account="$RUNTIME_EMAIL" \
  --no-invoker-iam-check \
  --ingress="$INGRESS" \
  --min-instances=0 --max-instances=3 --cpu=1 --memory=512Mi --timeout=60 \
  --set-secrets="$SECRETS" \
  ${REMOVE_FLAG[@]+"${REMOVE_FLAG[@]}"} \
  --update-env-vars="$ENV_VARS" \
  --quiet

# An allUsers invoker grant left by an earlier deploy (before --no-invoker-iam-check) is removed,
# so the policy says what the service does and re-enabling the IAM check never makes it public.
INVOKER_BINDINGS="$(gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)')"
if grep -qx 'roles/run.invoker,allUsers' <<<"$INVOKER_BINDINGS"; then
  gcloud run services remove-iam-policy-binding "$SERVICE" --project="$PROJECT" --region="$REGION" \
    --member=allUsers --role=roles/run.invoker --quiet >/dev/null
  echo "   allUsers invoker grant: removed (the invoker IAM check is off instead)"
fi

echo
echo "Deployed ${SERVICE}: ${URL}"
if [[ -n "${PUBLIC_HOST:-}" ]]; then
  echo "   ${RUN_URL} answers nothing from outside (ingress ${INGRESS})."
fi
if [[ -n "$MARKETPLACE" ]]; then
  echo "Members join with: curl -fsSL ${URL}/setup | bash"
else
  echo "Members install the plugin and run /team-relay:login (relay ${URL})."
fi
