#!/usr/bin/env bash
# The Mac app a release of AgentOrg carries: AgentComputer's archive, at the version mac-app.json
# pins. It is fetched from AgentComputer's GitHub release and checked against the pinned sum, that
# release's SHA256SUMS and GitHub's digest of the asset. Then it is put in OUT unchanged, under the
# name install.sh fetches from AgentOrg's release, with its line in a SHA256SUMS of its own.
#
# With no sum pinned, no archive is published yet: it says so, fetches nothing, puts nothing in OUT
# and exits 0, so the release goes on without a Mac app, as install.sh does.
#
#   scripts/carry-mac-app.sh [PIN] [OUT]    (by default the repository's mac-app.json, and mac-app)
#
# In a workflow it sets the step's output `carried` to true or false; `gh` needs GH_TOKEN.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pin="${1:-$root/mac-app.json}"
out="${2:-mac-app}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
carried() { [ -z "${GITHUB_OUTPUT:-}" ] || printf 'carried=%s\n' "$1" >>"$GITHUB_OUTPUT"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

version="$(jq -r '.version // ""' "$pin")" || die "Couldn't read $pin."
sum="$(jq -r '.sha256 // ""' "$pin")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$pin's version isn't one: \"$version\"."
if [ -z "$sum" ]; then
  printf '%s\n' "$pin pins no sum: no Mac app of AgentComputer $version is published yet, so this release carries none."
  carried false
  exit 0
fi
[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || die "$pin's sha256 isn't one: \"$sum\"."

name="AgentOrg-mac-arm64-$version.zip"
from="https://github.com/uniac-ai/AgentComputer/releases/download/v$version"
agentorg="$(jq -r .version "$root/packages/app/package.json")"
carry="AgentOrg-$agentorg-mac-arm64.zip"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$name" "$from/$name" || die "Couldn't download $name from AgentComputer's release v$version."
curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$from/SHA256SUMS" || die "Couldn't download AgentComputer's SHA256SUMS of v$version."
got="$(sha256 "$work/$name")"
[ "$got" = "$sum" ] || die "$name's sum is $got, not the $sum $pin pins."
listed="$(awk -v f="$name" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1 }' "$work/SHA256SUMS")"
[ "$listed" = "$sum" ] || die "AgentComputer's SHA256SUMS of v$version gives $name ${listed:-no sum}, not the pinned $sum."
digest="$(gh api "repos/uniac-ai/AgentComputer/releases/tags/v$version" --jq ".assets[] | select(.name == \"$name\") | .digest")"
[ "$digest" = "sha256:$sum" ] || die "GitHub's digest of $name is ${digest:-missing}, not sha256:$sum."

mkdir -p "$out"
mv "$work/$name" "$out/$carry"
printf '%s  %s\n' "$sum" "$carry" >"$out/SHA256SUMS"
printf '%s\n' "Carries AgentComputer $version's Mac app as $carry, sha256 $sum."
carried true
