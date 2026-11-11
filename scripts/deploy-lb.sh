#!/usr/bin/env bash
# One address for the relay and the hosted console (docs/M10-SPEC.md §5): a global external
# Application Load Balancer on a reserved static IP with a Google-managed certificate for
# PUBLIC_HOST, two serverless NEGs (relay, console), and:
#   https://PUBLIC_HOST/ and /login       -> the relay: the public sign-in page (docs/SIGNIN-PAGE.md),
#                                            whose button leads to /start on the console
#   https://PUBLIC_HOST/v1/*, /healthz, /setup -> the relay (no IAP: the relay signs people in
#                                         itself; /setup is the public setup script, M11-SPEC §5)
#   https://PUBLIC_HOST/<everything else>  -> the console (IAP, custom OAuth client, IAP_ACCESS):
#                                            /start, /team, /join, /ask, /admin, /api/*, assets
#   http://PUBLIC_HOST/*                 -> a redirect to https
#   any other Host (the bare IP, ...)    -> a redirect to https://PUBLIC_HOST
# The path matcher uses route rules (exact paths and one prefix, in priority order) and the map
# carries tests, which Google checks on every import: a map that would send a path elsewhere is
# refused before it takes effect.
# Idempotent: every step checks first and prints `exists`, `created` or `updated`; a re-run
# changes nothing that is already right. Nothing secret is written to a file that outlives the
# run, and nothing secret is printed.
#
# Order: scripts/gcp-bootstrap.sh, this script, then scripts/deploy.sh and
# scripts/deploy-console.sh with PUBLIC_HOST set (they set ingress to
# internal-and-cloud-load-balancing, so the run.app URLs answer nothing from outside, and the
# console reads the IAP audience of the backend made here). The NEGs name the Cloud Run
# services and may be made before the services exist.
#
# Usage: PUBLIC_HOST=team.example.com IAP_ACCESS=domain:example.com \
#          OAUTH_CLIENT_FILE=~/Downloads/client_secret_....json bash scripts/deploy-lb.sh
#        (or OAUTH_CLIENT_ID=<id> OAUTH_CLIENT_SECRET_FILE=<file holding only the secret>)
#
# IAP_ACCESS (required): who may pass IAP to the console, comma-separated: domain:<domain>,
# group:<email>, user:<email>, or allAuthenticatedUsers (any Google account; the roster still
# decides who sees data). allUsers is refused. Members not listed are removed on each run.
# Without an OAuth client given, IAP keeps the client it has; on a backend never given one,
# IAP uses Google's managed client, which admits only accounts of the project's organisation.
#
# Run the gcloud-auth-refresh skill before this; an expired token fails these silently.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -f config/deploy.local.env ]]; then
  # shellcheck disable=SC1091
  source config/deploy.local.env
fi
PROJECT="${PROJECT:?set PROJECT in config/deploy.local.env or the environment}"
REGION="${REGION:-australia-southeast1}"
PUBLIC_HOST="${PUBLIC_HOST:?set PUBLIC_HOST (the relay and console address, e.g. team.example.com)}"
IAP_ACCESS="${IAP_ACCESS:?set IAP_ACCESS (who may reach the console through IAP, e.g. domain:example.com)}"

RELAY_SERVICE="team-relay"
CONSOLE_SERVICE="team-relay-console"
IP_NAME="team-relay-ip"
RELAY_NEG="team-relay-neg"
CONSOLE_NEG="team-relay-console-neg"
RELAY_BACKEND="team-relay-backend"
CONSOLE_BACKEND="team-relay-console-backend"
URL_MAP="team-relay-map"
REDIRECT_MAP="team-relay-http-redirect"
SSL_POLICY="team-relay-tls"
HTTPS_PROXY="team-relay-https-proxy"
HTTP_PROXY="team-relay-http-proxy"
HTTPS_RULE="team-relay-https"
HTTP_RULE="team-relay-http"
# HSTS for this host only (no includeSubDomains: other hosts under the domain are not ours).
HSTS="Strict-Transport-Security: max-age=31536000"

if [[ ! "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
    || [[ ${#PUBLIC_HOST} -gt 253 ]]; then
  echo "error: PUBLIC_HOST must be a lower-case host name, without a scheme, port or path" >&2
  exit 1
fi
# A managed certificate's domains cannot change: its name follows the host it is for.
CERT_NAME="team-relay-cert-$(printf '%s' "$PUBLIC_HOST" | shasum -a 256 | cut -c1-10)"

# IAP_ACCESS: checked, then sorted and de-duplicated.
WANTED_ACCESS=""
IFS=',' read -r -a ACCESS_ITEMS <<<"$IAP_ACCESS"
for item in "${ACCESS_ITEMS[@]}"; do
  item="$(printf '%s' "$item" | tr -d '[:space:]')"
  [[ -z "$item" ]] && continue
  if [[ "$item" == "allUsers" ]]; then
    echo "error: IAP_ACCESS must not be allUsers: the console is for signed-in team members" >&2
    exit 1
  fi
  if [[ ! "$item" =~ ^(domain:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?|(group|user):[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}|allAuthenticatedUsers)$ ]]; then
    echo "error: IAP_ACCESS entries are domain:<domain>, group:<email>, user:<email> or allAuthenticatedUsers" >&2
    exit 1
  fi
  WANTED_ACCESS="$(printf '%s\n%s' "$WANTED_ACCESS" "$item")"
done
WANTED_ACCESS="$(printf '%s\n' "$WANTED_ACCESS" | sed '/^$/d' | sort -u)"
if [[ -z "$WANTED_ACCESS" ]]; then
  echo "error: IAP_ACCESS names no one" >&2
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BACKEND_URL_PREFIX="https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/backendServices"

echo "project=${PROJECT} region=${REGION} host=${PUBLIC_HOST}"
echo

ENABLED="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)')"
# compute: everything below; cloudresourcemanager: the IAP access step (M11-SPEC §7).
for api in compute.googleapis.com cloudresourcemanager.googleapis.com; do
  if ! grep -qx "$api" <<<"$ENABLED"; then
    echo "error: ${api} is not enabled; run scripts/gcp-bootstrap.sh" >&2
    exit 1
  fi
done

# ------------------------------------------------------------- 1. address
echo "1. address"
if gcloud compute addresses describe "$IP_NAME" --global --project="$PROJECT" >/dev/null 2>&1; then
  echo "   ${IP_NAME}: exists"
else
  gcloud compute addresses create "$IP_NAME" --global --ip-version=IPV4 \
    --network-tier=PREMIUM --project="$PROJECT" --quiet >/dev/null
  echo "   ${IP_NAME}: created"
fi
IP="$(gcloud compute addresses describe "$IP_NAME" --global --project="$PROJECT" --format='value(address)')"

# ------------------------------------------------------------- 2. certificate
echo "2. certificate"
if gcloud compute ssl-certificates describe "$CERT_NAME" --global --project="$PROJECT" >/dev/null 2>&1; then
  echo "   ${CERT_NAME} (${PUBLIC_HOST}): exists"
else
  gcloud compute ssl-certificates create "$CERT_NAME" --global --domains="$PUBLIC_HOST" \
    --project="$PROJECT" --quiet >/dev/null
  echo "   ${CERT_NAME} (${PUBLIC_HOST}): created"
fi

# TLS 1.2 and up, modern ciphers only.
if gcloud compute ssl-policies describe "$SSL_POLICY" --global --project="$PROJECT" >/dev/null 2>&1; then
  current="$(gcloud compute ssl-policies describe "$SSL_POLICY" --global --project="$PROJECT" \
    --format='value(profile,minTlsVersion)')"
  if [[ "$current" == $'MODERN\tTLS_1_2' ]]; then
    echo "   ssl policy ${SSL_POLICY}: exists"
  else
    gcloud compute ssl-policies update "$SSL_POLICY" --global --profile=MODERN \
      --min-tls-version=1.2 --project="$PROJECT" --quiet >/dev/null
    echo "   ssl policy ${SSL_POLICY}: updated"
  fi
else
  gcloud compute ssl-policies create "$SSL_POLICY" --global --profile=MODERN \
    --min-tls-version=1.2 --project="$PROJECT" --quiet >/dev/null
  echo "   ssl policy ${SSL_POLICY}: created"
fi

# ------------------------------------------------------------- 3. serverless NEGs
echo "3. serverless NEGs"
for pair in "${RELAY_NEG}:${RELAY_SERVICE}" "${CONSOLE_NEG}:${CONSOLE_SERVICE}"; do
  neg="${pair%%:*}"
  service="${pair#*:}"
  if gcloud compute network-endpoint-groups describe "$neg" --region="$REGION" \
      --project="$PROJECT" >/dev/null 2>&1; then
    points="$(gcloud compute network-endpoint-groups describe "$neg" --region="$REGION" \
      --project="$PROJECT" --format='value(cloudRun.service)')"
    if [[ "$points" != "$service" ]]; then
      echo "error: NEG ${neg} points at '${points}', not ${service}; NEGs cannot change: delete it and re-run" >&2
      exit 1
    fi
    echo "   ${neg} -> ${service}: exists"
  else
    gcloud compute network-endpoint-groups create "$neg" --region="$REGION" \
      --network-endpoint-type=serverless --cloud-run-service="$service" \
      --project="$PROJECT" --quiet >/dev/null
    echo "   ${neg} -> ${service}: created"
  fi
done

# ------------------------------------------------------------- 4. backend services
echo "4. backend services"
for pair in "${RELAY_BACKEND}:${RELAY_NEG}" "${CONSOLE_BACKEND}:${CONSOLE_NEG}"; do
  backend="${pair%%:*}"
  neg="${pair#*:}"
  if gcloud compute backend-services describe "$backend" --global --project="$PROJECT" >/dev/null 2>&1; then
    echo "   ${backend}: exists"
  else
    gcloud compute backend-services create "$backend" --global \
      --load-balancing-scheme=EXTERNAL_MANAGED --project="$PROJECT" --quiet >/dev/null
    echo "   ${backend}: created"
  fi
  groups="$(gcloud compute backend-services describe "$backend" --global --project="$PROJECT" \
    --format='value(backends[].group)')"
  if grep -q "/regions/${REGION}/networkEndpointGroups/${neg}\$" <<<"$(tr ';' '\n' <<<"$groups")"; then
    echo "   ${backend} <- ${neg}: exists"
  else
    gcloud compute backend-services add-backend "$backend" --global \
      --network-endpoint-group="$neg" --network-endpoint-group-region="$REGION" \
      --project="$PROJECT" --quiet >/dev/null
    echo "   ${backend} <- ${neg}: created"
  fi
  headers="$(gcloud compute backend-services describe "$backend" --global --project="$PROJECT" \
    --format='value(customResponseHeaders)')"
  if [[ "$headers" == "$HSTS" ]]; then
    echo "   ${backend} HSTS: exists"
  else
    gcloud compute backend-services update "$backend" --global \
      --custom-response-header="$HSTS" --project="$PROJECT" --quiet >/dev/null
    echo "   ${backend} HSTS: updated"
  fi
done

# ------------------------------------------------------------- 5. IAP (console only)
echo "5. IAP"
# The relay has no IAP: its sign-in pages must be reachable before anyone is signed in, and it
# authenticates every API call itself.
relay_iap="$(gcloud compute backend-services describe "$RELAY_BACKEND" --global --project="$PROJECT" \
  --format='value(iap.enabled)')"
if [[ "$relay_iap" == "True" ]]; then
  gcloud compute backend-services update "$RELAY_BACKEND" --global --iap=disabled \
    --project="$PROJECT" --quiet >/dev/null
  echo "   ${RELAY_BACKEND}: IAP disabled (updated)"
else
  echo "   ${RELAY_BACKEND}: no IAP (exists)"
fi

# The custom OAuth client first, so IAP never runs on this backend with another one.
if [[ -n "${OAUTH_CLIENT_FILE:-}" || -n "${OAUTH_CLIENT_SECRET_FILE:-}" ]]; then
  SETTINGS_DIR="$(mktemp -d)"
  chmod 700 "$SETTINGS_DIR"
  trap 'rm -rf "$SETTINGS_DIR"' EXIT
  WANTED_CLIENT="$(python3 scripts/lib/iap_oauth_settings.py "${OAUTH_CLIENT_FILE:-}" \
    "$SETTINGS_DIR/iap_settings.yaml" "${OAUTH_CLIENT_ID:-}" "${OAUTH_CLIENT_SECRET_FILE:-}")"
  CURRENT_CLIENT="$(gcloud iap settings get --project="$PROJECT" --resource-type=backend-services \
    --service="$CONSOLE_BACKEND" --format='value(accessSettings.oauthSettings.clientId)' 2>/dev/null || true)"
  if [[ "$CURRENT_CLIENT" == "$WANTED_CLIENT" ]]; then
    echo "   custom OAuth client on ${CONSOLE_BACKEND}: exists"
  else
    gcloud iap settings set "$SETTINGS_DIR/iap_settings.yaml" --project="$PROJECT" \
      --resource-type=backend-services --service="$CONSOLE_BACKEND" --quiet >/dev/null
    echo "   custom OAuth client on ${CONSOLE_BACKEND}: set"
  fi
  rm -rf "$SETTINGS_DIR"
  trap - EXIT
  unset WANTED_CLIENT CURRENT_CLIENT
else
  echo "   custom OAuth client: unchanged (set OAUTH_CLIENT_FILE to set it)"
fi

console_iap="$(gcloud compute backend-services describe "$CONSOLE_BACKEND" --global --project="$PROJECT" \
  --format='value(iap.enabled)')"
if [[ "$console_iap" == "True" ]]; then
  echo "   ${CONSOLE_BACKEND}: IAP exists"
else
  gcloud compute backend-services update "$CONSOLE_BACKEND" --global --iap=enabled \
    --project="$PROJECT" --quiet >/dev/null
  echo "   ${CONSOLE_BACKEND}: IAP enabled (created)"
fi

# Who may pass IAP: exactly IAP_ACCESS.
CURRENT_ACCESS="$(gcloud iap web get-iam-policy --project="$PROJECT" \
  --resource-type=backend-services --service="$CONSOLE_BACKEND" \
  --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' \
  2>/dev/null | sed -n 's/^roles\/iap.httpsResourceAccessor,//p' | sort -u)"
while IFS= read -r member; do
  [[ -z "$member" ]] && continue
  if grep -qxF "$member" <<<"$CURRENT_ACCESS"; then
    echo "   iap access ${member}: exists"
  else
    gcloud iap web add-iam-policy-binding --project="$PROJECT" \
      --resource-type=backend-services --service="$CONSOLE_BACKEND" --member="$member" \
      --role=roles/iap.httpsResourceAccessor --condition=None --quiet >/dev/null
    echo "   iap access ${member}: created"
  fi
done <<<"$WANTED_ACCESS"
while IFS= read -r member; do
  [[ -z "$member" ]] && continue
  if ! grep -qxF "$member" <<<"$WANTED_ACCESS"; then
    gcloud iap web remove-iam-policy-binding --project="$PROJECT" \
      --resource-type=backend-services --service="$CONSOLE_BACKEND" --member="$member" \
      --role=roles/iap.httpsResourceAccessor --condition=None --quiet >/dev/null
    echo "   iap access ${member}: removed (not in IAP_ACCESS)"
  fi
done <<<"$CURRENT_ACCESS"

# ------------------------------------------------------------- 6. URL maps
echo "6. URL maps"
MAP_DIR="$(mktemp -d)"
trap 'rm -rf "$MAP_DIR"' EXIT
# Written as JSON, which `url-maps import` reads as the YAML it is.
# The HTTPS map: the relay's paths, the console for the rest, other hosts redirected to ours.
# Route rules, not path rules (a path matcher holds one kind or the other): "/" alone must go to
# the relay while every other path without a rule goes to the console. The tests pin both sides.
cat > "$MAP_DIR/${URL_MAP}.json" <<JSON
{
  "name": "${URL_MAP}",
  "defaultUrlRedirect": {"hostRedirect": "${PUBLIC_HOST}", "httpsRedirect": true,
                         "redirectResponseCode": "MOVED_PERMANENTLY_DEFAULT", "stripQuery": false},
  "hostRules": [{"hosts": ["${PUBLIC_HOST}"], "pathMatcher": "team-relay"}],
  "pathMatchers": [{
    "name": "team-relay",
    "defaultService": "${BACKEND_URL_PREFIX}/${CONSOLE_BACKEND}",
    "routeRules": [
      {"priority": 1, "matchRules": [{"fullPathMatch": "/"}], "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
      {"priority": 2, "matchRules": [{"fullPathMatch": "/login"}], "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
      {"priority": 3, "matchRules": [{"prefixMatch": "/v1/"}], "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
      {"priority": 4, "matchRules": [{"fullPathMatch": "/healthz"}], "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
      {"priority": 5, "matchRules": [{"fullPathMatch": "/setup"}], "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"}
    ]
  }],
  "tests": [
    {"host": "${PUBLIC_HOST}", "path": "/", "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/login", "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/v1/health", "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/setup", "service": "${BACKEND_URL_PREFIX}/${RELAY_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/start", "service": "${BACKEND_URL_PREFIX}/${CONSOLE_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/join", "service": "${BACKEND_URL_PREFIX}/${CONSOLE_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/team", "service": "${BACKEND_URL_PREFIX}/${CONSOLE_BACKEND}"},
    {"host": "${PUBLIC_HOST}", "path": "/login/", "service": "${BACKEND_URL_PREFIX}/${CONSOLE_BACKEND}"}
  ]
}
JSON
# Port 80: every request to https, same host and path.
cat > "$MAP_DIR/${REDIRECT_MAP}.json" <<JSON
{
  "name": "${REDIRECT_MAP}",
  "defaultUrlRedirect": {"httpsRedirect": true, "redirectResponseCode": "MOVED_PERMANENTLY_DEFAULT",
                         "stripQuery": false}
}
JSON

# The parts of a URL map this script owns, normalised, for comparing what is with what is wanted.
map_digest() {  # stdin: a URL map as JSON
  python3 -c '
import json, sys
m = json.load(sys.stdin)
def tidy(v):
    if isinstance(v, dict):
        return {k: tidy(x) for k, x in sorted(v.items()) if x not in (None, False, [], {}, "")}
    if isinstance(v, list):
        return [tidy(x) for x in v]
    return v
print(json.dumps(tidy({k: m.get(k) for k in ("defaultService", "defaultUrlRedirect", "hostRules", "pathMatchers", "tests")}), sort_keys=True))
'
}

for map in "$URL_MAP" "$REDIRECT_MAP"; do
  wanted="$(map_digest < "$MAP_DIR/${map}.json")"
  if gcloud compute url-maps describe "$map" --global --project="$PROJECT" >/dev/null 2>&1; then
    current="$(gcloud compute url-maps describe "$map" --global --project="$PROJECT" --format=json | map_digest)"
    if [[ "$current" == "$wanted" ]]; then
      echo "   ${map}: exists"
      continue
    fi
    verb="updated"
  else
    verb="created"
  fi
  gcloud compute url-maps import "$map" --global --source="$MAP_DIR/${map}.json" \
    --project="$PROJECT" --quiet >/dev/null
  echo "   ${map}: ${verb}"
done
rm -rf "$MAP_DIR"
trap - EXIT

# ------------------------------------------------------------- 7. proxies and forwarding rules
echo "7. proxies and forwarding rules"
if gcloud compute target-https-proxies describe "$HTTPS_PROXY" --global --project="$PROJECT" >/dev/null 2>&1; then
  current="$(gcloud compute target-https-proxies describe "$HTTPS_PROXY" --global --project="$PROJECT" \
    --format='value(urlMap.basename(),sslCertificates.map().basename().list(),sslPolicy.basename())')"
  if [[ "$current" == "${URL_MAP}"$'\t'"${CERT_NAME}"$'\t'"${SSL_POLICY}" ]]; then
    echo "   ${HTTPS_PROXY}: exists"
  else
    gcloud compute target-https-proxies update "$HTTPS_PROXY" --global --url-map="$URL_MAP" \
      --ssl-certificates="$CERT_NAME" --ssl-policy="$SSL_POLICY" --project="$PROJECT" --quiet >/dev/null
    echo "   ${HTTPS_PROXY}: updated"
  fi
else
  gcloud compute target-https-proxies create "$HTTPS_PROXY" --global --url-map="$URL_MAP" \
    --ssl-certificates="$CERT_NAME" --ssl-policy="$SSL_POLICY" --project="$PROJECT" --quiet >/dev/null
  echo "   ${HTTPS_PROXY}: created"
fi
if gcloud compute target-http-proxies describe "$HTTP_PROXY" --global --project="$PROJECT" >/dev/null 2>&1; then
  current="$(gcloud compute target-http-proxies describe "$HTTP_PROXY" --global --project="$PROJECT" \
    --format='value(urlMap.basename())')"
  if [[ "$current" == "$REDIRECT_MAP" ]]; then
    echo "   ${HTTP_PROXY}: exists"
  else
    gcloud compute target-http-proxies update "$HTTP_PROXY" --global --url-map="$REDIRECT_MAP" \
      --project="$PROJECT" --quiet >/dev/null
    echo "   ${HTTP_PROXY}: updated"
  fi
else
  gcloud compute target-http-proxies create "$HTTP_PROXY" --global --url-map="$REDIRECT_MAP" \
    --project="$PROJECT" --quiet >/dev/null
  echo "   ${HTTP_PROXY}: created"
fi

for spec in "${HTTPS_RULE}:443:target-https-proxy:${HTTPS_PROXY}" "${HTTP_RULE}:80:target-http-proxy:${HTTP_PROXY}"; do
  IFS=':' read -r rule port kind proxy <<<"$spec"
  if gcloud compute forwarding-rules describe "$rule" --global --project="$PROJECT" >/dev/null 2>&1; then
    current="$(gcloud compute forwarding-rules describe "$rule" --global --project="$PROJECT" \
      --format='value(IPAddress,portRange,target.basename())')"
    if [[ "$current" == "${IP}"$'\t'"${port}-${port}"$'\t'"${proxy}" ]]; then
      echo "   ${rule} (${IP}:${port}): exists"
    else
      # A forwarding rule's address and ports cannot change in place; its target can.
      if [[ "$(cut -f1,2 <<<"$current")" != "${IP}"$'\t'"${port}-${port}" ]]; then
        echo "error: forwarding rule ${rule} is on $(cut -f1,2 <<<"$current" | tr '\t' ' '), not ${IP} ${port}; delete it and re-run" >&2
        exit 1
      fi
      gcloud compute forwarding-rules set-target "$rule" --global "--${kind}=${proxy}" \
        --project="$PROJECT" --quiet >/dev/null
      echo "   ${rule} (${IP}:${port}): updated"
    fi
  else
    gcloud compute forwarding-rules create "$rule" --global \
      --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM --address="$IP_NAME" \
      "--${kind}=${proxy}" --ports="$port" --project="$PROJECT" --quiet >/dev/null
    echo "   ${rule} (${IP}:${port}): created"
  fi
done

# ------------------------------------------------------------- 8. what is left to do
CONSOLE_BACKEND_ID="$(gcloud compute backend-services describe "$CONSOLE_BACKEND" --global \
  --project="$PROJECT" --format='value(id)')"
CERT_STATUS="$(gcloud compute ssl-certificates describe "$CERT_NAME" --global --project="$PROJECT" \
  --format='value(managed.status)')"
LABEL="${PUBLIC_HOST%%.*}"
ZONE="${PUBLIC_HOST#*.}"
echo
echo "Load balancer ready on ${IP}. Certificate ${CERT_NAME}: ${CERT_STATUS:-unknown}."
echo
echo "DNS: in the zone ${ZONE}, add exactly one record (the certificate goes ACTIVE once it resolves, up to an hour):"
echo "   ${LABEL}   A   ${IP}   TTL 600"
echo "   check with: dig +short ${PUBLIC_HOST} A"
echo
echo "The console's IAP audience: /projects/${PROJECT_NUMBER}/global/backendServices/${CONSOLE_BACKEND_ID}"
echo "Next, with PUBLIC_HOST=${PUBLIC_HOST} in config/deploy.local.env:"
echo "   bash scripts/deploy.sh && bash scripts/deploy-console.sh"
echo "The relay's Web OAuth client needs the redirect URI https://${PUBLIC_HOST}/v1/login/callback, and,"
echo "for IAP, https://iap.googleapis.com/v1/oauth/clientIds/<client id>:handleRedirect."
