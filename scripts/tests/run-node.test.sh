#!/usr/bin/env bash
# Tests for plugin/bin/run-node and plugin/bin/node-pins.sh (the plugin's Node.js launcher), run as
# `bash scripts/tests/run-node.test.sh` locally and in CI. No network: each case gets a throwaway
# HOME and a PATH holding only stubs (uname, curl, sleep, node) and wrappers that log each call and
# hand it to the real tool (shasum, tar). The fake curl serves tarballs made here, holding a node
# stub. Their SHA-256 differ from the real builds', so each case that installs runs a copy of
# run-node beside a copy of node-pins.sh whose two hash lines are edited (sed) to the test
# tarballs' hashes; the hash-mismatch case runs with the real pinned values. Waiting for another
# start's download uses `sleep 1` from PATH, so the stub sleep decides what happens meanwhile and
# no case depends on the clock.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_NODE="$ROOT/plugin/bin/run-node"
PINS="$ROOT/plugin/bin/node-pins.sh"
SETUP="$ROOT/relay/relay/static/setup.sh"
NODE_V="v22.23.4"
ARGS=(/plugin/dist/channel.js --flag)
FAIL_TAIL="Check your internet connection and restart Claude."
TODAY_ERR="Team relay needs its helper: paste the setup line from your team page into Terminal again."
# A process id no system hands out (above macOS's 99998 and Linux's largest pid_max, 4194304), so
# "is its owner running?" is always no.
DEAD_PID=9999999

TOOLS="mkdir chmod mktemp mv rm cat"
for t in $TOOLS shasum tar gzip; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "run-node test: $t is needed to run these tests" >&2
    exit 1
  fi
done
REAL_SHASUM="$(command -v shasum)"
REAL_TAR="$(command -v tar)"
REAL_SLEEP="$(command -v sleep)"
REAL_GREP="$(command -v grep)"
REAL_WC="$(command -v wc)"
REAL_HEAD="$(command -v head)"
REAL_TAIL="$(command -v tail)"
REAL_MV="$(command -v mv)"

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
not_ok() {
  failed=$((failed + 1))
  printf 'FAIL %s\n' "$1"
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" | sed 's/^/     /'; fi
}
# check NAME TEST...: ok when the test command succeeds, else FAIL with the run's output and log.
check() {
  local name="$1"
  shift
  if "$@"; then ok "$name"; else not_ok "$name" "status=$STATUS
--- stdout
$OUT
--- stderr
$ERR
--- log
$LOG"; fi
}

# pinned_value FILE NAME: the value of the one line NAME='<value>' in FILE; fails unless exactly one
# line assigns NAME (anywhere, in any form) and it has that plain form.
pinned_value() {
  local n
  n="$(grep -c "$2=" "$1" || true)"
  [[ "$n" == 1 ]] || return 1
  grep -E "^$2='[0-9a-zA-Z.]+'\$" "$1" | sed -e "s/^$2='//" -e "s/'\$//"
}
# pins_match A B: both files pin the same Node.js version and both hashes, each set exactly once.
pins_match() {
  local name a b
  for name in NODE_VERSION NODE_SHA256_ARM64 NODE_SHA256_X64; do
    a="$(pinned_value "$1" "$name")" || return 1
    b="$(pinned_value "$2" "$name")" || return 1
    [[ -n "$a" && "$a" == "$b" ]] || return 1
  done
}

# node_stub FILE NAME VERSION: a node that says VERSION and, run with a script, prints NAME, its
# arguments and the first line it read on stdin.
node_stub() {
  mkdir -p "$(dirname "$1")"
  cat >"$1" <<EOF
#!/bin/sh
if [ "\$1" = --version ]; then echo $3; exit 0; fi
IFS= read -r input || input=""
echo "$2 \$* <\$input>"
EOF
  chmod +x "$1"
}

# new_case NAME: a HOME, a stub bin directory, a log, the two tarballs the fake curl serves (their
# node prints "private(<arch>)") and a copy of run-node beside node-pins.sh with the test hashes.
new_case() {
  C="$WORK/$1"
  P="$C/home/.local/share/team-relay"
  PARTIAL_ARM="$P/.node-${NODE_V}-darwin-arm64.tar.gz.partial"
  mkdir -p "$C/bin" "$C/home" "$C/state" "$C/served" "$C/plugin/bin"
  : >"$C/log"
  local t arch
  for t in $TOOLS; do ln -s "$(command -v "$t")" "$C/bin/$t"; done
  # GNU tar (CI's Linux) runs gzip from PATH for -z; macOS's bsdtar has it built in.
  ln -s "$(command -v gzip)" "$C/bin/gzip"
  cat >"$C/bin/uname" <<EOF
#!/bin/sh
case "\$1" in
  -s) if [ -f "$C/state/os" ]; then IFS= read -r v <"$C/state/os"; else v=Darwin; fi ;;
  -m) if [ -f "$C/state/arch" ]; then IFS= read -r v <"$C/state/arch"; else v=arm64; fi ;;
  *) v=Darwin ;;
esac
echo "\$v"
EOF
  # curl: logs its arguments and what it read on stdin, then copies the served file named by the
  # URL to -o; with -C - and -o already there, only the bytes past its size (a resumed download).
  # state/curl-fails makes it fail; state/curl-half delivers the first half only and fails as a
  # cut-off transfer does (18); state/curl-gate makes it wait for state/go first.
  cat >"$C/bin/curl" <<EOF
#!/bin/sh
IFS= read -r input || input=""
printf 'curl %s <%s>\n' "\$*" "\$input" >>"$C/log"
out=""; url=""; resume=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out=\$2; shift ;;
    -C) resume=\$2; shift ;;
    https://*) url=\$1 ;;
  esac
  shift
done
if [ -f "$C/state/curl-gate" ]; then
  i=0
  while [ ! -f "$C/state/go" ] && [ \$i -lt 1200 ]; do "$REAL_SLEEP" 0.05; i=\$((i + 1)); done
fi
[ -f "$C/state/curl-fails" ] && exit 22
f="$C/served/\${url##*/}"
[ -f "\$f" ] || exit 22
size=\$("$REAL_WC" -c <"\$f")
size=\$((size + 0))
if [ -f "$C/state/curl-half" ]; then
  "$REAL_HEAD" -c \$((size / 2)) "\$f" >"\$out"
  exit 18
fi
if [ "\$resume" = - ] && [ -f "\$out" ]; then
  have=\$("$REAL_WC" -c <"\$out")
  have=\$((have + 0))
  # A range past the end: the server answers 416, which -f turns into exit 22.
  [ "\$have" -ge "\$size" ] && exit 22
  "$REAL_TAIL" -c +\$((have + 1)) "\$f" >>"\$out"
  exit 0
fi
/bin/cp "\$f" "\$out"
EOF
  cat >"$C/bin/shasum" <<EOF
#!/bin/sh
IFS= read -r input || input=""
printf 'shasum %s <%s>\n' "\$*" "\$input" >>"$C/log"
exec "$REAL_SHASUM" "\$@" </dev/null
EOF
  cat >"$C/bin/tar" <<EOF
#!/bin/sh
IFS= read -r input || input=""
printf 'tar %s <%s>\n' "\$*" "\$input" >>"$C/log"
exec "$REAL_TAR" "\$@" </dev/null
EOF
  # sleep: logs; state/sleep-installs-on-N puts the pinned arm64 copy in place on call N (another
  # start finishing its download); state/sleep-releases-curl lets the gated curl go and really
  # sleeps 0.2 s. Otherwise it returns at once.
  cat >"$C/bin/sleep" <<EOF
#!/bin/sh
printf 'sleep %s\n' "\$*" >>"$C/log"
n=\$("$REAL_GREP" -c '^sleep ' "$C/log")
if [ -f "$C/state/sleep-installs-on-\$n" ]; then
  mkdir -p "$P"
  /bin/cp -R "$C/tar/arm64/node-${NODE_V}-darwin-arm64" "$P/"
fi
if [ -f "$C/state/sleep-releases-curl" ]; then
  : >"$C/state/go"
  "$REAL_SLEEP" 0.2
fi
exit 0
EOF
  chmod +x "$C/bin/uname" "$C/bin/curl" "$C/bin/shasum" "$C/bin/tar" "$C/bin/sleep"
  for arch in arm64 x64; do
    node_stub "$C/tar/$arch/node-${NODE_V}-darwin-$arch/bin/node" "private($arch)" "$NODE_V"
    "$REAL_TAR" -czf "$C/served/node-${NODE_V}-darwin-$arch.tar.gz" -C "$C/tar/$arch" "node-${NODE_V}-darwin-$arch"
  done
  cp "$RUN_NODE" "$C/plugin/bin/run-node"
  pin_hashes "$(sha_of "$C/served/node-${NODE_V}-darwin-arm64.tar.gz")" \
    "$(sha_of "$C/served/node-${NODE_V}-darwin-x64.tar.gz")"
}
sha_of() { local s; s="$("$REAL_SHASUM" -a 256 "$1")"; printf '%s' "${s%% *}"; }
# pin_hashes ARM64 X64: this case's node-pins.sh is the real one with those two hashes.
pin_hashes() {
  sed -e "s#^NODE_SHA256_ARM64='[0-9a-f]*'\$#NODE_SHA256_ARM64='$1'#" \
      -e "s#^NODE_SHA256_X64='[0-9a-f]*'\$#NODE_SHA256_X64='$2'#" "$PINS" >"$C/plugin/bin/node-pins.sh"
}
# run_case [STDIN]: runs the copy as Claude Code does (/bin/sh run-node <bundle> <args>), with
# only the stubs on PATH (RUN_PATH when set) and STDIN (default STDIN-MARK) on stdin; RUN_VAR, when
# set (NAME=value), is one more variable in its environment.
RUN_VAR=""
RUN_PATH=""
run_case() {
  set +e
  OUT="$(printf '%s\n' "${1:-STDIN-MARK}" | env -i ${RUN_VAR:+"$RUN_VAR"} HOME="$C/home" PATH="${RUN_PATH:-$C/bin}" /bin/sh "$C/plugin/bin/run-node" "${ARGS[@]}" 2>"$C/stderr")"
  STATUS=$?
  set -e
  ERR="$(cat "$C/stderr")"
  LOG="$(cat "$C/log")"
}
curl_calls() { grep -c '^curl ' "$C/log" || true; }
# Only the pinned copy is left in the private folder: no download folder, no lock.
only_pinned_left() { [[ "$(ls -A "$P")" == "node-${NODE_V}-darwin-$1" ]]; }
nothing_left() { [[ ! -e "$P" || -z "$(ls -A "$P")" ]]; }
failed_with() { [[ "$STATUS" -ne 0 && -z "$OUT" && "$ERR" == "Could not get Node.js for the team relay: $1. $FAIL_TAIL" ]]; }
private_dir_mode_700() {
  local m
  m="$(ls -ld "$P")"
  [[ "${m:0:10}" == "drwx------" ]]
}

# ---------------------------------------------------------------- the pins
pins_one_place() {
  pins_match "$PINS" "$SETUP" && [[ "$(pinned_value "$PINS" NODE_VERSION)" == "$NODE_V" ]] \
    && grep -q "^NODE_SHA256_ARM64='[0-9a-f]\{64\}'\$" "$PINS" && grep -q "^NODE_SHA256_X64='[0-9a-f]\{64\}'\$" "$PINS"
}
STATUS=0 OUT="" ERR="" LOG=""
check "node-pins.sh pins the same Node.js version and SHA-256s as setup.sh, each set once" pins_one_place

# The comparison catches a change on either side.
mkdir -p "$WORK/pins"
pins_differ_detected() {
  local name
  sed -e "s#^NODE_SHA256_X64='[0-9a-f]*'\$#NODE_SHA256_X64='$(printf '0%.0s' {1..64})'#" "$SETUP" >"$WORK/pins/setup.sh"
  pins_match "$PINS" "$WORK/pins/setup.sh" && return 1
  sed -e "s#^NODE_VERSION='.*'\$#NODE_VERSION='v22.23.5'#" "$PINS" >"$WORK/pins/pins.sh"
  pins_match "$WORK/pins/pins.sh" "$SETUP" && return 1
  for name in NODE_SHA256_ARM64 NODE_VERSION; do
    { cat "$PINS"; echo "$name='x'"; } >"$WORK/pins/twice.sh"
    pins_match "$WORK/pins/twice.sh" "$SETUP" && return 1
  done
  return 0
}
check "a different or second pin in either file is caught" pins_differ_detected

# ---------------------------------------------------------------- 1. node on PATH
new_case path-node
node_stub "$C/bin/node" path-node v22.12.0
run_case
path_node_used() {
  [[ "$STATUS" -eq 0 && "$OUT" == "path-node ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 0 && ! -e "$P" ]]
}
check "node 22.12 on PATH: used with every argument and stdin, nothing downloaded" path_node_used

# ---------------------------------------------------------------- 2. the private copy setup.sh installs
new_case private-copy
node_stub "$C/bin/node" path-node v22.11.0
node_stub "$P/node-${NODE_V}-darwin-arm64/bin/node" "setup-copy" "$NODE_V"
run_case
private_used() {
  [[ "$STATUS" -eq 0 && "$OUT" == "setup-copy ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 0 ]]
}
check "node 22.11 on PATH and the setup's private copy: the private copy, nothing downloaded" private_used

# ---------------------------------------------------------------- 3. download, check, unpack, use
new_case download-arm64
run_case
downloaded_arm64() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" \
    && "$(curl_calls)" == 1 \
    && "$LOG" == *"curl -fsSL --proto =https --tlsv1.2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -C - -o $PARTIAL_ARM https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-darwin-arm64.tar.gz <>"* \
    && "$LOG" == *"shasum -a 256 $PARTIAL_ARM <>"* \
    && "$LOG" == *"tar -xzf $PARTIAL_ARM -C $P/.download."*" <>"* ]] \
    && only_pinned_left arm64 && private_dir_mode_700
}
check "no node: downloads the pinned arm64 build over https only, checks its SHA-256, unpacks it into the setup's folder and runs it (stdin untouched)" downloaded_arm64
: >"$C/log"
run_case
check "the next start uses that copy without downloading again" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 0 ]]'

new_case download-x64
echo x86_64 >"$C/state/arch"
run_case
downloaded_x64() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(x64) ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 1 \
    && "$LOG" == *" https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-darwin-x64.tar.gz <>"* ]] && only_pinned_left x64
}
check "an Intel Mac gets the pinned x64 build" downloaded_x64

new_case old-path-node
node_stub "$C/bin/node" path-node v20.19.0
node_stub "$P/node-v22.9.0-darwin-arm64/bin/node" too-old v22.9.0
run_case
check "node 20 on PATH and only a too-old private copy: downloads the pinned build" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 1 ]]'

new_case broken-copy
mkdir -p "$P/node-${NODE_V}-darwin-arm64/bin"
printf '#!/bin/sh\nexit 1\n' >"$P/node-${NODE_V}-darwin-arm64/bin/node"
chmod +x "$P/node-${NODE_V}-darwin-arm64/bin/node"
run_case
check "a pinned copy that does not run is replaced by a fresh download" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 1 ]] && only_pinned_left arm64'

# ---------------------------------------------------------------- 4. refused downloads leave nothing
new_case mismatch
cp "$PINS" "$C/plugin/bin/node-pins.sh"   # the real hashes: the test tarball does not match them
run_case
check "a download whose SHA-256 is not the pinned one is refused, not unpacked, and nothing is left" \
  eval 'failed_with "the download was not the file it should be" && [[ "$(curl_calls)" == 1 && "$LOG" != *"tar "* ]] && nothing_left'

new_case curl-fails
: >"$C/state/curl-fails"
run_case
check "a download that fails: one plain line, exit non-zero, nothing left" \
  eval 'failed_with "the download did not work" && nothing_left'

new_case not-a-tarball
printf 'not a tarball\n' >"$C/served/node-${NODE_V}-darwin-arm64.tar.gz"
pin_hashes "$(sha_of "$C/served/node-${NODE_V}-darwin-arm64.tar.gz")" "$(sha_of "$C/served/node-${NODE_V}-darwin-x64.tar.gz")"
run_case
check "a download with the pinned hash that does not unpack: refused, nothing left" \
  eval 'failed_with "the download could not be unpacked" && nothing_left'

new_case no-node-inside
mkdir -p "$C/empty/node-${NODE_V}-darwin-arm64/lib"
"$REAL_TAR" -czf "$C/served/node-${NODE_V}-darwin-arm64.tar.gz" -C "$C/empty" "node-${NODE_V}-darwin-arm64"
pin_hashes "$(sha_of "$C/served/node-${NODE_V}-darwin-arm64.tar.gz")" "$(sha_of "$C/served/node-${NODE_V}-darwin-x64.tar.gz")"
run_case
check "a tarball without bin/node: refused, nothing left" \
  eval 'failed_with "the download could not be unpacked" && nothing_left'

new_case does-not-run
node_stub "$C/tar/arm64/node-${NODE_V}-darwin-arm64/bin/node" "private(arm64)" "v20.0.0"
"$REAL_TAR" -czf "$C/served/node-${NODE_V}-darwin-arm64.tar.gz" -C "$C/tar/arm64" "node-${NODE_V}-darwin-arm64"
pin_hashes "$(sha_of "$C/served/node-${NODE_V}-darwin-arm64.tar.gz")" "$(sha_of "$C/served/node-${NODE_V}-darwin-x64.tar.gz")"
run_case
check "a download whose node does not run (or is too old): refused, not run" \
  eval 'failed_with "the Node.js it got does not run on this computer" && [[ "$OUT" != *private* ]] && nothing_left'

new_case no-pins
rm "$C/plugin/bin/node-pins.sh"
run_case
check "node-pins.sh missing: refused before any download" \
  eval 'failed_with "its pinned version is missing" && [[ "$(curl_calls)" == 0 ]] && nothing_left'

# ---------------------------------------------------------------- 5. only darwin arm64 / x64 download
unsupported() {
  [[ "$STATUS" -eq 1 && -z "$OUT" && "$ERR" == "$TODAY_ERR" && "$(curl_calls)" == 0 && ! -e "$P" ]]
}
new_case linux
echo Linux >"$C/state/os"
run_case
check "no node on Linux: today's plain line, exit 1, nothing downloaded" unsupported
new_case other-arch
echo i386 >"$C/state/arch"
run_case
check "no node on another processor: today's plain line, exit 1, nothing downloaded" unsupported
new_case no-uname
rm "$C/bin/uname"
run_case
check "no node and no uname on PATH: today's plain line, exit 1, nothing downloaded" unsupported

# ---------------------------------------------------------------- 6. one download at a time
# Another start holds the lock (its owner, this test, is running) and finishes during the wait.
new_case lock-held
mkdir -p "$P/.node-download.lock"
echo "$$" >"$P/.node-download.lock/pid"
: >"$C/state/sleep-installs-on-2"
run_case
lock_waited() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 0 \
    && "$(grep -c '^sleep 1$' "$C/log")" == 2 && -f "$P/.node-download.lock/pid" ]]
}
check "lock held by a running start: waits, then uses its copy without downloading, and leaves its lock alone" lock_waited

new_case lock-timeout
mkdir -p "$P/.node-download.lock"
echo "$$" >"$P/.node-download.lock/pid"
run_case
lock_timed_out() {
  failed_with "another start of the team relay is still getting it" && [[ "$(curl_calls)" == 0 \
    && "$(grep -c '^sleep 1$' "$C/log")" == 120 && "$(grep -c '^sleep ' "$C/log")" == 120 && -f "$P/.node-download.lock/pid" ]]
}
check "lock held by a running start that never finishes: gives up after 120 waits of 1 s" lock_timed_out

new_case lock-stale
mkdir -p "$P/.node-download.lock"
echo "$DEAD_PID" >"$P/.node-download.lock/pid"
run_case
check "lock left by a start that is no longer running: taken over at once, downloaded once, lock removed" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 1 && "$LOG" != *"sleep "* ]] && only_pinned_left arm64'

new_case lock-no-owner
mkdir -p "$P/.node-download.lock"
run_case
check "lock without an owner for the whole wait: taken over after it, downloaded once, lock removed" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 1 && "$(grep -c "^sleep 1\$" "$C/log")" == 120 ]] && only_pinned_left arm64'

# Two starts at once: the first holds its download until the second is waiting on the lock.
new_case two-starts
: >"$C/state/curl-gate"
: >"$C/state/sleep-releases-curl"
(printf 'A\n' | env -i HOME="$C/home" PATH="$C/bin" /bin/sh "$C/plugin/bin/run-node" "${ARGS[@]}" >"$C/out-a" 2>"$C/err-a"; echo $? >"$C/status-a") &
first=$!
i=0
while ! grep -q '^curl ' "$C/log" && [[ $i -lt 400 ]]; do "$REAL_SLEEP" 0.05; i=$((i + 1)); done
run_case B
wait "$first" || true
two_starts_one_download() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <B>" && -z "$ERR" \
    && "$(cat "$C/status-a")" == 0 && "$(cat "$C/out-a")" == "private(arm64) ${ARGS[*]} <A>" && ! -s "$C/err-a" \
    && "$(curl_calls)" == 1 ]] && only_pinned_left arm64
}
check "two starts at once: one downloads, the other waits for it and uses the same copy" two_starts_one_download

# ---------------------------------------------------------------- 7. slow links: resume, leftovers
new_case resume
: >"$C/state/curl-half"
run_case
cut_short() {
  failed_with "the download did not work" && [[ -f "$PARTIAL_ARM" && ! -e "$P/.node-download.lock" ]] \
    && [[ "$(ls -A "$P")" == ".node-${NODE_V}-darwin-arm64.tar.gz.partial" ]]
}
check "a download cut short: one plain line, its partial file kept for the next start, no lock left" cut_short
rm "$C/state/curl-half"
: >"$C/log"
run_case
resumed() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 1 \
    && "$LOG" == *" -C - -o $PARTIAL_ARM "* ]] && only_pinned_left arm64
}
check "the next start resumes it (-C -), checks the whole file's SHA-256, unpacks it and removes the partial file" resumed

new_case partial-complete
mkdir -p "$P"
cp "$C/served/node-${NODE_V}-darwin-arm64.tar.gz" "$PARTIAL_ARM"
run_case
check "a partial file that is already whole (the pinned SHA-256): used without downloading" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 0 ]] && only_pinned_left arm64'

new_case partial-corrupt
mkdir -p "$P"
printf 'garbage' >"$PARTIAL_ARM"
run_case
check "a partial file that resumes into the wrong file: refused, and the partial file deleted" \
  eval 'failed_with "the download was not the file it should be" && [[ "$(curl_calls)" == 1 && ! -e "$PARTIAL_ARM" ]] && nothing_left'
run_case
check "so the next start downloads afresh" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 2 ]] && only_pinned_left arm64'

new_case leftovers
mkdir -p "$P/.download.AbC123/node-v22.1.0-darwin-arm64" "$P/.node-download.stale.4242"
printf 'old\n' >"$P/.node-v22.1.0-darwin-arm64.tar.gz.partial"
printf 'old\n' >"$P/.node-${NODE_V}-darwin-x64.tar.gz.partial"
run_case
check "the start that downloads removes what earlier starts left: download folders, other versions' partial files" \
  eval '[[ "$STATUS" -eq 0 && "$(curl_calls)" == 1 ]] && only_pinned_left arm64'

new_case partial-symlink
mkdir -p "$P"
printf 'keep\n' >"$C/elsewhere"
ln -s "$C/elsewhere" "$PARTIAL_ARM"
run_case
check "a partial file that is a symlink is removed, never written through" \
  eval '[[ "$STATUS" -eq 0 && "$(curl_calls)" == 1 && "$(cat "$C/elsewhere")" == keep ]] && only_pinned_left arm64'

# ---------------------------------------------------------------- 8. PATH and the environment
new_case path-var-last
mkdir -p "$C/empty"
node_stub "$C/bin/node" path-node v22.12.0
RUN_VAR=last=1
RUN_PATH="$C/empty:$C/bin"
run_case
RUN_VAR=""
RUN_PATH=""
check "a variable named last in the environment does not cut the PATH search short" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "path-node ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 0 ]]'

# ---------------------------------------------------------------- 9. two starts and one dead lock
# Both find the lock of a start that is gone. The other one takes it over first and a new start
# takes the lock again (its pid file now names a running start): this one, renaming the pid file
# away, finds that owner, puts the file back and waits instead of removing a live lock.
new_case lock-race
mkdir -p "$P/.node-download.lock"
echo "$DEAD_PID" >"$P/.node-download.lock/pid"
rm "$C/bin/mv"
cat >"$C/bin/mv" <<EOF
#!/bin/sh
if [ -f "$C/state/mv-race" ] && [ "\$1" = "$P/.node-download.lock/pid" ]; then
  /bin/rm -f "$C/state/mv-race"
  echo "$$" >"\$1"
fi
exec "$REAL_MV" "\$@"
EOF
chmod +x "$C/bin/mv"
: >"$C/state/mv-race"
: >"$C/state/sleep-installs-on-1"
run_case
lock_race() {
  [[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && -z "$ERR" && "$(curl_calls)" == 0 \
    && "$(cat "$P/.node-download.lock/pid")" == "$$" && "$(ls -A "$P/.node-download.lock")" == pid ]]
}
check "two starts and one dead lock: a lock taken again meanwhile is never removed" lock_race

new_case partial-full-wrong
mkdir -p "$P"
"$REAL_HEAD" -c "$("$REAL_WC" -c <"$C/served/node-${NODE_V}-darwin-arm64.tar.gz")" /dev/zero >"$PARTIAL_ARM"
run_case
check "a partial file as long as the build but not it (killed before its delete): the refused resume deletes it" \
  eval 'failed_with "the download did not work" && [[ "$(curl_calls)" == 1 && ! -e "$PARTIAL_ARM" ]] && nothing_left'
run_case
check "so the next start downloads afresh, not the same refused request forever" \
  eval '[[ "$STATUS" -eq 0 && "$OUT" == "private(arm64) ${ARGS[*]} <STDIN-MARK>" && "$(curl_calls)" == 2 ]] && only_pinned_left arm64'

# ---------------------------------------------------------------- 10. --fetch-only (the setup's)
SAVED_ARGS=("${ARGS[@]}")
ARGS=(--fetch-only)
new_case fetch-only
node_stub "$C/bin/node" path-node v24.0.0
run_case
fetched_only() {
  [[ "$STATUS" -eq 0 && -z "$OUT" && -z "$ERR" && "$(curl_calls)" == 1 && "$LOG" == *"curl "*" -C - -o $PARTIAL_ARM "*" <>"* ]] \
    && only_pinned_left arm64 && [[ -x "$P/node-${NODE_V}-darwin-arm64/bin/node" ]]
}
check "--fetch-only gets the pinned copy even with a new node on PATH, runs nothing, prints nothing, exits 0" fetched_only
: >"$C/log"
run_case
check "--fetch-only with the pinned copy there: nothing downloaded, no lock taken, exits 0" \
  eval '[[ "$STATUS" -eq 0 && -z "$OUT" && -z "$ERR" && "$(curl_calls)" == 0 ]] && only_pinned_left arm64'

new_case fetch-only-fails
: >"$C/state/curl-fails"
run_case
check "--fetch-only that cannot download: one plain line, exit non-zero" \
  eval 'failed_with "the download did not work"'

new_case fetch-only-linux
echo Linux >"$C/state/os"
run_case
check "--fetch-only where there is no pinned build: one plain line, exit 1, nothing downloaded" \
  eval '[[ "$STATUS" -eq 1 && -z "$OUT" && "$ERR" == "Could not get Node.js for the team relay: there is no pinned build of it for this computer." && "$(curl_calls)" == 0 ]]'
ARGS=("${SAVED_ARGS[@]}")

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
