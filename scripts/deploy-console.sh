#!/usr/bin/env bash
# Build and deploy the hosted console (docs/M3-SPEC.md) to Cloud Run behind IAP. Run
# scripts/gcp-bootstrap.sh and scripts/deploy.sh first (the relay must list the console's
# service account as a read-only delegate and grant it run.invoker), and the
# gcloud-auth-refresh skill before this.
#
# Usage: bash scripts/deploy-console.sh
#        OAUTH_CLIENT_FILE=~/Downloads/client_secret_....json bash scripts/deploy-console.sh
#        OAUTH_CLIENT_ID=<id> OAUTH_CLIENT_SECRET_FILE=<file holding only the secret> \
#          bash scripts/deploy-console.sh
#
# OAUTH_CLIENT_FILE is the Web OAuth client JSON the operator creates in the Cloud Console (the members
# are outside the project's organisation, so IAP's Google-managed client cannot admit them).
# It is read here and handed to IAP for this one service; its secret is never printed.
#
# With PUBLIC_HOST set (M10-SPEC §5), the console sits behind the load balancer
# scripts/deploy-lb.sh made, which must exist first:
# - ingress internal-and-cloud-load-balancing: the run.app URL answers nothing from outside;
# - IAP moves from the Cloud Run service (--no-iap) to the console's backend service, where
#   deploy-lb.sh enables it with the custom OAuth client and IAP_ACCESS; IAP_AUDIENCE becomes
#   /projects/<number>/global/backendServices/<id of team-relay-console-backend>, so an
#   assertion IAP signed for anything else is refused;
# - the invoker is still only IAP's service agent: IAP on a backend service calls a Cloud Run
#   backend with that agent's identity, so the service keeps --no-allow-unauthenticated and the
#   load balancer reaches it only by way of IAP;
# - the console calls the relay at https://PUBLIC_HOST (the relay's run.app URL refuses calls
#   from outside, the console's own included), and counts the viewer's address as the
#   balancer writes it (CONSOLE_PROXY_HOPS=2; required: on a host that is not run.app the console
#   refuses to start without it, M10-SPEC §7.7).
# Without PUBLIC_HOST, the run.app URLs and Cloud Run's own IAP, as before.
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
SERVICE="team-relay-console"
RELAY_SERVICE="team-relay"
TEAM="${TEAM:?set TEAM (the team id the console shows) in config/deploy.local.env}"
CONSOLE_EMAIL="team-relay-console@${PROJECT}.iam.gserviceaccount.com"
BUILDER_EMAIL="team-relay-builder@${PROJECT}.iam.gserviceaccount.com"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT}-team-relay-build}"

TEAM_CONFIG="${TEAM_CONFIG:-config/team.local.yaml}"

if [[ -n "$(git status --porcelain -- plugin/dist plugin/Dockerfile.console plugin/cloudbuild.console.yaml)" ]]; then
  echo "error: the console bundle or its build files have uncommitted changes" >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/team-relay-images/${SERVICE}:${SHA}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
CONSOLE_BACKEND="team-relay-console-backend"
if [[ -n "${PUBLIC_HOST:-}" ]]; then
  if [[ ! "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
    echo "error: PUBLIC_HOST must be a lower-case host name, without a scheme, port or path" >&2
    exit 1
  fi
  BACKEND_ID="$(gcloud compute backend-services describe "$CONSOLE_BACKEND" --global \
    --project="$PROJECT" --format='value(id)' 2>/dev/null || true)"
  BACKEND_IAP="$(gcloud compute backend-services describe "$CONSOLE_BACKEND" --global \
    --project="$PROJECT" --format='value(iap.enabled)' 2>/dev/null || true)"
  if [[ -z "$BACKEND_ID" || "$BACKEND_IAP" != "True" ]]; then
    echo "error: no IAP-protected backend ${CONSOLE_BACKEND} yet; run scripts/deploy-lb.sh first" >&2
    exit 1
  fi
  URL="https://${PUBLIC_HOST}"
  RELAY_URL="https://${PUBLIC_HOST}"
  IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/global/backendServices/${BACKEND_ID}"
  INGRESS="internal-and-cloud-load-balancing"
  IAP_FLAG="--no-iap"
  PROXY_HOPS=2
else
  URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
  RELAY_URL="https://${RELAY_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
  IAP_AUDIENCE="${IAP_AUDIENCE:-/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}}"
  INGRESS="all"
  IAP_FLAG="--iap"
  PROXY_HOPS=1
fi

echo "Building ${IMAGE}"
gcloud builds submit \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="projects/${PROJECT}/serviceAccounts/${BUILDER_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source" \
  --gcs-log-dir="gs://${BUILD_BUCKET}/logs" \
  --ignore-file=.gcloudignore.console \
  --config=plugin/cloudbuild.console.yaml \
  --substitutions="_IMAGE=${IMAGE}" .

DIGEST="$(gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" \
  --format='value(image_summary.digest)')"

CONSOLE_ENV="^;^CONSOLE_MODE=hosted;CONSOLE_PUBLIC_HOST=${URL#https://};IAP_AUDIENCE=${IAP_AUDIENCE};CONSOLE_PROXY_HOPS=${PROXY_HOPS};RELAY_URL=${RELAY_URL};RELAY_TEAM=${TEAM};RELAY_AUTH=metadata"
if [[ -n "${JOIN_REPO_URL:-}" ]]; then
  CONSOLE_ENV="${CONSOLE_ENV};JOIN_REPO_URL=${JOIN_REPO_URL}"
fi

SALT_SECRET="team-relay-console-ip-salt"
SALT_VERSION="$(gcloud secrets versions list "$SALT_SECRET" --project="$PROJECT" \
  --filter='state:ENABLED' --sort-by='~createTime' --limit=1 --format='value(name.basename())')"
if [[ -z "$SALT_VERSION" ]]; then
  echo "error: no enabled version of ${SALT_SECRET}; run scripts/gcp-bootstrap.sh" >&2
  exit 1
fi

echo "Deploying ${SERVICE} (ingress ${INGRESS}, ${IAP_FLAG})"
gcloud beta run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="${IMAGE%:*}@${DIGEST}" \
  --service-account="$CONSOLE_EMAIL" \
  --no-allow-unauthenticated \
  --ingress="$INGRESS" \
  "$IAP_FLAG" \
  --min-instances=0 --max-instances=2 --cpu=1 --memory=256Mi --timeout=60 \
  --update-env-vars="$CONSOLE_ENV" \
  --set-secrets="CONSOLE_IP_HASH_SALT=${SALT_SECRET}:${SALT_VERSION}" \
  --quiet

# IAP invokes the service as its service agent (Cloud Run's IAP, or IAP on the load balancer's
# backend); nothing else may, and anyone-may-invoke is never left on it.
gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:${IAP_AGENT}" --role=roles/run.invoker --quiet >/dev/null
echo "   run.invoker for the IAP service agent: set"
INVOKERS="$(gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
  | sed -n 's/^roles\/run.invoker,//p')"
for member in allUsers allAuthenticatedUsers; do
  if grep -qx "$member" <<<"$INVOKERS"; then
    gcloud run services remove-iam-policy-binding "$SERVICE" --project="$PROJECT" --region="$REGION" \
      --member="$member" --role=roles/run.invoker --quiet >/dev/null
    echo "   run.invoker for ${member}: removed"
  fi
done

if [[ -n "${PUBLIC_HOST:-}" ]]; then
  # IAP's access list and OAuth client live on the backend service (scripts/deploy-lb.sh).
  echo
  # docs/SIGNIN-PAGE.md: the address itself is the relay's sign-in page; the team view is /team.
  echo "Deployed ${SERVICE}: ${URL}/team (through the load balancer; IAP audience ${IAP_AUDIENCE}; ${URL}/ is the sign-in page)"
  exit 0
fi

# Who may pass IAP: any signed-in Google account (M6-SPEC §5). The relay's roster decides
# membership; a non-member sees only the "not on this team" page, and no data.
CURRENT="$(gcloud beta iap web get-iam-policy --project="$PROJECT" --region="$REGION" \
  --resource-type=cloud-run --service="$SERVICE" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
  2>/dev/null | sed -n 's/^roles\/iap.httpsResourceAccessor,//p' | sort -u)"
if grep -qx "allAuthenticatedUsers" <<<"$CURRENT"; then
  echo "   iap access allAuthenticatedUsers: exists"
else
  gcloud beta iap web add-iam-policy-binding --project="$PROJECT" --region="$REGION" \
    --resource-type=cloud-run --service="$SERVICE" --member=allAuthenticatedUsers \
    --role=roles/iap.httpsResourceAccessor --quiet >/dev/null
  echo "   iap access allAuthenticatedUsers: created"
fi
for member in $CURRENT; do
  if [[ "$member" != "allAuthenticatedUsers" ]]; then
    gcloud beta iap web remove-iam-policy-binding --project="$PROJECT" --region="$REGION" \
      --resource-type=cloud-run --service="$SERVICE" --member="$member" \
      --role=roles/iap.httpsResourceAccessor --quiet >/dev/null
    echo "   iap access ${member}: removed (the roster decides now)"
  fi
done

# The custom OAuth client, on this service only.
if [[ -n "${OAUTH_CLIENT_FILE:-}" || -n "${OAUTH_CLIENT_SECRET_FILE:-}" ]]; then
  SETTINGS_DIR="$(mktemp -d)"
  chmod 700 "$SETTINGS_DIR"
  trap 'rm -rf "$SETTINGS_DIR"' EXIT
  python3 scripts/lib/iap_oauth_settings.py "${OAUTH_CLIENT_FILE:-}" "$SETTINGS_DIR/iap_settings.yaml" \
    "${OAUTH_CLIENT_ID:-}" "${OAUTH_CLIENT_SECRET_FILE:-}" >/dev/null
  gcloud beta iap settings set "$SETTINGS_DIR/iap_settings.yaml" --project="$PROJECT" \
    --resource-type=cloud-run --region="$REGION" --service="$SERVICE" --quiet >/dev/null
  rm -rf "$SETTINGS_DIR"
  echo "   custom OAuth client: set on ${SERVICE} only"
fi

echo
echo "Deployed ${SERVICE}: ${URL}"
