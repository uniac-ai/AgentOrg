#!/usr/bin/env bash
# The GitHub release a tag of AgentOrg makes, in three steps the release workflow runs in turn:
#
#   scripts/github-release.sh notes VERSION [NOTES]           the release's notes are there
#   scripts/github-release.sh gather VERSION FROM OUT [--mac] its files, named, with SHA256SUMS
#   scripts/github-release.sh create VERSION OUT [NOTES]      the release, with those files
#
# A release's notes are release-notes/v<version>.md; NOTES is the folder they are in, by default
# the repository's release-notes. FROM holds the files as the release run makes them: the core and
# the frontend, each alone, install.sh, and with --mac, when the release carries one, the Mac app.
# OUT is made new. `create` runs `gh`, which needs GH_TOKEN, and GH_REPO outside a checkout.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
usage="Usage: scripts/github-release.sh notes VERSION [NOTES]
       scripts/github-release.sh gather VERSION FROM OUT [--mac]
       scripts/github-release.sh create VERSION OUT [NOTES]"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

[ $# -ge 2 ] || die "$usage"
command="$1"
version="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Not a version: \"$version\"."

# The release's notes, release-notes/v<version>.md, added in the release's PR, and not empty.
notes() {
  local named="release-notes/v$version.md" file
  if [ -n "${1:-}" ]; then named="$1/v$version.md"; fi
  file="${1:-$root/release-notes}/v$version.md"
  [ -s "$file" ] || die "The release has no notes: add $named in the release's PR," \
    "then move the tag: delete it and push it again."
  printf '%s\n' "$file"
}

# The release's files in OUT under the fixed names they are fetched by, and SHA256SUMS over them
# in sha256sum's own format, sorted by name. The core, the frontend and install.sh must be there.
# The Mac app is taken only with --mac, when the release carries one, and then it must be there.
# Nothing is made when one is missing.
gather() {
  local from="$1" out="$2" mac="$3" name
  local names=("agentorg-core-$version.tgz" "agentorg-frontend-$version.tgz" install.sh)
  if [ "$mac" = --mac ]; then names+=("AgentOrg-$version-mac-arm64.zip"); fi
  for name in "${names[@]}"; do
    [ -f "$from/$name" ] || die "$from has no $name, which this release carries."
  done
  mkdir "$out" || die "$out must be a new folder."
  for name in "${names[@]}"; do cp "$from/$name" "$out/$name"; done
  (cd "$out" && sha256 "${names[@]}") | LC_ALL=C sort -k2,2 >"$out/SHA256SUMS"
  printf 'Gathered in %s:\n' "$out"
  cat "$out/SHA256SUMS"
}

# The GitHub release of tag vVERSION, which must be there already, published, not latest: the
# files SHA256SUMS lists, and it. A name sha256sum marks as read in binary mode, `*name`, is name.
create() {
  local dir="$1" file name
  file="$(notes "${2:-}")"
  [ -f "$dir/SHA256SUMS" ] || die "$dir has no SHA256SUMS: gather the release's files first."
  local files=()
  while read -r _ name; do files+=("$dir/${name#\*}"); done <"$dir/SHA256SUMS"
  gh release create "v$version" --verify-tag --title "$version" --latest=false \
    --notes-file "$file" "${files[@]}" "$dir/SHA256SUMS"
}

case "$command" in
notes)
  [ $# -le 3 ] || die "notes takes VERSION and, optionally, NOTES."
  file="$(notes "${3:-}")"
  printf 'The release has its notes: %s\n' "$file"
  ;;
gather)
  [ $# -eq 4 ] || { [ $# -eq 5 ] && [ "$5" = --mac ]; } ||
    die "gather takes VERSION, FROM, OUT and, optionally, --mac."
  gather "$3" "$4" "${5:-}"
  ;;
create)
  [ $# -eq 3 ] || [ $# -eq 4 ] || die "create takes VERSION, OUT and, optionally, NOTES."
  create "$3" "${4:-}"
  ;;
*) die "$usage" ;;
esac
