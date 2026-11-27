#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The agentorg authors
# Installs AgentOrg on this Mac by handing on to its install page: it fetches the page's install.sh
# for the channel, and runs it, as the page's own lines do:
#
#   curl -fsSL https://agentorg.app/install.sh | bash
#   curl -fsSL https://agentorg.app/next/install.sh | AGENTORG_CHANNEL=next bash
#
# The channel is the one `bash -s -- --channel latest` or `AGENTORG_CHANNEL=latest bash` names; else
# the one install.sh recorded in ~/.agentorg/channel; else next. install.sh is given it in
# AGENTORG_CHANNEL, and records it. Every other argument goes to install.sh. The last line is in
# braces, so a download cut off anywhere is a syntax error or calls nothing.
set -euo pipefail

PAGE="https://agentorg.app"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

main() {
  local channel="${AGENTORG_CHANNEL:-}" args=() url
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
  if [ -z "$channel" ]; then
    channel="$(cat "$HOME/.agentorg/channel" 2>/dev/null || true)"
    case "$channel" in latest | next) ;; *) channel=next ;; esac
  fi
  case "$channel" in latest | next) ;; *) die "AgentOrg's channels are latest and next, not $channel." ;; esac
  url="$PAGE/install.sh"
  [ "$channel" = latest ] || url="$PAGE/$channel/install.sh"

  # Global, not local: the EXIT trap runs after main has returned, and still needs it.
  work="$(mktemp -d "${TMPDIR:-/tmp}/agentorg-get.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 --retry 2 -o "$work/install.sh" "$url" ||
    die "Couldn't download $url, so nothing was installed."
  AGENTORG_CHANNEL="$channel" bash "$work/install.sh" ${args[@]+"${args[@]}"}
}

{ main "$@"; }
