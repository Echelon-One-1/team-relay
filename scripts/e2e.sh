#!/usr/bin/env bash
# The M1 end-to-end gate (docs/M1-SPEC.md §9), and the plugin side of the M2 scenarios
# (docs/M2-SPEC.md §6) when the relay serves them. The harness plays Claude Code sessions
# started with the channel, so every channel server it expects to read a stream gets
# TEAM_RELAY_CHANNEL=1 (there is no claude process for it to find); M1 scenario 8 runs a
# working session with TEAM_RELAY_CHANNEL=0 and checks it never reads or acknowledges a stream. Starts a throwaway Firestore emulator
# (Docker, 127.0.0.1:8682, container ma-fs-e2e), writes a throwaway team config for team
# "demo" (alice, bob, carol, each with a fresh random static token stored only as its
# SHA-256), starts the relay on a free 127.0.0.1 port with RELAY_AUTH_MODE=static, builds
# the plugin bundles, runs the e2e vitest suite, and tears everything down on any exit.
# The M2 scenarios (test/e2e/m2.test.ts) run only when the relay answers GET /v1/health and
# GET /v1/teams/demo/activity; otherwise they are skipped and this script says so. They
# include M4 (docs/M4-SPEC.md §2, §3): a permission request's `waiting` tool event shows on
# the activity feed and the next event for that tool follows it, and the answering channel's
# shared folder names come back in the directory.
#
# M5 and M6 (docs/M5-SPEC.md §8, docs/M6-SPEC.md §6): when relay/tests/fake_oauth_app.py is
# there, the relay is started through it instead (the same app, with a fake Google sign-in
# provider on the same 127.0.0.1 port; static tokens still work), the team file names alice
# as the seed owner and gives each member a synthetic Google email, and test/e2e/m5.test.ts
# runs when the relay answers GET /v1/login/start with 400: the whole sign-in through the real
# login tool (no arguments; RELAY_URL names the relay) with a stub browser, confirmed by the
# login_wait tool (and by the status event, in a channel session), streams with the
# stored credential, /team-relay:logout (dist/logout.js), an owner adding
# a member through the console server, the new member signing in and appearing in the
# directory, and removal refusing them within 30 s.
#
# M7 (docs/M7-SPEC.md §4): when the relay answers GET /v1/teams/demo/inbox/summary with 200,
# test/e2e/m7.test.ts runs: a question to a member whose answering session is not running
# produces the waiting notice in their channel working session (nothing reads their inbox
# meanwhile), and is delivered once when their answering session starts.
#
# M8 (docs/M8-SPEC.md §6): test/e2e/m8.test.ts always runs: bob's channel working session
# answers on its own from a throwaway folder, with test/fixtures/stub-claude.mjs standing in for
# the headless answerer (TEAM_RELAY_CLAUDE_BIN; no model is called). A question inside the
# folder is answered automatically; one that needs a read outside it, a flagged draft and a
# capability call each wait until bob approves them in an MCP elicitation dialog (played by the
# test's client); a lapse sends nothing. Each member runs with a config directory of its own (a
# computer of its own: the answering lock is per computer), and the other scenarios' working
# sessions do not answer automatically (TEAM_RELAY_AUTO_ANSWER=0).
#
# M9 (docs/M9-SPEC.md §6, §7): with the fake OAuth launcher the team file also names a relay
# admin (admin@example.com) and an any-team console delegate (a synthetic service account with
# read, manage-roster, manage-teams and member-self), and test/e2e/m9.test.ts runs when the relay serves GET
# /v1/me/teams: a new account creates a team on the sign-in page, invites a member through the
# console server (hosted mode in the test process, the delegate's ID token from the fake
# Google), the member accepts on the chooser and signs in, they exchange a question; the owner
# creates and deletes a second team through the console; an admin deletes the first team
# through the console and both members are refused. Every "owner adds a member, the member
# signs in" step accepts the invitation first (M9-SPEC §7.2). The files run in name order.
# Extra arguments are passed to vitest. The tokens are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMULATOR_PORT=8682
EMULATOR_NAME=ma-fs-e2e
PYTHON="${PYTHON:-$ROOT/relay/.venv/bin/python}"
STARTED=$SECONDS

WORK=""
RELAY_PID=""
EMULATOR_STARTED=0

cleanup() {
  local status=$?
  set +e
  if [[ -n "$RELAY_PID" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill -TERM "$RELAY_PID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 "$RELAY_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$RELAY_PID" 2>/dev/null
    wait "$RELAY_PID" 2>/dev/null
  fi
  if [[ "$status" -ne 0 && -n "$WORK" && -s "$WORK/relay.log" ]]; then
    # The relay logs no tokens (M1-SPEC §2); its log helps with a failure.
    echo "e2e: last lines of the relay log:" >&2
    tail -n 40 "$WORK/relay.log" >&2
  fi
  if [[ "$EMULATOR_STARTED" -eq 1 ]]; then
    "$ROOT/scripts/emulator.sh" stop "$EMULATOR_NAME" || true
  fi
  if [[ -n "$WORK" ]]; then
    rm -rf "$WORK"
  fi
  echo "e2e: $([[ "$status" -eq 0 ]] && echo passed || echo FAILED) in $((SECONDS - STARTED)) s" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in docker openssl curl pnpm; do
  command -v "$tool" >/dev/null || { echo "e2e: $tool is required" >&2; exit 1; }
done
[[ -x "$PYTHON" ]] || { echo "e2e: no relay venv at $PYTHON (see relay/README.md)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ma-e2e.XXXXXX")"
chmod 700 "$WORK"

# Throwaway identities: a random token per member, only its hash goes into the config.
new_token() { openssl rand -hex 24; }
sha256() { printf %s "$1" | openssl dgst -sha256 -r | cut -d' ' -f1; }
TOKEN_ALICE="$(new_token)"
TOKEN_BOB="$(new_token)"
TOKEN_CAROL="$(new_token)"
FAKE_OAUTH=0
[[ -f "$ROOT/relay/tests/fake_oauth_app.py" ]] && FAKE_OAUTH=1
if [[ "$FAKE_OAUTH" -eq 1 ]]; then
  # M6-SPEC §1: the seed owner is alice; the Google emails are synthetic (example.com).
  cat >"$WORK/team.yaml" <<EOF
teams:
  - id: demo
    members:
      - id: alice
        role: owner
        principals: ["token:sha256:$(sha256 "$TOKEN_ALICE")", "google:alice@example.com"]
      - id: bob
        principals: ["token:sha256:$(sha256 "$TOKEN_BOB")", "google:bob@example.com"]
      - id: carol
        principals: ["token:sha256:$(sha256 "$TOKEN_CAROL")", "google:carol@example.com"]
# M9: a relay admin and the hosted console's any-team delegate (synthetic identities).
admins: ["google:admin@example.com"]
delegates:
  - principal: "google:team-relay-console@e2e-project.iam.gserviceaccount.com"
    team: "*"
    scope: [read, manage-roster, manage-teams, member-self]
limits:
  min_ack_timeout_seconds: 2
  min_answer_timeout_seconds: 2
  # The M2 scenarios poll /activity and /directory in tight loops (M2-SPEC §7.3's budget is
  # 120 a minute by default; the relay allows up to 10000).
  reads_per_minute: 10000
  login_starts_per_minute: 1000
  login_pages_per_minute: 1000
  login_tokens_per_minute: 1000
EOF
else
  cat >"$WORK/team.yaml" <<EOF
teams:
  - id: demo
    members:
      - id: alice
        principals: ["token:sha256:$(sha256 "$TOKEN_ALICE")"]
      - id: bob
        principals: ["token:sha256:$(sha256 "$TOKEN_BOB")"]
      - id: carol
        principals: ["token:sha256:$(sha256 "$TOKEN_CAROL")"]
limits:
  min_ack_timeout_seconds: 2
  min_answer_timeout_seconds: 2
  reads_per_minute: 10000
EOF
fi

EMULATOR_STARTED=1
FIRESTORE_HOST="$("$ROOT/scripts/emulator.sh" start "$EMULATOR_PORT" "$EMULATOR_NAME")"

RELAY_PORT="$("$PYTHON" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
RELAY_URL="http://127.0.0.1:${RELAY_PORT}"

# The tokens are shell variables, not exported, so the relay's environment never holds them.
if [[ "$FAKE_OAUTH" -eq 1 ]]; then
  RELAY_MODULE=(-m tests.fake_oauth_app --port "$RELAY_PORT")
else
  RELAY_MODULE=(-m relay)
fi
(
  cd "$ROOT/relay"
  exec env -u K_SERVICE \
    RELAY_AUTH_MODE=static \
    RELAY_TEAM_CONFIG="$WORK/team.yaml" \
    RELAY_HOST=127.0.0.1 \
    PORT="$RELAY_PORT" \
    FIRESTORE_EMULATOR_HOST="$FIRESTORE_HOST" \
    GOOGLE_CLOUD_PROJECT=demo-e2e \
    RELAY_LOG_LEVEL=warning \
    "$PYTHON" "${RELAY_MODULE[@]}"
) >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!

echo "e2e: waiting for the relay on $RELAY_URL" >&2
ready=0
for _ in $(seq 1 150); do
  if [[ "$(curl -s --max-time 2 "$RELAY_URL/healthz" || true)" == '{"ok":true}' ]]; then
    ready=1
    break
  fi
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "e2e: the relay exited during startup" >&2; exit 1; }
  sleep 0.2
done
[[ "$ready" -eq 1 ]] || { echo "e2e: the relay did not become ready" >&2; exit 1; }
echo "e2e: relay ready" >&2

# Does the relay serve M2 (docs/M2-SPEC.md §1 /v1/health, §3.5 /activity)? The probe's bearer
# header goes through a mode-600 file, never the command line.
E2E_M2=0
health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RELAY_URL/v1/health" || true)"
printf 'Authorization: Bearer %s\n' "$TOKEN_ALICE" >"$WORK/probe.header"
chmod 600 "$WORK/probe.header"
activity="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H @"$WORK/probe.header" "$RELAY_URL/v1/teams/demo/activity?limit=1" || true)"
# M7-SPEC §1: a peek; it moves no cursor and writes no presence.
inbox_summary="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H @"$WORK/probe.header" "$RELAY_URL/v1/teams/demo/inbox/summary" || true)"
rm -f "$WORK/probe.header"
if [[ "$health" == "200" && "$activity" == "200" ]]; then
  E2E_M2=1
  echo "e2e: the relay serves /v1/health and /activity: running the M1 and M2 scenarios" >&2
else
  echo "e2e: SKIPPING the M2 scenarios: the relay does not serve them yet (GET /v1/health: $health, GET /activity: $activity); running the M1 scenarios only" >&2
fi

# Does the relay serve M5 (docs/M5-SPEC.md §5: /v1/login/start without params is 400)?
E2E_M5=0
login_start="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RELAY_URL/v1/login/start" || true)"
if [[ "$FAKE_OAUTH" -eq 1 && "$login_start" == "400" ]]; then
  E2E_M5=1
  echo "e2e: the relay serves the login flow with a fake Google: running the M5 and M6 scenarios" >&2
else
  echo "e2e: SKIPPING the M5 and M6 scenarios (fake OAuth launcher: $FAKE_OAUTH, GET /v1/login/start: $login_start)" >&2
fi

# Does the relay serve M9 (docs/M9-SPEC.md §2: GET /v1/me/teams needs a Google identity, so
# without one it is 401, not 404)?
E2E_M9=0
me_teams="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$RELAY_URL/v1/me/teams" || true)"
if [[ "$E2E_M5" -eq 1 && "$me_teams" == "401" ]]; then
  E2E_M9=1
  echo "e2e: the relay serves teams anyone can create: running the M9 scenario" >&2
else
  echo "e2e: SKIPPING the M9 scenario (fake OAuth: $E2E_M5, GET /v1/me/teams: $me_teams)" >&2
fi

E2E_M7=0
if [[ "$inbox_summary" == "200" ]]; then
  E2E_M7=1
  echo "e2e: the relay serves the inbox summary: running the M7 scenario" >&2
else
  echo "e2e: SKIPPING the M7 scenario (GET /inbox/summary: $inbox_summary)" >&2
fi

pnpm -C "$ROOT/plugin" build

export RELAY_URL E2E=1 E2E_M2 E2E_M5 E2E_M7 E2E_M9
export E2E_TOKEN_ALICE="$TOKEN_ALICE" E2E_TOKEN_BOB="$TOKEN_BOB" E2E_TOKEN_CAROL="$TOKEN_CAROL"
pnpm -C "$ROOT/plugin" test:e2e "$@"
