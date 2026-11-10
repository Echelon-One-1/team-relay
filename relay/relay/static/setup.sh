#!/bin/bash
# Team relay: one-command setup for a team member's Mac (docs/M11-SPEC.md §5, and its section
# "Simpler joining").
#
#   curl -fsSL https://<relay host>/setup | bash
#
# The relay serves this file at GET /setup with its two settings filled in below. It runs as you
# (never sudo), only on macOS, and is safe to run again: every step checks first. Its only network
# calls are to the relay, to GitHub (the plugin marketplace), to nodejs.org (one pinned Node.js
# build, checked against its SHA-256 below, when this Mac does not have that build yet) and, only
# if you say yes, to Claude Code's official installer. It holds no secret.
#
# Everything it says is for people who have never used Terminal: plain words, no tool names.
#
# Bash 3.2 (macOS /bin/bash). The script arrives on stdin, so every command it runs reads either
# the terminal (questions) or nothing: never stdin, which is the rest of this script. The whole
# script is one function, called on the last line, so bash has read all of it before anything runs.
set -euo pipefail

# Filled in by the relay. The checks below refuse anything else.
RELAY_URL='__RELAY_URL__'
MARKETPLACE='__MARKETPLACE__'

PLUGIN="team-relay"
FALLBACK_MARKETPLACE_NAME="team-relay-dev"
# The oldest Node.js the plugin runs on (its package.json "engines"; plugin/bin/run-node checks the same).
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12
# The Node.js build the setup runs with (and the plugin falls back to): the official macOS tarball,
# pinned by version and by SHA-256 (from https://nodejs.org/dist/v22.23.4/SHASUMS256.txt). A
# download with any other hash is refused. Nothing but an edit of this file changes these (the
# tests edit a copy, never the environment).
NODE_VERSION='v22.23.4'
NODE_SHA256_ARM64='c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428'
NODE_SHA256_X64='efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819'
# Where questions are read from. Only the tests change it.
TTY="${TEAM_RELAY_SETUP_TTY:-/dev/tty}"
# A download in progress, removed on exit (set by install_node).
WORK_DIR=""

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
stop() {
  printf '\n%s\n' "$*" >&2
  printf 'Setup stopped. You can paste the same line into Terminal again at any time.\n' >&2
  exit 1
}
cleanup() {
  if [[ -n "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}

# Whether the node at $1 runs and is new enough (22.12 or newer).
node_ok() {
  local v
  [[ -n "$1" && -x "$1" ]] || return 1
  v="$("$1" --version </dev/null 2>/dev/null || true)"
  [[ "$v" =~ ^v([0-9]+)\.([0-9]+)\. ]] || return 1
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  (( 10#$major > MIN_NODE_MAJOR || (10#$major == MIN_NODE_MAJOR && 10#$minor >= MIN_NODE_MINOR) ))
}

# Sets NODE_ARCH and NODE_SHA256 for this Mac's processor, and the private copy's place:
# $PRIVATE_DIR/node-<version>-darwin-<arch> (the tarball's own name, so a new pin is a new folder).
private_node_for_this_mac() {
  case "$(uname -m 2>/dev/null || true)" in
    arm64) NODE_ARCH=arm64; NODE_SHA256="$NODE_SHA256_ARM64" ;;
    x86_64) NODE_ARCH=x64; NODE_SHA256="$NODE_SHA256_X64" ;;
    *) stop "This kind of Mac is not supported by the setup. Ask your team's owner for help." ;;
  esac
  PRIVATE_NODE_DIR="$PRIVATE_DIR/node-${NODE_VERSION}-darwin-${NODE_ARCH}"
  PRIVATE_NODE="$PRIVATE_NODE_DIR/bin/node"
}

# Downloads the pinned Node.js build for this Mac's processor, checks its SHA-256 and unpacks it
# to $PRIVATE_NODE_DIR. It unpacks into a temporary folder beside it and renames that into place,
# so a half-unpacked copy is never used. No sudo: everything is in the member's own folders.
install_node() {
  local name="node-${NODE_VERSION}-darwin-${NODE_ARCH}"
  say "Getting a helper the setup needs (about 50 MB)..."
  mkdir -p "$PRIVATE_DIR" || stop "The setup could not make its folder on this Mac."
  chmod 700 "$PRIVATE_DIR" || stop "The setup could not make its folder on this Mac."
  WORK_DIR="$(mktemp -d "$PRIVATE_DIR/.download.XXXXXX")" || stop "The setup could not make its folder on this Mac."
  if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK_DIR/node.tar.gz" \
      "https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz" </dev/null; then
    stop "The download did not work. Check your internet connection, then run the setup line again."
  fi
  local got
  got="$(shasum -a 256 "$WORK_DIR/node.tar.gz" </dev/null 2>/dev/null || true)"
  got="${got%% *}"
  if [[ "$got" != "$NODE_SHA256" ]]; then
    stop "The download was not the file it should be, so nothing was installed. Try again later. If this happens again, tell your team's owner."
  fi
  if ! tar -xzf "$WORK_DIR/node.tar.gz" -C "$WORK_DIR" </dev/null || [[ ! -x "$WORK_DIR/$name/bin/node" ]]; then
    stop "The download could not be unpacked. Run the setup line again."
  fi
  # A copy that is there but does not run is set aside (and removed with the download folder).
  if [[ -e "$PRIVATE_NODE_DIR" || -L "$PRIVATE_NODE_DIR" ]]; then
    mv "$PRIVATE_NODE_DIR" "$WORK_DIR/old" || stop "The setup could not replace its old copy. Run the setup line again."
  fi
  mv "$WORK_DIR/$name" "$PRIVATE_NODE_DIR" || stop "The download could not be put in place. Run the setup line again."
  rm -rf "$WORK_DIR" 2>/dev/null || true
  WORK_DIR=""
  node_ok "$PRIVATE_NODE" || stop "The helper the setup needs does not run on this Mac. Ask your team's owner for help."
  say "Done."
}

# Removes the private copies of other Node.js versions ($PRIVATE_DIR/node-v*, nothing else there),
# once the background answerer runs with the current one. Not being able to is not an error.
remove_other_nodes() {
  local d
  for d in "$PRIVATE_DIR"/node-v*; do
    [[ -e "$d" || -L "$d" ]] || continue
    [[ "$d" == "$PRIVATE_NODE_DIR" ]] && continue
    rm -rf "$d" 2>/dev/null || true
  done
}

find_claude() {
  local c
  if c="$(command -v claude 2>/dev/null)" && [[ -n "$c" && -x "$c" ]]; then
    printf '%s\n' "$c"
    return 0
  fi
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    if [[ -x "$c" ]]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

# The local name of the marketplace that points at $MARKETPLACE (owner/repo), or nothing.
# From `claude plugin marketplace list --json`, else from known_marketplaces.json.
marketplace_name() {
  local listed
  listed="$("$CLAUDE" plugin marketplace list --json </dev/null 2>/dev/null || true)"
  printf '%s' "$listed" | "$NODE" -e '
const fs = require("fs");
const want = process.argv[1].toLowerCase();
const matches = (s) => {
  if (!s || typeof s !== "object") return false;
  if (typeof s.repo === "string" && s.repo.toLowerCase() === want) return true;
  if (typeof s.url === "string") {
    const u = s.url.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
    return u === "https://github.com/" + want || u === "git@github.com:" + want;
  }
  return false;
};
let found = "";
try {
  const list = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const m of Array.isArray(list) ? list : []) {
    if (m && typeof m.name === "string" && matches(m)) { found = m.name; break; }
  }
} catch {}
if (!found) {
  try {
    const known = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/plugins/known_marketplaces.json", "utf8"));
    for (const [name, m] of Object.entries(known || {})) {
      if (matches(m && m.source)) { found = name; break; }
    }
  } catch {}
}
if (/^[A-Za-z0-9._-]{1,100}$/.test(found)) process.stdout.write(found);
' "$MARKETPLACE" 2>/dev/null || true
}

# Where the plugin is installed: the first user-scope entry with an absolute installPath under
# exactly $1 (team-relay@<marketplace name>) in installed_plugins.json, never another scope or
# marketplace. The background answerer's launcher uses the same rule (plugin/src/daemon-launch.ts).
install_path() {  # $1: plugin id
  "$NODE" -e '
const fs = require("fs");
const path = require("path");
const id = process.argv[1];
if (!/^team-relay@[A-Za-z0-9._-]{1,100}$/.test(id)) process.exit(0);
let list = [];
try {
  const j = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/plugins/installed_plugins.json", "utf8"));
  if (j && j.plugins && typeof j.plugins === "object" && Object.prototype.hasOwnProperty.call(j.plugins, id)) list = j.plugins[id];
} catch {}
const pick = Array.isArray(list)
  ? list.find((e) => e && typeof e === "object" && e.scope === "user" && typeof e.installPath === "string" && path.isAbsolute(e.installPath))
  : undefined;
if (pick) process.stdout.write(pick.installPath);
' "$1" </dev/null 2>/dev/null || true
}

# Installed for this user: the same rule as install_path. An install for a project only does not
# count, so the plugin is then installed for this user.
plugin_installed() {  # $1: plugin id
  [[ -n "$(install_path "$1")" ]]
}

main() {
  say "Team relay setup"
  say "This connects your Mac to your team. It takes about 2 minutes and asks a few questions."

  # ---------------------------------------------------------------- settings from the relay
  if [[ "$RELAY_URL" == __*__ || "$MARKETPLACE" == __*__ ]]; then
    stop "This copy of the setup was not made by your team's page. Copy the setup line from your team's page instead."
  fi
  if [[ ! "$RELAY_URL" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$ ]]; then
    stop "This setup line does not look right (the team's address). Ask your team's owner for a new one."
  fi
  if [[ ! "$MARKETPLACE" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$ || "${MARKETPLACE#*/}" == "." || "${MARKETPLACE#*/}" == ".." ]]; then
    stop "This setup line does not look right (where the team tools come from). Ask your team's owner for a new one."
  fi

  # ---------------------------------------------------------------- this computer
  local os
  os="$(uname -s 2>/dev/null || true)"
  if [[ "$os" != "Darwin" ]]; then
    stop "This setup works on a Mac only. Ask your team's owner how to join from this computer."
  fi
  if [[ "${EUID:-0}" -eq 0 ]]; then
    stop "Please run the line as yourself, without sudo."
  fi
  if ! { : <"$TTY"; } 2>/dev/null; then
    stop "Please paste the line into the Terminal app, so the setup can ask you questions."
  fi
  trap cleanup EXIT

  # ---------------------------------------------------------------- 1. a Node.js to run the setup with
  # Always the pinned build in $PRIVATE_DIR (downloaded and checked when it is not there or does
  # not run), whatever node Terminal has: the Claude Code app may not see Terminal's PATH, and the
  # plugin's launcher (plugin/bin/run-node) falls back to this copy when it finds no node 22.12 or
  # newer there. It runs setup-cli and the background answerer. Nothing is linked onto PATH.
  step "1/5 Getting ready"
  PRIVATE_DIR="$HOME/.local/share/team-relay"
  private_node_for_this_mac
  if ! node_ok "$PRIVATE_NODE"; then install_node; fi
  NODE="$PRIVATE_NODE"
  say "Ready."

  # ---------------------------------------------------------------- 2. Claude Code
  step "2/5 Checking Claude Code"
  if ! CLAUDE="$(find_claude)"; then
    say "Claude Code is not on this Mac yet."
    printf 'Install Claude Code now? [y/N] '
    local answer=""
    read -r answer <"$TTY" || answer=""
    case "$answer" in
      y|Y|yes|YES|Yes) ;;
      *) stop "Claude Code is needed. Get it from https://claude.ai/download, then run the setup line again." ;;
    esac
    say "Installing Claude Code..."
    if ! curl -fsSL https://claude.ai/install.sh </dev/null | bash; then
      stop "Claude Code could not be installed. Get it from https://claude.ai/download, then run the setup line again."
    fi
    if ! CLAUDE="$(find_claude)"; then
      stop "Claude Code is installed but cannot be found yet. Open a new Terminal window and run the setup line again."
    fi
  fi
  say "Claude Code is installed."

  local status_json
  status_json="$("$CLAUDE" auth status --json </dev/null 2>/dev/null || true)"
  if ! printf '%s' "$status_json" | "$NODE" -e '
let s = {};
try { s = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
process.exit(s && s.loggedIn === true ? 0 : 1);
'; then
    say "Please sign in to Claude Code (a browser window may open)."
    "$CLAUDE" auth login <"$TTY" || stop "Signing in to Claude Code did not finish."
  fi
  say "Claude Code is signed in."

  # ---------------------------------------------------------------- 3. the plugin
  step "3/5 Adding the team tools to Claude Code"
  local name
  name="$(marketplace_name)"
  if [[ -z "$name" ]]; then
    "$CLAUDE" plugin marketplace add "$MARKETPLACE" </dev/null \
      || stop "The team tools could not be downloaded. Check your internet connection, then run the setup line again."
    name="$(marketplace_name)"
    name="${name:-$FALLBACK_MARKETPLACE_NAME}"
  else
    "$CLAUDE" plugin marketplace update "$name" </dev/null \
      || say "(Could not check for a newer version just now; using the one on this Mac.)"
  fi
  local plugin_id="${PLUGIN}@${name}"
  if plugin_installed "$plugin_id"; then
    say "Updating the team tools..."
    "$CLAUDE" plugin update --scope user "$plugin_id" </dev/null || stop "The team tools could not be updated. Run the setup line again."
  else
    say "Installing the team tools..."
    "$CLAUDE" plugin install --scope user "$plugin_id" </dev/null || stop "The team tools could not be installed. Run the setup line again."
  fi

  local plugin_dir
  plugin_dir="$(install_path "$plugin_id")"
  if [[ -z "$plugin_dir" || ! -f "$plugin_dir/dist/setup-cli.js" ]]; then
    stop "The team tools are installed, but a part of them is missing. Tell your team's owner."
  fi
  local setup_cli="$plugin_dir/dist/setup-cli.js"

  # ---------------------------------------------------------------- 4. sign-in, folders, Drive, background answering
  step "4/5 Connecting you to the team"
  "$NODE" "$setup_cli" login --relay "$RELAY_URL" <"$TTY" || stop "Signing in to the team did not finish."
  "$NODE" "$setup_cli" folders <"$TTY" || stop "Choosing your folders did not finish."
  # Drive before the background answerer (so its first status already says connected), but a
  # cancelled or failed Drive sign-in does not stop the setup.
  if ! "$NODE" "$setup_cli" drive <"$TTY"; then
    say ""
    say "Google Drive is not connected yet. The rest of the setup goes on. To connect it later, run the setup line again."
  fi
  "$NODE" "$setup_cli" daemon install --claude "$CLAUDE" --plugin "$plugin_id" <"$TTY" \
    || stop "Your Mac could not be set to answer your team. Run the setup line again."
  # The background answerer now runs with $NODE: older private copies are no longer used.
  remove_other_nodes

  # ---------------------------------------------------------------- 5. where things stand
  # status --after-setup waits for the Mac's first check-in and ends with the closing line itself
  # ("Done. Go back to the team page in your browser", with "and click Accept" only when something
  # is not accepted yet).
  step "5/5 Checking everything"
  if ! "$NODE" "$setup_cli" status --after-setup <"$TTY"; then
    say "(Could not check with the team just now.)"
    say ""
    say "Done. Go back to the team page in your browser."
  fi
  say "   ${RELAY_URL}/"
}

main "$@"
