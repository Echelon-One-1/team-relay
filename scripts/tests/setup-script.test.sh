#!/usr/bin/env bash
# Tests for relay/relay/static/setup.sh (docs/M11-SPEC.md §5), run as `bash
# scripts/tests/setup-script.test.sh` locally and in CI. No network, no real Claude Code: each case
# gets a throwaway HOME and a PATH holding only stubs (uname, node, claude, curl, bash) that log
# every call to a file, with what each call read on stdin. Questions come from a file standing in
# for the terminal (TEAM_RELAY_SETUP_TTY). The script is fed to /bin/bash through a pipe, as
# `curl ... | bash` does, so a command that read the script's stdin would show up here.
# Needs node (the stub hands `node -e` to the real one) and a POSIX /bin/sh.
#
# The Node.js download: the fake curl serves tarballs made here, holding a node stub. Their
# SHA-256 differ from the real builds', so each case that installs runs a copy of the script whose
# two pinned NODE_SHA256_* lines are edited (sed) to the test tarballs' hashes. Nothing in the
# environment can change those values in a real run; the hash-mismatch case runs the script with
# its real pinned values. The real tools the download uses (mkdir, chmod, mktemp, shasum, tar,
# gzip, mv, rm, ln) are linked into the stub directory. Every run past the first checks installs
# (or finds) that private copy, whatever node is on PATH, so those runs use the edited copy.
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

NODE_V="v22.23.4"
TOOLS="mkdir chmod mktemp shasum tar gzip mv rm ln"
for t in $TOOLS; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "setup-script test: $t is needed to run these tests" >&2
    exit 1
  fi
done

# node_stub FILE NAME RUN VERSION: a node that logs "NAME --version" and says VERSION (empty: the
# case's state/node-version, else v22.12.0), logs "RUN <args> <what it read>" for a script it runs
# (setup-cli.js), and hands -e to the real one.
node_stub() {
  cat >"$1" <<EOF
#!/bin/sh
case "\$1" in
  --version)
    if [ -z "$4" ] && [ -f "$C/state/node-version" ]; then IFS= read -r v <"$C/state/node-version"; else v=${4:-v22.12.0}; fi
    printf '$2 --version\n' >>"$C/log"
    echo "\$v" ;;
  -e) exec "$REAL_NODE" "\$@" ;;
  *)
    shift
    IFS= read -r input || input=""
    printf '$3 %s <%s>\n' "\$*" "\$input" >>"$C/log"
    if [ "\$1" = drive ] && [ -f "$C/state/drive-fails" ]; then echo "drive stub: did not connect"; exit 1; fi
    if [ "\$1" = daemon ] && [ -f "$C/state/daemon-fails" ]; then exit 1; fi
    if [ "\$1" = status ] && [ -f "$C/state/status-fails" ]; then exit 1; fi ;;
esac
EOF
  chmod +x "$1"
}

# new_case NAME [no-node] [no-claude]: a HOME, a stub bin directory, a log, a tty file, and the
# two Node.js tarballs the fake curl serves (their node logs as "setup-cli(private <arch>)").
new_case() {
  C="$WORK/$1"
  mkdir -p "$C/bin" "$C/home/.claude/plugins" "$C/home/.local/bin" "$C/state" "$C/plugin/dist" "$C/served"
  : >"$C/log"
  printf 'TTY-MARK\n' >"$C/tty"
  : >"$C/plugin/dist/setup-cli.js"
  ln -s "$BASH_BIN" "$C/bin/bash"
  local t arch
  for t in $TOOLS; do ln -s "$(command -v "$t")" "$C/bin/$t"; done
  cat >"$C/bin/uname" <<EOF
#!/bin/sh
if [ "\$1" = -m ]; then
  if [ -f "$C/state/arch" ]; then IFS= read -r a <"$C/state/arch"; echo "\$a"; else echo arm64; fi
  exit 0
fi
cat_os() { if [ -f "$C/state/uname" ]; then IFS= read -r os <"$C/state/uname"; echo "\$os"; else echo Darwin; fi; }
cat_os
EOF
  if [[ "${2:-}" != "no-node" ]]; then
    node_stub "$C/bin/node" node setup-cli ""
  fi
  for arch in arm64 x64; do
    mkdir -p "$C/tar/$arch/node-${NODE_V}-darwin-$arch/bin" "$C/tar/$arch/node-${NODE_V}-darwin-$arch/include"
    node_stub "$C/tar/$arch/node-${NODE_V}-darwin-$arch/bin/node" "private-node($arch)" "setup-cli(private $arch)" "$NODE_V"
    tar -czf "$C/served/node-${NODE_V}-darwin-$arch.tar.gz" -C "$C/tar/$arch" "node-${NODE_V}-darwin-$arch"
  done
  pin_tarballs
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
  "plugin install --scope user team-relay@team-relay-dev")
    if [ -f "$C/state/installed-json" ]; then
      /bin/cp "$C/state/installed-json" "$C/home/.claude/plugins/installed_plugins.json"
    else
      printf '{"version":2,"plugins":{"team-relay@team-relay-dev":[{"scope":"user","installPath":"%s"}]}}' "$C/plugin" \
        >"$C/home/.claude/plugins/installed_plugins.json"
    fi ;;
  "plugin update --scope user team-relay@team-relay-dev") ;;
  *) echo "claude stub: unexpected call: \$*" >&2; exit 3 ;;
esac
EOF
  chmod +x "$C/bin/uname" "$C/claude-stub"
  if [[ "${3:-}" != "no-claude" ]]; then
    ln -s "$C/claude-stub" "$C/bin/claude"
  fi
  # curl, stubbed: a nodejs.org download is served from $C/served (to the -o file); anything else
  # is the official Claude Code installer, which puts claude where the real one goes.
  cat >"$C/bin/curl" <<EOF
#!/bin/sh
printf 'curl %s\n' "\$*" >>"$C/log"
out=""
url=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = -o ]; then out="\$a"; fi
  case "\$a" in https://*) url="\$a" ;; esac
  prev="\$a"
done
case "\$url" in
  https://nodejs.org/dist/*)
    f="$C/served/\$(/usr/bin/basename "\$url")"
    [ -f "\$f" ] || exit 22
    /bin/cp "\$f" "\$out" ;;
  *) echo '/bin/ln -s "$C/claude-stub" "$C/home/.local/bin/claude"' ;;
esac
EOF
  chmod +x "$C/bin/curl"
}

# pin_tarballs: $PINNED is the filled script with the pinned hashes edited to this case's tarballs.
pin_tarballs() {
  SHA_ARM64="$(shasum -a 256 "$C/served/node-${NODE_V}-darwin-arm64.tar.gz")"
  SHA_ARM64="${SHA_ARM64%% *}"
  SHA_X64="$(shasum -a 256 "$C/served/node-${NODE_V}-darwin-x64.tar.gz")"
  SHA_X64="${SHA_X64%% *}"
  sed -e "s#^NODE_SHA256_ARM64='[0-9a-f]*'\$#NODE_SHA256_ARM64='${SHA_ARM64}'#" \
      -e "s#^NODE_SHA256_X64='[0-9a-f]*'\$#NODE_SHA256_X64='${SHA_X64}'#" "$FILLED" >"$C/setup.pinned.sh"
  PINNED="$C/setup.pinned.sh"
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

# The pinned Node.js hashes are plain assignments the tests can edit in a copy, and nothing else
# names them (no environment variable can replace them).
if [[ "$(grep -c "^NODE_SHA256_ARM64='c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428'\$" "$SCRIPT")" == 1 \
    && "$(grep -c "^NODE_SHA256_X64='efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819'\$" "$SCRIPT")" == 1 \
    && "$(grep -c 'NODE_SHA256_[A-Z0-9]*=' "$SCRIPT")" == 2 \
    && "$(grep -c "^NODE_VERSION='v22.23.4'\$" "$SCRIPT")" == 1 ]]; then
  ok "the Node.js build is pinned by version and SHA-256, set once each"
else
  not_ok "the Node.js build is pinned by version and SHA-256, set once each"
fi

new_case unfilled
run_case "$SCRIPT"
expect_stopped "placeholders not filled in: refuses" "was not made by your team's page"
check "placeholders not filled in: runs nothing" [ -z "$LOG" ]

new_case bad-url
sed -e "s#__RELAY_URL__#http://relay.example.com#" -e "s#__MARKETPLACE__#${REPO}#" "$SCRIPT" >"$C/setup.sh"
run_case "$C/setup.sh"
expect_stopped "relay address not https: refuses" "does not look right (the team's address)"

new_case bad-marketplace
sed -e "s#__RELAY_URL__#${RELAY}#" -e "s#__MARKETPLACE__#not a repo; rm -rf x#" "$SCRIPT" >"$C/setup.sh"
run_case "$C/setup.sh"
expect_stopped "malformed marketplace: refuses" "does not look right (where the team tools come from)"

# ---------------------------------------------------------------- this computer
new_case linux
echo Linux >"$C/state/uname"
run_case "$FILLED"
expect_stopped "not macOS: refuses" "works on a Mac only"
check "not macOS: runs nothing" [ -z "$LOG" ]

new_case no-tty
TTY_OVERRIDE="$C/no-such-tty" run_case "$FILLED"
expect_stopped "no terminal to ask in: refuses" "into the Terminal app"

# ---------------------------------------------------------------- Node.js: found, or fetched
PRIV="home/.local/share/team-relay"

# node_installed ARCH: the private copy of that build is in place and set up everything after.
node_installed() {
  [[ -x "$C/$PRIV/node-${NODE_V}-darwin-$1/bin/node" ]] \
    && [[ "$LOG" == *"curl -fsSL --proto =https --tlsv1.2 -o $C/$PRIV/.download."*" https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-darwin-$1.tar.gz"* ]] \
    && [[ "$LOG" == *"setup-cli(private $1) daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>"* ]] \
    && [[ "$LOG" == *"setup-cli(private $1) status --after-setup <TTY-MARK>"* ]] \
    && [[ "$LOG" != *"setup-cli login"* ]]
}
# no_download_left: no temporary download folder stays behind.
no_download_left() {
  [[ -z "$(find "$C/$PRIV" -maxdepth 1 -name '.download.*' 2>/dev/null)" ]]
}
# no_node_link: setup never makes ~/.local/bin/node (the plugin starts through its own launcher).
no_node_link() { [[ ! -e "$C/home/.local/bin/node" && ! -L "$C/home/.local/bin/node" ]]; }
# The permission string of a folder (same on macOS and Linux).
perms_of() { local l; l="$(ls -ld "$1")"; printf '%s' "${l:0:10}"; }

new_case no-node no-node
run_case "$PINNED"
if [[ "$STATUS" -eq 0 ]] && node_installed arm64 && no_download_left \
    && [[ "$(perms_of "$C/$PRIV")" == "drwx------" ]] && [[ "$OUT" == *"Getting a helper the setup needs (about 50 MB)..."* ]]; then
  ok "node missing (arm64): downloads the arm64 build, checks it, unpacks it privately (mode 700) and uses it for everything"
else
  not_ok "node missing (arm64): downloads the arm64 build, checks it, unpacks it privately (mode 700) and uses it for everything" "status=$STATUS
$OUT
--- log
$LOG"
fi
if no_node_link; then
  ok "node missing: never creates ~/.local/bin/node (the plugin finds the private copy itself)"
else
  not_ok "node missing: never creates ~/.local/bin/node" "$(ls -la "$C/home/.local/bin" 2>&1)"
fi
if [[ "$OUT" != *"Node"* && "$OUT" != *"node"* && "$OUT" != *"symlink"* && "$OUT" != *"PATH"* ]]; then
  ok "node missing: the output never names Node.js, node, PATH or links"
else
  not_ok "node missing: the output never names Node.js, node, PATH or links" "$OUT"
fi

# A second run uses the private copy: no download.
: >"$C/log"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$LOG" != *"nodejs.org"* && "$LOG" == *"setup-cli(private arm64) status --after-setup <TTY-MARK>"* ]] \
    && [[ -x "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin/node" ]] && no_node_link; then
  ok "re-run without node on PATH: uses the private copy, downloads nothing"
else
  not_ok "re-run without node on PATH: uses the private copy, downloads nothing" "status=$STATUS
$LOG"
fi

new_case intel no-node
echo x86_64 >"$C/state/arch"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 ]] && node_installed x64 && [[ "$LOG" != *"darwin-arm64"* ]]; then
  ok "node missing (x86_64): downloads the x64 build"
else
  not_ok "node missing (x86_64): downloads the x64 build" "status=$STATUS
$OUT
--- log
$LOG"
fi

new_case other-cpu no-node
echo ppc >"$C/state/arch"
run_case "$PINNED"
expect_stopped "node missing on an unknown processor: stops" "This kind of Mac is not supported"
check "unknown processor: downloads nothing" log_lacks "nodejs.org"

new_case bad-hash no-node
run_case "$FILLED"   # the real pinned hashes: the test tarball does not match them
expect_stopped "download with another SHA-256: refuses" "was not the file it should be, so nothing was installed"
if [[ ! -e "$C/$PRIV/node-${NODE_V}-darwin-arm64" ]] && no_download_left && no_node_link \
    && [[ "$LOG" == *"nodejs.org"* && "$LOG" != *"claude "* && "$LOG" != *"setup-cli"* ]]; then
  ok "download with another SHA-256: nothing installed, nothing linked, nothing else run"
else
  not_ok "download with another SHA-256: nothing installed, nothing linked, nothing else run" "$(find "$C/home" 2>&1)
--- log
$LOG"
fi

new_case own-node-link no-node
printf '#!/bin/sh\necho mine\n' >"$C/home/.local/bin/node"
chmod +x "$C/home/.local/bin/node"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 ]] && node_installed arm64 && [[ ! -L "$C/home/.local/bin/node" ]] \
    && [[ "$(cat "$C/home/.local/bin/node")" == "$(printf '#!/bin/sh\necho mine')" ]]; then
  ok "an existing ~/.local/bin/node is left as it is"
else
  not_ok "an existing ~/.local/bin/node is left as it is" "status=$STATUS
$(ls -la "$C/home/.local/bin")
$LOG"
fi

for old in v20.19.0 v22.11.0; do
  new_case "old-node-$old"
  echo "$old" >"$C/state/node-version"
  run_case "$PINNED"
  if [[ "$STATUS" -eq 0 ]] && node_installed arm64 && no_node_link && [[ "$LOG" != *"setup-cli login"* ]]; then
    ok "node $old on PATH (older than 22.12): fetches the pinned build and uses it, and links nothing"
  else
    not_ok "node $old on PATH (older than 22.12): fetches the pinned build and uses it, and links nothing" "status=$STATUS
$OUT
--- log
$LOG"
  fi
done

new_case broken-private no-node
mkdir -p "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin"
printf '#!/bin/sh\nexit 1\n' >"$C/$PRIV/node-${NODE_V}-darwin-arm64/bin/node"
chmod +x "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin/node"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 ]] && node_installed arm64 && no_download_left; then
  ok "a private copy that does not run: replaced by a fresh download"
else
  not_ok "a private copy that does not run: replaced by a fresh download" "status=$STATUS
$OUT
--- log
$LOG"
fi

# A new pinned version (or the earlier folder naming): downloads the new build, and once the
# background answerer runs with it, removes the other node-v* folders, and only those.
new_case pin-bump no-node
for old in node-v22.20.0-darwin-arm64 "node-${NODE_V}"; do
  mkdir -p "$C/$PRIV/$old/bin"
  node_stub "$C/$PRIV/$old/bin/node" "old-node" "setup-cli(old)" v22.20.0
done
: >"$C/$PRIV/keep-me"
mkdir -p "$C/$PRIV/notes"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 ]] && node_installed arm64 && no_download_left && no_node_link \
    && [[ ! -e "$C/$PRIV/node-v22.20.0-darwin-arm64" && ! -e "$C/$PRIV/node-${NODE_V}" ]] \
    && [[ -f "$C/$PRIV/keep-me" && -d "$C/$PRIV/notes" && "$LOG" != *"setup-cli(old)"* ]]; then
  ok "pin bump: downloads the new build, uses it, then removes the old node-v* folders and nothing else"
else
  not_ok "pin bump: downloads the new build, uses it, then removes the old node-v* folders and nothing else" "status=$STATUS
$(ls -la "$C/$PRIV" 2>&1)
--- log
$LOG"
fi

new_case pin-bump-daemon-fails no-node
mkdir -p "$C/$PRIV/node-v22.20.0-darwin-arm64/bin"
node_stub "$C/$PRIV/node-v22.20.0-darwin-arm64/bin/node" "old-node" "setup-cli(old)" v22.20.0
: >"$C/state/daemon-fails"
run_case "$PINNED"
expect_stopped "pin bump, background answerer not set: stops plainly" "Your Mac could not be set to answer your team."
check "pin bump, background answerer not set: the old build stays (it may still be in use)" \
  [ -x "$C/$PRIV/node-v22.20.0-darwin-arm64/bin/node" ]

# A node on PATH, the pinned copy already there and an older one: the pinned copy is used without a
# download, and the older one is removed after the background answerer is set.
new_case path-node-private-there
mkdir -p "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin" "$C/$PRIV/node-v22.20.0-darwin-arm64/bin"
node_stub "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin/node" "private-node(arm64)" "setup-cli(private arm64)" "$NODE_V"
node_stub "$C/$PRIV/node-v22.20.0-darwin-arm64/bin/node" "old-node" "setup-cli(old)" v22.20.0
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$LOG" != *"nodejs.org"* && "$LOG" != *"setup-cli "* && "$LOG" != *"setup-cli(old)"* ]] \
    && [[ "$LOG" == *"setup-cli(private arm64) daemon install --claude $C/bin/claude"* ]] \
    && [[ -x "$C/$PRIV/node-${NODE_V}-darwin-arm64/bin/node" && ! -e "$C/$PRIV/node-v22.20.0-darwin-arm64" ]]; then
  ok "node on PATH and the pinned copy there: uses that copy (no download), removes the older one"
else
  not_ok "node on PATH and the pinned copy there: uses that copy (no download), removes the older one" "status=$STATUS
$(ls -la "$C/$PRIV" 2>&1)
$LOG"
fi

new_case curl-fails no-node
rm "$C/served/node-${NODE_V}-darwin-arm64.tar.gz"   # the fake curl then exits 22, as curl -f does on a 404
run_case "$PINNED"
expect_stopped "download fails (curl exit 22): stops plainly" "The download did not work. Check your internet connection, then run the setup line again."
if [[ ! -e "$C/$PRIV/node-${NODE_V}-darwin-arm64" ]] && no_download_left && [[ "$LOG" != *"claude "* && "$LOG" != *"setup-cli"* ]]; then
  ok "download fails: nothing installed, nothing left behind, nothing else run"
else
  not_ok "download fails: nothing installed, nothing left behind, nothing else run" "$(find "$C/home" 2>&1)
$LOG"
fi

new_case no-bin-node no-node
rm "$C/tar/arm64/node-${NODE_V}-darwin-arm64/bin/node"
tar -czf "$C/served/node-${NODE_V}-darwin-arm64.tar.gz" -C "$C/tar/arm64" "node-${NODE_V}-darwin-arm64"
pin_tarballs   # the checksum matches: only the contents are wrong
run_case "$PINNED"
expect_stopped "a download without bin/node: stops plainly" "The download could not be unpacked. Run the setup line again."
check "a download without bin/node: nothing installed, nothing left behind" \
  eval '[[ ! -e "$C/$PRIV/node-${NODE_V}-darwin-arm64" ]] && no_download_left'

new_case chmod-fails no-node
rm "$C/bin/chmod"
printf '#!/bin/sh\nexit 1\n' >"$C/bin/chmod"
/bin/chmod +x "$C/bin/chmod"
run_case "$PINNED"
expect_stopped "the private folder cannot be locked down: stops plainly" "The setup could not make its folder on this Mac."
check "the private folder cannot be locked down: nothing fetched" log_lacks "nodejs.org"

# ---------------------------------------------------------------- Claude Code missing
new_case no-claude-no "" no-claude
printf 'n\n' >"$C/tty"
run_case "$PINNED"
expect_stopped "claude missing, answer no: stops" "Install Claude Code now? [y/N]"
check "claude missing, answer no: installer not run" log_lacks "claude.ai/install.sh"

new_case no-claude-yes "" no-claude
printf 'y\n' >"$C/tty"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$LOG" == *"curl -fsSL https://claude.ai/install.sh"* \
    && "$LOG" == *"setup-cli(private arm64) daemon install --claude $C/home/.local/bin/claude --plugin team-relay@team-relay-dev <y>"* ]]; then
  ok "claude missing, answer yes: official installer, then found in ~/.local/bin"
else
  not_ok "claude missing, answer yes: official installer, then found in ~/.local/bin" "status=$STATUS
$OUT
--- log
$LOG"
fi

# ---------------------------------------------------------------- happy path, then a re-run
new_case happy
run_case "$PINNED"
want_first="private-node(arm64) --version
claude auth status --json <>
claude auth login <TTY-MARK>
claude plugin marketplace list --json <>
claude plugin marketplace add ${REPO} <>
claude plugin marketplace list --json <>
claude plugin install --scope user team-relay@team-relay-dev <>
setup-cli(private arm64) login --relay ${RELAY} <TTY-MARK>
setup-cli(private arm64) folders <TTY-MARK>
setup-cli(private arm64) drive <TTY-MARK>
setup-cli(private arm64) daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli(private arm64) status --after-setup <TTY-MARK>"
# The download's own line (a random temporary folder) is checked by node_installed below.
if [[ "$STATUS" -eq 0 && "$(printf '%s\n' "$LOG" | grep -v '^curl ')" == "$want_first" ]]; then
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
# The closing line ("Done. Go back to the team page ...", "and click Accept" only when something is
# not accepted yet) is setup-cli status's own (plugin tests); setup.sh adds the team page's address.
if [[ "$OUT" == *"
   ${RELAY}/" && "$OUT" != *"Done."*"Done. Go back"* && "$OUT" != *"Go back to the team page"* && "$OUT" != *"Could not check"* ]]; then
  ok "first run: setup-cli status says the closing line; the setup ends with the team page's address"
else
  not_ok "first run: setup-cli status says the closing line; the setup ends with the team page's address" "$OUT"
fi
# The desktop app may not see Terminal's node, so the setup installs its own copy even then, and
# runs everything (and the background answerer) with it; the node on PATH runs nothing.
path_node_unused() { node_installed arm64 && no_node_link && [[ "$LOG" != *"setup-cli "* ]]; }
check "node 22.12 on PATH: the private copy is still installed and used for everything, nothing linked" path_node_unused

: >"$C/log"
run_case "$PINNED"
want_again="private-node(arm64) --version
claude auth status --json <>
claude plugin marketplace list --json <>
claude plugin marketplace update team-relay-dev <>
claude plugin update --scope user team-relay@team-relay-dev <>
setup-cli(private arm64) login --relay ${RELAY} <TTY-MARK>
setup-cli(private arm64) folders <TTY-MARK>
setup-cli(private arm64) drive <TTY-MARK>
setup-cli(private arm64) daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli(private arm64) status --after-setup <TTY-MARK>"
if [[ "$STATUS" -eq 0 && "$LOG" == "$want_again" && "$LOG" != *"nodejs.org"* ]]; then
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

new_case status-fails
: >"$C/state/status-fails"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$OUT" == *"(Could not check with the team just now.)

Done. Go back to the team page in your browser.
   ${RELAY}/" ]]; then
  ok "status cannot reach the team: the setup still finishes, without the Accept hint, with the address"
else
  not_ok "status cannot reach the team: the setup still finishes, without the Accept hint, with the address" "status=$STATUS
$OUT"
fi

new_case no-setup-cli
rm "$C/plugin/dist/setup-cli.js"
run_case "$PINNED"
expect_stopped "plugin without setup-cli.js: stops with a clear message" "a part of them is missing"

# ---------------------------------------------------------------- one rule for the plugin's place
# Only the user-scope entry under exactly team-relay@<the marketplace it installed from>.
new_case other-marketplace
mkdir -p "$C/other/dist"
: >"$C/other/dist/setup-cli.js"
printf '{"version":2,"plugins":{"team-relay@team-relay-dev":[{"scope":"project","installPath":"%s"}],"team-relay@other":[{"scope":"user","installPath":"%s"}]}}' \
  "$C/plugin" "$C/other" >"$C/state/installed-json"
run_case "$PINNED"
expect_stopped "only a project-scope install under its key: stops (never another scope or marketplace)" "a part of them is missing"
check "only a project-scope install under its key: no setup-cli run" log_lacks "setup-cli"

# ---------------------------------------------------------------- Drive does not stop the setup
new_case drive-fails
: >"$C/state/drive-fails"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$LOG" == *"setup-cli(private arm64) drive <TTY-MARK>
setup-cli(private arm64) daemon install --claude $C/bin/claude --plugin team-relay@team-relay-dev <TTY-MARK>
setup-cli(private arm64) status --after-setup <TTY-MARK>" && "$OUT" == *"Google Drive is not connected yet"* && "$OUT" == *"run the setup line again"* ]]; then
  ok "a failed Drive step: it says how to retry, and setup goes on to the background answerer and the status"
else
  not_ok "a failed Drive step: it says how to retry, and setup goes on to the background answerer and the status" "status=$STATUS
$OUT
--- log
$LOG"
fi

# ---------------------------------------------------------------- installed, but not for this user
# A project-scope install only: the plugin is installed at user scope (not updated), and setup goes on.
new_case project-only
: >"$C/state/marketplace"
printf '{"version":2,"plugins":{"team-relay@team-relay-dev":[{"scope":"project","installPath":"%s","projectPath":"/somewhere"}]}}' \
  "$C/plugin" >"$C/home/.claude/plugins/installed_plugins.json"
run_case "$PINNED"
if [[ "$STATUS" -eq 0 && "$LOG" == *"claude plugin install --scope user team-relay@team-relay-dev <>"* \
    && "$LOG" != *"plugin update"* && "$LOG" == *"setup-cli(private arm64) status --after-setup <TTY-MARK>"* ]]; then
  ok "installed for a project only: installs it for this user instead of updating, and goes on"
else
  not_ok "installed for a project only: installs it for this user instead of updating, and goes on" "status=$STATUS
$OUT
--- log
$LOG"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
