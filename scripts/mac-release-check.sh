#!/usr/bin/env bash
# What a release of AgentOrg carries, checked on a Mac before anything is published. The release
# workflow's mac-check job runs these in turn, when the release carries a Mac app:
#
#   scripts/mac-release-check.sh apple VERSION FROM   Apple's checks on the Mac app's zip
#   scripts/mac-release-check.sh fresh VERSION FROM   a fresh install from FROM's files
#   scripts/mac-release-check.sh uninstall            agentorg uninstall, the Mac app with it
#   scripts/mac-release-check.sh update VERSION FROM  the release before installed, then updated,
#                                                     back, and updated again
#
# FROM holds the run's files: the Mac app, AgentOrg-<version>-mac-arm64.zip, and the core,
# agentorg-core-<version>.tgz. install.sh is the checkout's own. `update` runs `gh`, which needs
# GH_TOKEN, and GH_REPO outside a checkout. In a workflow, it sets the step's output `updated` to
# true or false.
#
# fresh, uninstall and update install into this account, as a person's Mac has it, so they run
# only on a GitHub-hosted macOS runner, never on a person's own Mac. They use the account's own
# home: launchd runs the Mac app's background item with it, and the app keeps its record there,
# where install.sh looks for it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
usage="Usage: scripts/mac-release-check.sh apple|fresh|update VERSION FROM
       scripts/mac-release-check.sh uninstall"

# What install.sh lays out in the account, the core's service, and the Mac app's record.
ROOT="$HOME/.agentorg"
LAUNCHER="$HOME/.local/bin/agentorg"
SERVICE="ai.uniac.agentorg.core"
RECORD="$HOME/Library/Application Support/AgentOrg/computer/server.json"
# The Mac app's background item, as launchd labels it.
BACKGROUND="ai.uniac.agentorg.provider"
# Where a check stops at that item, with why it may be the runner's doing.
RUNNER_MAY="it may be the runner, which can't register the app's background item, not the release."

say() { printf '%s\n' "$*"; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
output() { [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s\n' "$1" >>"$GITHUB_OUTPUT"; }
is_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Not a version: \"$1\"."; }
# Each file must be there, under the name the release gives it.
need() {
  local file
  for file in "$@"; do
    [ -f "$file" ] || die "$(dirname "$file") has no $(basename "$file"), which this release carries."
  done
}

# What installs into the account runs only on a GitHub-hosted macOS runner.
on_runner() {
  [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ "$(uname -s)" = Darwin ] ||
    die "$1 installs AgentOrg into this account, so it runs only on a GitHub-hosted macOS runner, never on a person's own Mac."
}
# The Mac app installed, as agentorg uninstall finds it: in the one folder AGENTORG_APP_DIR names,
# else in /Applications or the account's own.
mac_app() {
  local dirs=(/Applications "$HOME/Applications") dir
  [ -z "${AGENTORG_APP_DIR:-}" ] || dirs=("$AGENTORG_APP_DIR")
  for dir in "${dirs[@]}"; do
    if [ -d "$dir/AgentOrg.app" ]; then
      printf '%s' "$dir/AgentOrg.app"
      return 0
    fi
  done
  return 1
}
# An install here is a fresh one only in an account without AgentOrg or its Mac app.
none_yet() {
  [ ! -e "$LAUNCHER" ] && [ ! -e "$ROOT/app" ] && ! mac_app >/dev/null ||
    die "This account has AgentOrg already, so an install here wouldn't be a fresh one."
}

# What launchd has of the Mac app's background item, for a check that stops there.
background_item() { launchctl print "gui/$(id -u)/$BACKGROUND" >&2 || true; }

# install.sh, with what it says shown. Where its own words say the Mac app's background item
# stopped it, the last line says so: registering it failed on an install, or the app didn't start
# on an update.
install_sh() {
  local log status
  log="$(mktemp)"
  say "\$ bash $*"
  set +e
  bash "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  set -e
  [ "$status" -eq 0 ] && return 0
  if grep -qE "couldn't start in the background|Mac app of [^ ]+ didn't start" "$log"; then
    background_item
    die "install.sh failed, with exit code $status, at the Mac app's background item: $RUNNER_MAY"
  fi
  die "install.sh failed, with exit code $status."
}

# The core answers, at `version`, as agentorg status says.
answers() {
  local said running
  said="$("$LAUNCHER" status)" || die "AgentOrg's core doesn't answer. agentorg status says: $said"
  say "$said"
  running="$(sed -n 's/^AgentOrg \([0-9][^ ]*\) is running.*/\1/p' <<<"$said")"
  [ "$running" = "$1" ] || die "AgentOrg ${running:-of no version} is running, not $1."
}

# The Mac app where install.sh puts it: the folder AGENTORG_APP_DIR names, else /Applications when
# this account can write there, else its own; at the version the checkout's install.sh pins.
app_placed() {
  local dir="/Applications" pinned got
  [ -w "$dir" ] || dir="$HOME/Applications"
  [ -z "${AGENTORG_APP_DIR:-}" ] || dir="$AGENTORG_APP_DIR"
  [ -x "$dir/AgentOrg.app/Contents/MacOS/AgentOrg" ] || die "The Mac app isn't in $dir, where install.sh puts it."
  pinned="$(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p' "$root/install.sh")"
  got="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$dir/AgentOrg.app/Contents/Info.plist")"
  [ "$got" = "$pinned" ] || die "The Mac app in $dir is $got, not the $pinned install.sh pins."
  say "The Mac app $got is in $dir."
}

# The pid in the Mac app's record, while that process runs.
app_pid() {
  local pid
  pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$RECORD" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}
# The Mac app's service answers: launchd started it by its background item, and it left its
# record, with a live pid, where install.sh looks for it. After an update, that pid must be another
# than `before`'s, the app's before it, as install.sh's own wait has it.
app_answers() {
  local before="${1:-}" pid
  for _ in $(seq 1 60); do
    pid="$(app_pid || true)"
    if [ -n "$pid" ] && [ "$pid" != "$before" ]; then
      say "The Mac app's service answers, as pid $pid."
      return 0
    fi
    sleep 0.5
  done
  background_item
  die "The Mac app's service left no record with a live pid${before:+ other than $before, the one before the update,} at $RECORD within 30 seconds: $RUNNER_MAY"
}

# Apple's checks on the app in the zip, as a Mac that downloads it makes them: its signature,
# Gatekeeper's assessment, as notarized by a Developer ID, and the notarization ticket stapled to
# it. Each must pass.
apple() {
  local zip at said
  zip="$(zip_of "$1")"
  need "$zip"
  at="$(mktemp -d)"
  # shellcheck disable=SC2064 # The folder is named now: `at` is gone by the time the script exits.
  trap "rm -rf '$at'" EXIT
  ditto -x -k "$zip" "$at" || die "Couldn't unpack $zip."
  [ -d "$at/AgentOrg.app" ] || die "$(basename "$zip") has no AgentOrg.app in it."
  passes "its signature" codesign --verify --deep --strict --verbose=2 "$at/AgentOrg.app"
  # A Mac with Gatekeeper switched off accepts anything, and says so instead of the app's source.
  passes "Gatekeeper's assessment" spctl -a -t exec -vv "$at/AgentOrg.app"
  grep -qxF "source=Notarized Developer ID" <<<"$said" ||
    die "Gatekeeper doesn't assess the Mac app as notarized by a Developer ID, so the release stops here."
  passes "its notarization ticket" xcrun stapler validate "$at/AgentOrg.app"
  say "The Mac app in $(basename "$zip") passes Apple's checks: its signature, Gatekeeper's assessment and its notarization ticket."
}
# One of Apple's checks, with what it says, its own errors too, shown and kept in `said`.
passes() {
  local what="$1" status=0
  shift
  say "\$ $*"
  said="$("$@" 2>&1)" || status=$?
  [ -z "$said" ] || say "$said"
  [ "$status" -eq 0 ] || die "The Mac app fails $what: $1 exited with $status, so the release stops here."
}

zip_of() { printf '%s/AgentOrg-%s-mac-arm64.zip' "$1" "$version"; }
core_of() { printf '%s/agentorg-core-%s.tgz' "$1" "$version"; }

# A fresh install of this release, from the run's own files, as a person's Mac has it.
fresh() {
  local zip core
  zip="$(zip_of "$1")"
  core="$(core_of "$1")"
  need "$zip" "$core"
  on_runner fresh
  none_yet
  install_sh "$root/install.sh" --app "$zip" --core "$core" --no-open
  answers "$version"
  app_placed
  app_answers
  # The page's bare line names no channel: what it installs follows latest.
  [ "$(cat "$ROOT/channel" 2>/dev/null)" = latest ] ||
    die "install.sh recorded \"$(cat "$ROOT/channel" 2>/dev/null)\" as its channel, where a fresh install with none named follows latest."
}

# agentorg uninstall, then what it removes is gone: the service and its file, what install.sh put
# in ~/.agentorg, the launcher, and the Mac app, by the app's own uninstall, with its background
# item and its record, so the next install starts clean. The home stays, as it says.
uninstall() {
  on_runner uninstall
  [ -f "$LAUNCHER" ] || die "AgentOrg isn't installed in this account: there is no $LAUNCHER."
  local home part app
  # shellcheck disable=SC2016 # The launcher's own line, matched as written: nothing in it expands.
  home="$(sed -n 's/^export AGENTORG_HUB_HOME="\${AGENTORG_HUB_HOME:-\(.*\)}"$/\1/p' "$LAUNCHER")"
  app="$(mac_app)" || die "There is no Mac app for agentorg uninstall to remove: install.sh put none in place."
  say "\$ agentorg uninstall"
  "$LAUNCHER" uninstall || die "agentorg uninstall failed."
  for part in "$HOME/Library/LaunchAgents/$SERVICE.plist" "$ROOT/app" "$ROOT/runtime" \
    "$ROOT/AgentOrg Core.app" "$ROOT/update-backup" "$ROOT/previous" "$ROOT/channel" "$LAUNCHER" \
    "$app" "$RECORD"; do
    [ ! -e "$part" ] || die "agentorg uninstall left $part."
  done
  if launchctl print "gui/$(id -u)/$SERVICE" >/dev/null 2>&1; then
    die "agentorg uninstall left the service, $SERVICE, with launchd."
  fi
  if launchctl print "gui/$(id -u)/$BACKGROUND" >/dev/null 2>&1; then
    die "agentorg uninstall left the Mac app's background item, $BACKGROUND, with launchd."
  fi
  [ -f "$home/hub.db" ] || die "agentorg uninstall took the home at $home, which it keeps."
  say "agentorg uninstall removed the service, what install.sh put in $ROOT, the launcher and the Mac app with its background item and record, and kept the home at $home."
}

# The newest release before this one, by version, among the repository's published releases.
previous() {
  local tags tag v best=""
  tags="$(gh release list --exclude-drafts --limit 100 --json tagName --jq '.[].tagName')" ||
    die "Couldn't list the repository's releases."
  while read -r tag; do
    [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || continue
    v="${BASH_REMATCH[1]}"
    [ "$v" != "$version" ] || continue
    later "$v" "$version" && continue
    if [ -z "$best" ] || later "$v" "$best"; then best="$v"; fi
  done <<<"$tags"
  printf '%s' "$best"
}
later() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# The release before, installed by its own install.sh from its own files, then updated by this
# release's install.sh --update from the run's files. A release before with no install.sh, or with
# no Mac app its install.sh can install, has nothing to update from yet: that is said, and skipped.
update() {
  local zip core prev names dir before
  zip="$(zip_of "$1")"
  core="$(core_of "$1")"
  need "$zip" "$core"
  prev="$(previous)"
  if [ -z "$prev" ]; then
    say "There is no release before v$version, so there is no update to check yet."
    output updated=false
    return 0
  fi
  say "The release before v$version is v$prev."
  names="$(gh release view "v$prev" --json assets --jq '.assets[].name')" ||
    die "Couldn't read the files of release v$prev."
  local prev_zip="AgentOrg-$prev-mac-arm64.zip" prev_core="agentorg-core-$prev.tgz"
  if ! grep -qxF install.sh <<<"$names"; then
    say "Release v$prev has no install.sh: it was made before the release run made its own, so there is no update to check from it. Skipped."
    output updated=false
    return 0
  fi
  if ! grep -qxF "$prev_zip" <<<"$names"; then
    say "Release v$prev carries no Mac app, so its install.sh can't install it, and there is no update to check from it. Skipped."
    output updated=false
    return 0
  fi
  grep -qxF "$prev_core" <<<"$names" ||
    die "Release v$prev has install.sh but no $prev_core, so it can't be installed from its own files."
  on_runner update
  none_yet
  dir="$(mktemp -d)"
  gh release download "v$prev" --dir "$dir" --pattern install.sh --pattern "$prev_zip" --pattern "$prev_core" ||
    die "Couldn't download the files of release v$prev."
  # On a home of its own: the one a fresh install left is this release's, newer than v$prev.
  export AGENTORG_HUB_HOME="${RUNNER_TEMP:?}/agentorg-update-home"
  install_sh "$dir/install.sh" --app "$dir/$prev_zip" --core "$dir/$prev_core" --no-open
  answers "$prev"
  app_answers
  before="$(app_pid || true)"
  install_sh "$root/install.sh" --update --app "$zip" --core "$core" --no-open
  answers "$version"
  [ "$(readlink "$ROOT/app/current")" = "$version" ] || die "The update left the core at $(readlink "$ROOT/app/current"), not $version."
  app_placed
  app_answers "$before"
  say "AgentOrg moved from $prev to $version."
  output updated=true
  # Then back, as agentorg update --back runs this release's script: v$prev again, with the home as
  # it was just before the update, so what changed since is gone.
  touch "$AGENTORG_HUB_HOME/changed-after-the-update"
  before="$(app_pid || true)"
  install_sh "$root/install.sh" --back --no-open
  answers "$prev"
  [ "$(readlink "$ROOT/app/current")" = "$prev" ] || die "Going back left the core at $(readlink "$ROOT/app/current"), not $prev."
  [ ! -e "$AGENTORG_HUB_HOME/changed-after-the-update" ] || die "Going back kept what changed in the home after the update."
  [ ! -e "$ROOT/previous" ] && [ ! -e "$ROOT/app/$version" ] || die "Going back left the step it took, or $version's core."
  app_answers "$before"
  say "AgentOrg went back from $version to $prev, with its home as it was before the update."
  # And forward again, so the uninstall after this checks this release's own.
  before="$(app_pid || true)"
  install_sh "$root/install.sh" --update --app "$zip" --core "$core" --no-open
  answers "$version"
  app_answers "$before"
  say "AgentOrg moved from $prev to $version again."
}

[ $# -ge 1 ] || die "$usage"
command="$1"
case "$command" in
apple | fresh | update)
  [ $# -eq 3 ] || die "$command takes VERSION and FROM."
  version="$2"
  is_version "$version"
  "$command" "$3"
  ;;
uninstall)
  [ $# -eq 1 ] || die "uninstall takes nothing."
  uninstall
  ;;
*) die "$usage" ;;
esac
