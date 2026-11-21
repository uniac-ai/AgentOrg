#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The agentorg authors
# Installs AgentOrg on this Mac from a release: it reads the version npm's channel names, fetches
# that release's install.sh and SHA256SUMS, and runs install.sh once its sum is the one listed.
#
#   curl -fsSL https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/get.sh | bash -s -- --update
#
# The channel is next, or latest with `bash -s -- --channel latest`, or `AGENTORG_CHANNEL=latest
# bash`. Every other argument goes to install.sh. The last line is in braces, so a download cut off
# anywhere is a syntax error or calls nothing. agentorg update (packages/app/src/installed.ts) reads
# the same addresses: they change together.
set -euo pipefail

TAGS="https://registry.npmjs.org/-/package/@agentorg/cli/dist-tags"
RELEASES="https://github.com/uniac-ai/AgentOrg/releases/download"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
# A file at $1 into $work/$2. Once a version is read, a release file that isn't there is its
# release not being up yet; curl -f exits 22 for it.
fetch() {
  local code=0
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 --retry 2 -o "$work/$2" "$1" || code=$?
  [ "$code" != 22 ] || [ -z "${version:-}" ] ||
    die "AgentOrg $version is on npm, but its release isn't up yet: try again in a few minutes."
  [ "$code" = 0 ] || die "Couldn't download $1, so nothing was installed."
}

main() {
  local channel="${AGENTORG_CHANNEL:-next}" args=() version="" listed got
  while [ $# -gt 0 ]; do
    case "$1" in
    --channel)
      [ $# -ge 2 ] || die "--channel takes latest or next."
      channel="$2"
      shift
      ;;
    *) args+=("$1") ;;
    esac
    shift
  done
  case "$channel" in latest | next) ;; *) die "AgentOrg's channels are latest and next, not $channel." ;; esac

  # Global, not local: the EXIT trap runs after main has returned, and still needs it.
  work="$(mktemp -d "${TMPDIR:-/tmp}/agentorg-get.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  fetch "$TAGS" dist-tags.json
  version="$(sed -n "s/.*\"$channel\": *\"\([^\"]*\)\".*/\1/p" "$work/dist-tags.json")"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    die "npm names no version for AgentOrg's $channel channel, so nothing was installed."
  fetch "$RELEASES/v$version/install.sh" install.sh
  fetch "$RELEASES/v$version/SHA256SUMS" SHA256SUMS
  listed="$(sed -n '/^[0-9a-f]\{64\} [ *]install\.sh$/{s/ .*//p;q;}' "$work/SHA256SUMS")"
  [ -n "$listed" ] || die "The SHA256SUMS of AgentOrg $version has no line for install.sh, so nothing was installed."
  got="$(shasum -a 256 "$work/install.sh" | cut -d' ' -f1)"
  [ "$got" = "$listed" ] ||
    die "install.sh of AgentOrg $version isn't the one its SHA256SUMS lists (its SHA-256 is $got), so nothing was installed."

  printf '%s\n' "Installing AgentOrg $version, the $channel channel's release."
  bash "$work/install.sh" ${args[@]+"${args[@]}"}
}

{ main "$@"; }
