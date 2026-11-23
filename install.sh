#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The agentorg authors
# Installs AgentOrg on this Mac, for the account that runs it: the Mac app, which lends this Mac to
# agents; a Node of AgentOrg's own; the core, as a background service that starts at every login;
# and a launcher, `agentorg`. Then it opens the dashboard, signed in. Run again, it puts back what
# is missing. With --update, or when the release it pins is newer than the one installed, it moves
# to that release, and puts back what ran before if the new one doesn't answer.
#
#   curl -fsSL https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/get.sh | bash -s -- --update
#
# get.sh fetches this script from the release npm's channel names, and runs it once its sum checks.
# --app, --core and --node take files instead of downloading them, for a rehearsal of a build that
# isn't published; Node's is still checked against the sum below.
set -euo pipefail

# What this script installs: one release of AgentOrg, its core and its Mac app, and one Node.
AGENTORG_VERSION="0.0.39"
# The Mac app that release carries, which is AgentComputer's: its version, and its archive's sum,
# empty until one is published. Both are as mac-app.json pins them.
APP_VERSION="0.0.41"
APP_SHA256=""
NODE_VERSION="24.22.3"
NODE_SHA256="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"

LINE="curl -fsSL https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/get.sh | bash"
RELEASES="https://github.com/uniac-ai/AgentOrg/releases/download"
ROOT="$HOME/.agentorg"
BIN="$HOME/.local/bin"
CORE_APP="$ROOT/AgentOrg Core.app"
RECORD="$HOME/Library/Application Support/AgentOrg/computer/server.json"
# The line the launcher carries, so nothing overwrites a file that isn't AgentOrg's.
MARK="# AgentOrg's launcher, written by its install script."

say() { printf '%s\n' "$*"; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}

update=false
open=true
app_file=""
core_file=""
node_file=""
given() {
  [ -f "$1" ] || die "$1 isn't a file."
  printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}
while [ $# -gt 0 ]; do
  case "$1" in
  --update) update=true ;;
  --no-open) open=false ;;
  --app | --core | --node)
    [ $# -ge 2 ] || die "$1 takes a file."
    case "$1" in
    --app) app_file="$(given "$2")" ;;
    --core) core_file="$(given "$2")" ;;
    --node) node_file="$(given "$2")" ;;
    esac
    shift
    ;;
  -h | --help)
    say "Installs AgentOrg $AGENTORG_VERSION on this Mac, or with --update moves to it."
    say "Usage: bash install.sh [--update] [--no-open] [--app FILE.zip] [--core FILE.tgz] [--node FILE.tar.gz]"
    exit 0
    ;;
  *) die "Unknown option $1. Run it with --help to see what it takes." ;;
  esac
  shift
done

# This Mac: macOS 13 or later on Apple silicon (also under Rosetta), and the person's own account.
[ "$(uname -s)" = Darwin ] || die "This installs AgentOrg on a Mac. On another system, run it from npm: npx @agentorg/cli@next"
[ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ] || die "AgentOrg's Mac app runs on Apple silicon only for now."
version="$(sw_vers -productVersion)"
[ "${version%%.*}" -ge 13 ] || die "AgentOrg needs macOS 13 or later; this Mac has $version."
[ "$(id -u)" -ne 0 ] || die "Run this as yourself, not as root or with sudo: AgentOrg is installed for the account that uses it."
# With no Mac app published for this release and none given, nothing is installed, and nothing made.
[ -n "$APP_SHA256" ] || [ -n "$app_file" ] ||
  die "AgentOrg's Mac app for $AGENTORG_VERSION isn't published yet, so this can't install it. (A rehearsal gives a build of it with --app FILE.zip.)"
for tool in curl tar shasum ditto; do
  command -v "$tool" >/dev/null || die "$tool is missing from this Mac."
done

work="$(mktemp -d "${TMPDIR:-/tmp}/agentorg-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# A file at `url` into `out`, refused unless its SHA-256 is `sum`.
fetch_checked() {
  curl -fsSL --retry 2 -o "$3" "$1" || die "Couldn't download $1."
  check_sum "$3" "$2"
}
check_sum() {
  local got
  got="$(shasum -a 256 "$1" | cut -d' ' -f1)"
  [ "$got" = "$2" ] || die "$(basename "$1") isn't the file this script was written for (its SHA-256 is $got), so nothing was installed from it."
}

# The home: the one the launcher names, once there is one; else AGENTORG_HUB_HOME; else one an
# earlier AgentOrg made at its default, where it is; else ~/.agentorg/home.
launcher_home() {
  if [ -f "$BIN/agentorg" ]; then
    # shellcheck disable=SC2016 # The launcher's own line, matched as written: nothing in it expands.
    sed -n 's/^export AGENTORG_HUB_HOME="\${AGENTORG_HUB_HOME:-\(.*\)}"$/\1/p' "$BIN/agentorg"
  fi
}
data="$HOME/.local/share"
case "${XDG_DATA_HOME:-}" in /*) data="$XDG_DATA_HOME" ;; esac
home="$(launcher_home)"
if [ -z "$home" ] && [ -n "${AGENTORG_HUB_HOME:-}" ]; then
  case "$AGENTORG_HUB_HOME" in /*) home="$AGENTORG_HUB_HOME" ;; *) die "AGENTORG_HUB_HOME must be a full path." ;; esac
elif [ -z "$home" ] && [ -f "$data/agentorg/hub.db" ]; then
  home="$data/agentorg"
  say "Using the AgentOrg home already at $home."
fi
[ -n "$home" ] || home="$ROOT/home"
# The launcher's own commands use it too, whatever this shell says.
export AGENTORG_HUB_HOME="$home"
# A file at the launcher's place that isn't AgentOrg's stays as it is.
if [ -e "$BIN/agentorg" ] && ! grep -qF "$MARK" "$BIN/agentorg"; then
  die "There is already an agentorg at $BIN/agentorg that this script didn't write. Move it, then run this again."
fi

# --- The Mac app ---------------------------------------------------------------------------------

# Where it goes: /Applications when this account can write there, else its own. A rehearsal or a
# test names one folder instead, with AGENTORG_APP_DIR, and nothing else is looked in.
app_dirs=("/Applications" "$HOME/Applications")
[ -n "${AGENTORG_APP_DIR:-}" ] && app_dirs=("$AGENTORG_APP_DIR")
installed_app() {
  local dir
  for dir in "${app_dirs[@]}"; do
    [ -d "$dir/AgentOrg.app" ] && {
      printf '%s' "$dir/AgentOrg.app"
      return 0
    }
  done
  return 1
}
app_version() { /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null; }
# The pid of the app's service, by its record, while it runs.
app_pid() {
  local pid
  pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$RECORD" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}
# This release's app, checked, at `$work/app.zip`.
fetch_app() {
  local out="$work/app.zip"
  if [ -n "$app_file" ]; then
    cp "$app_file" "$out" || die "Couldn't read $app_file."
  else
    say "Downloading AgentOrg's Mac app…"
    fetch_checked "$RELEASES/v$AGENTORG_VERSION/AgentOrg-$AGENTORG_VERSION-mac-arm64.zip" "$APP_SHA256" "$out"
  fi
}
# Start the app at `app` in the background: 0 when it is, 2 when it waits for the person's
# approval in Login Items, which is said, and 1 when it can't.
register() {
  local status=0
  "$1/Contents/MacOS/AgentOrg" register >/dev/null || status=$?
  case "$status" in
  0) return 0 ;;
  2)
    say "AgentOrg's Mac app waits for your approval: switch it on in System Settings, General, Login Items."
    return 2
    ;;
  *) return 1 ;;
  esac
}
# Put the app from `archive` in place of any there, and start it: 0 or 2 as `register` answers, or
# 1 with what went wrong said. The new one is unpacked and checked before the old one is touched.
place_app() {
  local archive="$1" dir there status=0
  rm -rf "$work/new-app"
  mkdir -p "$work/new-app"
  ditto -x -k "$archive" "$work/new-app" || { say "Couldn't unpack the Mac app."; return 1; }
  [ -x "$work/new-app/AgentOrg.app/Contents/MacOS/AgentOrg" ] || { say "The Mac app's archive has no AgentOrg.app in it."; return 1; }
  dir="${app_dirs[0]}"
  [ -w "$dir" ] || [ -n "${AGENTORG_APP_DIR:-}" ] || dir="$HOME/Applications"
  if there="$(installed_app)"; then dir="$(dirname "$there")"; fi
  mkdir -p "$dir" && [ -w "$dir" ] || { say "Can't write in $dir, where AgentOrg's Mac app goes."; return 1; }
  if [ -n "$there" ]; then
    "$there/Contents/MacOS/AgentOrg" unregister >/dev/null 2>&1 || true
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$there" 2>/dev/null || true
    if ! rm -rf "$there"; then
      say "Couldn't remove the Mac app at $there, so it stays."
      register "$there" >/dev/null || true
      return 1
    fi
  fi
  mv "$work/new-app/AgentOrg.app" "$dir/AgentOrg.app" || { say "Couldn't put the Mac app in $dir."; return 1; }
  register "$dir/AgentOrg.app" || status=$?
  [ "$status" -ne 1 ] || say "AgentOrg's Mac app couldn't start in the background."
  return "$status"
}
# Wait up to 30 seconds for the app's service, by a record other than `not`'s.
wait_app() {
  local pid
  for _ in $(seq 1 60); do
    pid="$(app_pid || true)"
    [ -n "$pid" ] && [ "$pid" != "${1:-}" ] && return 0
    sleep 0.5
  done
  return 1
}

# --- Node and the core --------------------------------------------------------------------------

node_dir="$ROOT/runtime/node-v$NODE_VERSION-darwin-arm64"
there=""
# The pinned Node, unpacked in the work folder and moved into place whole.
install_node() {
  [ -x "$node_dir/bin/node" ] && return 0
  local archive="$work/node.tar.gz"
  if [ -n "$node_file" ]; then
    cp "$node_file" "$archive"
  else
    say "Downloading Node $NODE_VERSION…"
    curl -fsSL --retry 2 -o "$archive" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" || die "Couldn't download Node."
  fi
  check_sum "$archive" "$NODE_SHA256"
  tar -xzf "$archive" -C "$work" || die "Couldn't unpack Node."
  mkdir -p "$ROOT/runtime"
  rm -rf "$node_dir"
  mv "$work/node-v$NODE_VERSION-darwin-arm64" "$node_dir"
}
# The program the service runs, made in the work folder: that Node, named for AgentOrg, in a
# bundle of its own, so macOS lists it as AgentOrg Core rather than node.
make_core_bundle() {
  local bundle="$work/AgentOrg Core.app"
  rm -rf "$bundle"
  mkdir -p "$bundle/Contents/MacOS" || return 1
  cp "$node_dir/bin/node" "$bundle/Contents/MacOS/AgentOrg Core" || return 1
  cat >"$bundle/Contents/Info.plist" <<PLIST || return 1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>AgentOrg Core</string>
  <key>CFBundleIdentifier</key>
  <string>ai.uniac.agentorg.core</string>
  <key>CFBundleExecutable</key>
  <string>AgentOrg Core</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>$NODE_VERSION</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
PLIST
  codesign --force --sign - "$bundle" >/dev/null 2>&1 || true
}
# Whether the bundle in place carries this script's Node, as its Info.plist says.
bundle_current() { [ "$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$CORE_APP/Contents/Info.plist" 2>/dev/null)" = "$NODE_VERSION" ]; }
# The core at `version`, beside any other, installed in the work folder and moved into place
# whole. One already there stays: a new build goes in under a new version.
install_core() {
  local version="$1" into="$ROOT/app/$1" spec="@agentorg/cli@$1"
  [ -f "$into/node_modules/@agentorg/cli/dist/src/cli.js" ] && return 0
  [ -n "$core_file" ] && spec="$core_file"
  say "Installing AgentOrg $version…"
  PATH="$node_dir/bin:/usr/bin:/bin" NPM_CONFIG_UPDATE_NOTIFIER=false "$node_dir/bin/npm" install \
    --prefix "$work/core" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error "$spec" >/dev/null ||
    die "Couldn't install AgentOrg $version from npm."
  mkdir -p "$ROOT/app"
  rm -rf "$into"
  mv "$work/core" "$into"
}
installed_version() { "$node_dir/bin/node" -p 'require(process.argv[1]).version' "$ROOT/app/$1/node_modules/@agentorg/cli/package.json" 2>/dev/null; }
use_core() { ln -sfn "$1" "$ROOT/app/current"; }
write_launcher() {
  mkdir -p "$BIN"
  cat >"$BIN/agentorg.tmp" <<LAUNCHER
#!/bin/sh
$MARK
export AGENTORG_HUB_HOME="\${AGENTORG_HUB_HOME:-$home}"
exec "$CORE_APP/Contents/MacOS/AgentOrg Core" "$ROOT/app/current/node_modules/@agentorg/cli/dist/src/cli.js" "\$@"
LAUNCHER
  chmod 755 "$BIN/agentorg.tmp"
  mv "$BIN/agentorg.tmp" "$BIN/agentorg"
}
# The service on the current core: `agentorg start` writes it again when what it runs changed.
start_core() { "$BIN/agentorg" start --no-open; }
running_version() { "$BIN/agentorg" status 2>/dev/null | sed -n 's/^AgentOrg \([0-9][^ ]*\) is running.*/\1/p'; }

# --- Install ------------------------------------------------------------------------------------

install() {
  say "Setting up AgentOrg $AGENTORG_VERSION on this Mac."
  local kept=1 status=0
  # The app already at the version this release carries is kept, and only started; any other, or
  # one that can't start, is replaced.
  if [ -z "$app_file" ] && there="$(installed_app)" && [ "$(app_version "$there")" = "$APP_VERSION" ]; then
    kept=0
    register "$there" || kept=$?
  fi
  if [ "$kept" -eq 1 ]; then
    fetch_app
    place_app "$work/app.zip" || status=$?
    [ "$status" -ne 1 ] || die "AgentOrg's Mac app couldn't be put in place, so nothing more was installed."
  fi
  [ "$kept" -eq 2 ] || [ "$status" -eq 2 ] || wait_app ||
    say "AgentOrg's Mac app hasn't answered yet. AgentOrg goes on, and finds it when it does."
  install_node
  if ! bundle_current; then
    make_core_bundle || die "Couldn't make AgentOrg Core."
    # The service is stopped while its program is swapped, and started on the new one below.
    [ ! -x "$BIN/agentorg" ] || "$BIN/agentorg" stop >/dev/null 2>&1 || true
    rm -rf "$CORE_APP"
    mv "$work/AgentOrg Core.app" "$CORE_APP"
  fi
  install_core "$AGENTORG_VERSION"
  use_core "$AGENTORG_VERSION"
  write_launcher
  start_core
  if [ "$open" = true ]; then "$BIN/agentorg" open || true; fi
  say "Its files are in $ROOT. To update it later: $LINE -s -- --update"
  case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "To run agentorg by name, add $BIN to your PATH: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zprofile" ;;
  esac
}

# --- Update -------------------------------------------------------------------------------------

update() {
  local from
  from="$(readlink "$ROOT/app/current")"
  if [ "$from" = "$AGENTORG_VERSION" ]; then
    say "AgentOrg is up to date: $from."
    return 0
  fi
  if [ "$(printf '%s\n%s\n' "$from" "$AGENTORG_VERSION" | sort -V | tail -1)" = "$from" ]; then
    say "AgentOrg $from is newer than this script's $AGENTORG_VERSION: nothing to do."
    return 0
  fi
  say "Updating AgentOrg from $from to $AGENTORG_VERSION."
  # What runs now is kept here until the new release answers, so either can stand.
  local kept="$ROOT/update-backup" before="$ROOT/update-backup/home" status=0 old_pid
  # An earlier update cut off between taking the home away and putting it back left it here.
  if [ -d "$before" ] && [ ! -e "$home" ]; then
    mv "$before" "$home" || die "An earlier update left AgentOrg's home at $before. Move it back to $home."
    say "Put back the home an earlier update kept."
  fi
  rm -rf "$kept"
  mkdir -p "$kept"
  # Everything new is fetched and checked first.
  fetch_app
  if there="$(installed_app)"; then
    ditto -c -k --keepParent "$there" "$kept/app.zip" || die "Couldn't keep a copy of the Mac app there now, so nothing was changed."
  fi
  install_node
  install_core "$AGENTORG_VERSION"
  bundle_current || make_core_bundle || die "Couldn't make AgentOrg Core, so nothing was changed."
  # The home is copied with nothing running on it, so the copy is whole.
  "$BIN/agentorg" stop >/dev/null
  if ! cp -Rpc "$home/" "$before" 2>/dev/null && ! cp -Rp "$home/" "$before"; then
    rm -rf "$kept"
    start_core >/dev/null || true
    die "Couldn't copy the home before updating, so AgentOrg $from runs as it was."
  fi
  if [ -d "$work/AgentOrg Core.app" ]; then
    if ! { mv "$CORE_APP" "$kept/AgentOrg Core.app" && mv "$work/AgentOrg Core.app" "$CORE_APP"; }; then
      die "Couldn't swap AgentOrg Core. What ran before is in $kept."
    fi
  fi
  # Back to what ran before: the service stopped first, then its program, core and home. True when
  # that one answers again.
  core_back() {
    "$BIN/agentorg" stop >/dev/null 2>&1 || true
    if [ -d "$kept/AgentOrg Core.app" ]; then
      rm -rf "$CORE_APP" && mv "$kept/AgentOrg Core.app" "$CORE_APP" || return 1
    fi
    use_core "$from"
    rm -rf "$ROOT/app/$AGENTORG_VERSION"
    # The home is replaced only by a copy that is a whole AgentOrg home; else it stays as it is.
    if [ -f "$before/hub.db" ]; then
      rm -rf "$home" && mv "$before" "$home" || return 1
    else
      home_back=false
    fi
    write_launcher
    start_core >/dev/null && [ -n "$(running_version)" ]
  }
  # What is said once it has gone back: which of the two answers again.
  back() {
    local home_back=true
    if ! core_back; then
      printf '%s' "AgentOrg $from couldn't be started again: run agentorg start, and see $home/logs/core.log"
    elif [ "$home_back" = true ]; then
      printf '%s' "AgentOrg $from is back, with its home as it was"
    else
      printf '%s' "AgentOrg $from is back, but its home stays as $AGENTORG_VERSION left it, since the copy kept before updating wasn't a whole home"
    fi
  }
  use_core "$AGENTORG_VERSION"
  write_launcher
  local running
  running="$(start_core >/dev/null && running_version || true)"
  if [ -z "$running" ] || [ "$running" != "$(installed_version "$AGENTORG_VERSION")" ]; then
    die "AgentOrg $AGENTORG_VERSION didn't answer. $(back)."
  fi
  old_pid="$(app_pid || true)"
  place_app "$work/app.zip" || status=$?
  if [ "$status" -eq 1 ] || { [ "$status" -eq 0 ] && ! wait_app "$old_pid"; }; then
    local said
    said="$(back)"
    if [ ! -f "$kept/app.zip" ]; then
      die "AgentOrg's Mac app of $AGENTORG_VERSION didn't start. $said; there was no Mac app before."
    fi
    status=0
    place_app "$kept/app.zip" >/dev/null || status=$?
    if [ "$status" -eq 1 ]; then
      die "AgentOrg's Mac app of $AGENTORG_VERSION didn't start. $said, but its Mac app couldn't be put back. A copy of it is $kept/app.zip."
    fi
    # A home that couldn't be put back stays kept, for the next run to put back.
    [ -d "$before" ] || rm -rf "$kept"
    die "AgentOrg's Mac app of $AGENTORG_VERSION didn't start. $said, and so is its Mac app."
  fi
  # Both answer: what was kept for going back goes.
  rm -rf "$kept" "$ROOT/app/$from"
  say "AgentOrg is updated to $AGENTORG_VERSION."
}

mkdir -p "$ROOT"
chmod 700 "$ROOT"
if [ -L "$ROOT/app/current" ] && { [ "$update" = true ] || [ "$(readlink "$ROOT/app/current")" != "$AGENTORG_VERSION" ]; }; then
  update
elif [ "$update" = true ]; then
  die "AgentOrg isn't installed here by this script yet. Run it without --update: $LINE"
else
  install
fi
