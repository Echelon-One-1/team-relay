#!/bin/bash
# Team relay: one-command setup for a team member's Mac (docs/M11-SPEC.md §5).
#
#   curl -fsSL https://<relay host>/setup | bash
#
# The relay serves this file at GET /setup with its two settings filled in below. It runs as you
# (never sudo), only on macOS, and is safe to run again: every step checks first. Its only network
# calls are to the relay, to GitHub (the plugin marketplace) and, only if you say yes, to Claude
# Code's official installer. It holds no secret.
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
MIN_NODE_MAJOR=22
# Where questions are read from. Only the tests change it.
TTY="${TEAM_RELAY_SETUP_TTY:-/dev/tty}"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
stop() {
  printf '\n%s\n' "$*" >&2
  printf 'Setup stopped. Nothing else was changed. You can run the same command again at any time.\n' >&2
  exit 1
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
  say "This connects Claude Code on this Mac to your team. It takes a few minutes and asks a few questions."

  # ---------------------------------------------------------------- settings from the relay
  if [[ "$RELAY_URL" == __*__ || "$MARKETPLACE" == __*__ ]]; then
    stop "This copy of the setup script was not filled in by a relay. Use the command from your team's console: curl -fsSL https://<your relay>/setup | bash"
  fi
  if [[ ! "$RELAY_URL" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$ ]]; then
    stop "The relay address in this script does not look right. Ask your team's owner for the setup command."
  fi
  if [[ ! "$MARKETPLACE" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$ || "${MARKETPLACE#*/}" == "." || "${MARKETPLACE#*/}" == ".." ]]; then
    stop "The plugin source in this script does not look right. Ask your team's owner for the setup command."
  fi

  # ---------------------------------------------------------------- this computer
  local os
  os="$(uname -s 2>/dev/null || true)"
  if [[ "$os" != "Darwin" ]]; then
    stop "This setup works on a Mac only. On this computer (${os:-unknown system}), ask your team's owner how to join."
  fi
  if [[ "${EUID:-0}" -eq 0 ]]; then
    stop "Please run the command as yourself, without sudo."
  fi
  if ! { : <"$TTY"; } 2>/dev/null; then
    stop "Please run the command in the Terminal app, so it can ask you questions."
  fi

  # ---------------------------------------------------------------- 1. Node.js
  step "1/5 Checking Node.js"
  NODE="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE" ]]; then
    stop "Node.js is not installed. Install the LTS version from https://nodejs.org (the macOS installer), then run this command again."
  fi
  local version major
  version="$("$NODE" --version </dev/null 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < MIN_NODE_MAJOR )); then
    stop "Node.js ${version:-of an unknown version} is too old; version ${MIN_NODE_MAJOR} or newer is needed. Install the LTS version from https://nodejs.org, then run this command again."
  fi
  say "Node.js ${version}: ok"

  # ---------------------------------------------------------------- 2. Claude Code
  step "2/5 Checking Claude Code"
  if ! CLAUDE="$(find_claude)"; then
    say "Claude Code is not installed on this Mac."
    printf 'Install Claude Code now? [y/N] '
    local answer=""
    read -r answer <"$TTY" || answer=""
    case "$answer" in
      y|Y|yes|YES|Yes) ;;
      *) stop "Claude Code is needed. Install it from https://claude.ai/download, then run this command again." ;;
    esac
    say "Installing Claude Code with its official installer..."
    if ! curl -fsSL https://claude.ai/install.sh </dev/null | bash; then
      stop "Claude Code could not be installed. Install it from https://claude.ai/download, then run this command again."
    fi
    if ! CLAUDE="$(find_claude)"; then
      stop "Claude Code was installed but cannot be found yet. Open a new Terminal window and run this command again."
    fi
  fi
  say "Claude Code: ${CLAUDE}"

  local status_json
  status_json="$("$CLAUDE" auth status --json </dev/null 2>/dev/null || true)"
  if ! printf '%s' "$status_json" | "$NODE" -e '
let s = {};
try { s = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
process.exit(s && s.loggedIn === true ? 0 : 1);
'; then
    say "Claude Code is not signed in. Sign in now (a browser window may open)."
    "$CLAUDE" auth login <"$TTY" || stop "Claude Code sign-in did not finish."
  fi
  say "Claude Code is signed in: ok"

  # ---------------------------------------------------------------- 3. the plugin
  step "3/5 Installing the team relay plugin"
  local name
  name="$(marketplace_name)"
  if [[ -z "$name" ]]; then
    say "Adding the plugin source ${MARKETPLACE}..."
    "$CLAUDE" plugin marketplace add "$MARKETPLACE" </dev/null \
      || stop "Could not add the plugin source ${MARKETPLACE}. Check your internet connection and that you can open https://github.com/${MARKETPLACE}."
    name="$(marketplace_name)"
    name="${name:-$FALLBACK_MARKETPLACE_NAME}"
  else
    say "Refreshing the plugin source..."
    "$CLAUDE" plugin marketplace update "$name" </dev/null \
      || say "(Could not refresh it now; using the copy already on this Mac.)"
  fi
  local plugin_id="${PLUGIN}@${name}"
  if plugin_installed "$plugin_id"; then
    say "Updating ${plugin_id}..."
    "$CLAUDE" plugin update --scope user "$plugin_id" </dev/null || stop "Could not update the plugin ${plugin_id}."
  else
    say "Installing ${plugin_id}..."
    "$CLAUDE" plugin install --scope user "$plugin_id" </dev/null || stop "Could not install the plugin ${plugin_id}."
  fi

  local plugin_dir
  plugin_dir="$(install_path "$plugin_id")"
  if [[ -z "$plugin_dir" || ! -f "$plugin_dir/dist/setup-cli.js" ]]; then
    stop "The plugin is installed, but its setup tool was not found. Ask your team's owner to check the plugin version."
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
    say "Google Drive is not connected yet; the rest of the setup goes on. To connect Drive later, run the same setup command again."
  fi
  "$NODE" "$setup_cli" daemon install --claude "$CLAUDE" --plugin "$plugin_id" <"$TTY" \
    || stop "Starting the background answerer did not finish."

  # ---------------------------------------------------------------- 5. where things stand
  step "5/5 Checking everything"
  "$NODE" "$setup_cli" status <"$TTY" || say "(Could not read your status from the team just now.)"

  say ""
  say "Almost done. Open your team's console and accept the team's boundaries:"
  say "   ${RELAY_URL}/"
  say "Open it to accept the boundaries."
}

main "$@"
