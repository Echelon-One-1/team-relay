#!/usr/bin/env bash
# Tests for relay/relay/static/setup.sh (docs/M11-SPEC.md §5), run as `bash
# scripts/tests/setup-script.test.sh` locally and in CI. No network, no real Claude Code: each case
# gets a throwaway HOME and a PATH holding only stubs (uname, node, claude, curl, bash) that log
# every call to a file, with what each call read on stdin. Questions come from a file standing in
# for the terminal (TEAM_RELAY_SETUP_TTY). The script is fed to /bin/bash through a pipe, as
# `curl ... | bash` does, so a command that read the script's stdin would show up here.
# Needs node (the stub hands `node -e` to the real one) and a POSIX /bin/sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/relay/relay/static/setup.sh"
BASH_BIN=/bin/bash
REAL_NODE="$(command -v node || true)"
if [[ -z "$REAL_NODE" ]]; then
  echo "setup-script test: node is needed to run these tests" >&2
  exit 1
fi
RELAY="https://relay.example.com"
REPO="example-org/team-relay"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILLED="$WORK/setup.filled.sh"
sed -e "s#__RELAY_URL__#${RELAY}#" -e "s#__MARKETPLACE__#${REPO}#" "$SCRIPT" >"$FILLED"

passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
check() {  # NAME TEST...: ok when the test command succeeds, else FAIL with the log
  local name="$1"
  shift
  if "$@"; then ok "$name"; else not_ok "$name" "$LOG"; fi
}
log_lacks() { [[ "$LOG" != *"$1"* ]]; }
not_ok() {
  failed=$((failed + 1))
  printf 'FAIL %s\n' "$1"
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" | sed 's/^/     /'; fi
}

# new_case NAME [no-node] [no-claude]: a HOME, a stub bin directory, a log, a tty file.
new_case() {
  C="$WORK/$1"
  mkdir -p "$C/bin" "$C/home/.claude/plugins" "$C/home/.local/bin" "$C/state" "$C/plugin/dist"
  : >"$C/log"
  printf 'TTY-MARK\n' >"$C/tty"
  : >"$C/plugin/dist/setup-cli.js"
  ln -s "$BASH_BIN" "$C/bin/bash"
  cat >"$C/bin/uname" <<EOF
#!/bin/sh
cat_os() { if [ -f "$C/state/uname" ]; then IFS= read -r os <"$C/state/uname"; echo "\$os"; else echo Darwin; fi; }
cat_os
EOF
  if [[ "${2:-}" != "no-node" ]]; then
    cat >"$C/bin/node" <<EOF
#!/bin/sh
case "\$1" in
  --version)
    if [ -f "$C/state/node-version" ]; then IFS= read -r v <"$C/state/node-version"; else v=v22.12.0; fi
    printf 'node --version\n' >>"$C/log"
    echo "\$v" ;;
  -e) exec "$REAL_NODE" "\$@" ;;
  *)
    shift
    IFS= read -r input || input=""
    printf 'setup-cli %s <%s>\n' "\$*" "\$input" >>"$C/log"
    if [ "\$1" = drive ] && [ -f "$C/state/drive-fails" ]; then echo "drive stub: did not connect"; exit 1; fi ;;
esac
EOF
  fi
  cat >"$C/claude-stub" <<EOF
#!/bin/sh
IFS= read -r input || input=""
printf 'claude %s <%s>\n' "\$*" "\$input" >>"$C/log"
case "\$*" in
  "auth status --json")
    if [ -f "$C/state/logged-in" ]; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; exit 1; fi ;;
  "auth login") : >"$C/state/logged-in" ;;
  "plugin marketplace list --json")
    if [ -f "$C/state/marketplace" ]; then
      echo '[{"name":"other","source":"github","repo":"someone/else"},{"name":"team-relay-dev","source":"github","repo":"${REPO}"}]'
    else
      echo '[{"name":"other","source":"github","repo":"someone/else"}]'
    fi ;;
  "plugin marketplace add ${REPO}") : >"$C/state/marketplace" ;;
  "plugin marketplace update team-relay-dev") ;;
  "plugin list --json")
    if [ -f "$C/state/installed" ]; then echo '[{"id":"team-relay@team-relay-dev"}]'; else echo '[]'; fi ;;
  "plugin install team-relay@team-relay-dev")
    : >"$C/state/installed"
    if [ -f "$C/state/installed-json" ]; then
      /bin/cp "$C/state/installed-json" "$C/home/.claude/plugins/installed_plugins.json"
    else
      printf '{"version":2,"plugins":{"team-relay@team-relay-dev":[{"scope":"user","installPath":"%s"}]}}' "$C/plugin" \
        >"$C/home/.claude/plugins/installed_plugins.json"
    fi ;;
  "plugin update team-relay@team-relay-dev") ;;
  *) echo "claude stub: unexpected call: \$*" >&2; exit 3 ;;
esac
EOF
  chmod +x "$C/bin/uname" "$C/claude-stub"
  [[ -f "$C/bin/node" ]] && chmod +x "$C/bin/node"
  if [[ "${3:-}" != "no-claude" ]]; then
    ln -s "$C/claude-stub" "$C/bin/claude"
  fi
  # The official installer, stubbed: logs, and puts claude where the real one goes.
  cat >"$C/bin/curl" <<EOF
#!/bin/sh
printf 'curl %s\n' "\$*" >>"$C/log"
echo '/bin/ln -s "$C/claude-stub" "$C/home/.local/bin/claude"'
EOF
  chmod +x "$C/bin/curl"
}

# run_case SCRIPT: runs it as `curl | bash` would, with only the stubs on PATH.
run_case() {
  set +e
  OUT="$(/bin/cat "$1" | env -i HOME="$C/home" PATH="$C/bin" TEAM_RELAY_SETUP_TTY="${TTY_OVERRIDE:-$C/tty}" \
    "$BASH_BIN" 2>&1)"
  STATUS=$?
  set -e
  LOG="$(cat "$C/log")"
}

expect_stopped() {  # NAME TEXT: the run exited non-zero and its output contains TEXT
  if [[ "$STATUS" -ne 0 && "$OUT" == *"$2"* ]]; then ok "$1"; else not_ok "$1" "status=$STATUS
$OUT"; fi
}

# ---------------------------------------------------------------- placeholders
count_url="$(grep -c '__RELAY_URL__' "$SCRIPT" || true)"
count_mp="$(grep -c '__MARKETPLACE__' "$SCRIPT" || true)"
if [[ "$count_url" == 1 && "$count_mp" == 1 ]] \
    && grep -qx "RELAY_URL='__RELAY_URL__'" "$SCRIPT" && grep -qx "MARKETPLACE='__MARKETPLACE__'" "$SCRIPT"; then
  ok "each placeholder appears once, as a single assignment (the relay replaces every occurrence)"
else
  not_ok "each placeholder appears once, as a single assignment" "RELAY_URL x${count_url}, MARKETPLACE x${count_mp}"
fi

new_case unfilled
run_case "$SCRIPT"
expect_stopped "placeholders not filled in: refuses" "not filled in by a relay"
check "placeholders not filled in: runs nothing" [ -z "$LOG" ]

new_case bad-url
sed -e "s#__RELAY_URL__#http://relay.example.com#" -e "s#__MARKETPLACE__#${REPO}#" "$SCRIPT" >"$C/setup.sh"
run_case "$C/setup.sh"
expect_stopped "relay address not https: refuses" "relay address in this script does not look right"

new_case bad-marketplace
sed -e "s#__RELAY_URL__#${RELAY}#" -e "s#__MARKETPLACE__#not a repo; rm -rf x#" "$SCRIPT" >"$C/setup.sh"
run_case "$C/setup.sh"
expect_stopped "malformed marketplace: refuses" "plugin source in this script does not look right"

# ---------------------------------------------------------------- this computer
new_case linux
echo Linux >"$C/state/uname"
run_case "$FILLED"
expect_stopped "not macOS: refuses" "works on a Mac only"
check "not macOS: runs nothing" [ -z "$LOG" ]

new_case no-tty
TTY_OVERRIDE="$C/no-such-tty" run_case "$FILLED"
expect_stopped "no terminal to ask in: refuses" "in the Terminal app"

# ---------------------------------------------------------------- Node.js
new_case no-node no-node
run_case "$FILLED"
expect_stopped "node missing: says how to install it" "https://nodejs.org"
check "node missing: Claude Code untouched" log_lacks claude

new_case old-node
echo v20.19.0 >"$C/state/node-version"
run_case "$FILLED"
expect_stopped "node 20: too old" "too old"

# ---------------------------------------------------------------- Claude Code missing
new_case no-claude-no "" no-claude
printf 'n\n' >"$C/tty"
run_case "$FILLED"
expect_stopped "claude missing, answer no: stops" "Install Claude Code now? [y/N]"
check "claude missing, answer no: installer not run" log_lacks curl

new_case no-claude-yes "" no-claude
printf 'y\n' >"$C/tty"
run_case "$FILLED"
if [[ "$STATUS" -eq 0 && "$LOG" == *"curl -fsSL https://claude.ai/install.sh"* \
    && "$LOG" == *"setup-cli daemon install --claude $C/home/.local/bin/claude --plugin team-relay@team-relay-dev <y>"* ]]; then
  ok "claude missing, answer yes: official installer, then found in ~/.local/bin"
else
  not_ok "claude missing, answer yes: official installer, then found in ~/.local/bin" "status=$STATUS
$OUT
--- log
$LOG"
fi

# ---------------------------------------------------------------- happy path, then a re-run
new_case happy
run_case "$FILLED"
want_first="node --version
claude auth status --json <>
claude auth login <TTY-MARK>
claude plugin marketplace list --json <>
claude plugin marketplace add ${REPO} <>
claude plugin marketplace list --json <>
claude plugin list --json <>
claude plugin install team-relay@team-relay-dev <>
setup-cli login --relay ${RELAY} <TTY-MARK>
setup-cli folders <TTY-MARK>
setup-cli daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli drive <TTY-MARK>
setup-cli status <TTY-MARK>"
if [[ "$STATUS" -eq 0 && "$LOG" == "$want_first" ]]; then
  ok "first run: signs in, adds the marketplace, installs, then runs setup-cli in order"
else
  not_ok "first run: signs in, adds the marketplace, installs, then runs setup-cli in order" "status=$STATUS
--- want
$want_first
--- got
$LOG
--- output
$OUT"
fi
if [[ "$OUT" == *"${RELAY}/"* && "$OUT" == *"accept the boundaries"* ]]; then
  ok "first run: ends with the console URL and the boundaries step"
else
  not_ok "first run: ends with the console URL and the boundaries step" "$OUT"
fi

: >"$C/log"
run_case "$FILLED"
want_again="node --version
claude auth status --json <>
claude plugin marketplace list --json <>
claude plugin marketplace update team-relay-dev <>
claude plugin list --json <>
claude plugin update team-relay@team-relay-dev <>
setup-cli login --relay ${RELAY} <TTY-MARK>
setup-cli folders <TTY-MARK>
setup-cli daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli drive <TTY-MARK>
setup-cli status <TTY-MARK>"
if [[ "$STATUS" -eq 0 && "$LOG" == "$want_again" ]]; then
  ok "re-run: no new sign-in, refreshes the marketplace, updates the plugin"
else
  not_ok "re-run: no new sign-in, refreshes the marketplace, updates the plugin" "status=$STATUS
--- want
$want_again
--- got
$LOG
--- output
$OUT"
fi

new_case no-setup-cli
rm "$C/plugin/dist/setup-cli.js"
run_case "$FILLED"
expect_stopped "plugin without setup-cli.js: stops with a clear message" "setup tool was not found"

# ---------------------------------------------------------------- one rule for the plugin's place
# Only the user-scope entry under exactly team-relay@<the marketplace it installed from>.
new_case other-marketplace
mkdir -p "$C/other/dist"
: >"$C/other/dist/setup-cli.js"
printf '{"version":2,"plugins":{"team-relay@team-relay-dev":[{"scope":"project","installPath":"%s"}],"team-relay@other":[{"scope":"user","installPath":"%s"}]}}' \
  "$C/plugin" "$C/other" >"$C/state/installed-json"
run_case "$FILLED"
expect_stopped "only a project-scope install under its key: stops (never another scope or marketplace)" "setup tool was not found"
check "only a project-scope install under its key: no setup-cli run" log_lacks "setup-cli"

# ---------------------------------------------------------------- Drive does not stop the setup
new_case drive-fails
: >"$C/state/drive-fails"
run_case "$FILLED"
if [[ "$STATUS" -eq 0 && "$LOG" == *"setup-cli daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli drive <TTY-MARK>
setup-cli status <TTY-MARK>" && "$OUT" == *"Google Drive is not connected yet"* && "$OUT" == *"run the same setup command again"* ]]; then
  ok "a failed Drive step: the answerer is already installed, it says how to retry, and setup goes on to the status"
else
  not_ok "a failed Drive step: the answerer is already installed, it says how to retry, and setup goes on to the status" "status=$STATUS
$OUT
--- log
$LOG"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
