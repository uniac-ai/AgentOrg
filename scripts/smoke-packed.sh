#!/usr/bin/env bash
# The published package as a person gets it: @agentorg/cli packed, with the other @agentorg
# packages inside it (dist/node_modules), installed from its tarball into an empty folder with a
# cache of its own, and globally with a prefix of its own. Then `agentorg` runs on a fresh home:
# first run must make the Installer and ChatGPT, both running and connected; the gateway must
# serve the shell, the sign-in page and the frame runtime; and the Hub must build an agent's
# source, which resolves the SDK, the interfaces and zod from the installed package. Run after
# `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$root/packages/app/dist/bundled/index.json" ]; then
  echo "Build first: npm run build" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/agentorg-smoke.XXXXXX")"
pid=""
hubpid=""
cleanup() {
  for p in "$pid" "$hubpid"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      kill -TERM "$p" 2>/dev/null || true
      wait "$p" 2>/dev/null || true
    fi
  done
  rm -rf "$work"
}
trap cleanup EXIT

step() { echo "== $*"; }
# A fixture's source as hub.packages.build takes it: {"files": {path: text}}.
source_of() {
  node -e '
    const fs = require("fs");
    const [dir, ...paths] = process.argv.slice(1);
    const files = {};
    for (const path of paths) files[path] = fs.readFileSync(`${dir}/${path}`, "utf8");
    console.log(JSON.stringify({ files }));
  ' "$@"
}
# A build's answer: its package's name and hash, or a failure.
built() {
  node -e '
    const { hash, manifest } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!/^sha256-/.test(hash)) process.exit(1);
    console.log(`${manifest.name} ${hash}`);
  ' "$1"
}
# Start `agentorg` ($1) on a home ($2) in the background as $pid, logging to $3, until it serves.
start_on() {
  "$1" --no-open --home "$2" >"$3" 2>&1 &
  pid=$!
  for _ in $(seq 1 120); do
    grep -q '^AgentOrg at http' "$3" && return 0
    kill -0 "$pid" 2>/dev/null || { cat "$3" >&2; exit 1; }
    sleep 0.5
  done
  echo "No address after 60 s" >&2
  cat "$3" >&2
  exit 1
}
# The Installer's and ChatGPT's ids on a home ($2), once both run and are connected, by `agentorg`
# ($1); a failure after 60 s.
both_ready() {
  for _ in $(seq 1 120); do
    if "$1" actors --home "$2" >"$work/ready.json" 2>/dev/null &&
      node -e '
        const { actors } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const up = (name) => actors.find((a) => a.name === name && a.state === "running" && a.connected);
        const [i, c] = [up("Installer"), up("ChatGPT")];
        if (!i || !c) process.exit(1);
        console.log(`Installer=${i.actorId} ChatGPT=${c.actorId}`);
      ' "$work/ready.json"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}
stop_app() {
  kill -TERM "$pid"
  wait "$pid" || true
  pid=""
}
fixtures="$root/packages/hub/test/fixtures"
counter="$(source_of "$fixtures/counter" package.json src/counter.ts src/interface.ts)"
kit="$(source_of "$fixtures/kit-widget" package.json src/panel.tsx)"

step "pack the cli"
tarball="$(node "$root/packages/app/scripts/pack.js" "$work/packs")"
tar -tzf "$tarball" | sed 's#^package/##' | awk -F/ '{ print ($2 == "node_modules" ? $1 "/" $2 "/" $3 "/" $4 : NF > 1 ? $1 "/" $2 : $1) }' | sort | uniq -c

step "install the one tarball into an empty folder"
mkdir "$work/install"
(cd "$work/install" && echo '{"private":true}' >package.json &&
  npm install --silent --no-audit --no-fund --cache "$work/cache" "$tarball")
agentorg="$work/install/node_modules/.bin/agentorg"
# Every other @agentorg package is the one inside the cli: none came from the registry.
top="$(ls "$work/install/node_modules/@agentorg")"
[ "$top" = cli ] || { echo "Installed beside the cli: $top" >&2; exit 1; }
ls "$work/install/node_modules/@agentorg/cli/dist/node_modules/@agentorg"
"$agentorg" --version

step "install it globally, with a prefix of its own"
# A global install nests the cli's dependencies in its own folder, esbuild's install script
# included: it must find esbuild there, and the packages inside the cli must find their own.
global="$work/global"
npm install --global --silent --no-audit --no-fund --prefix "$global" --cache "$work/cache" \
  "$tarball"
"$global/bin/agentorg" --version
node -e '
  const { createRequire } = require("node:module");
  const sdk = process.argv[1];
  const esbuild = createRequire(`${sdk}/package.json`)("esbuild");
  console.log(`esbuild ${esbuild.version} from the cli'"'"'s sdk: ${esbuild.transformSync("let a: number = 1", { loader: "ts" }).code.trim()}`);
' "$(ls -d "$global"/lib/node_modules/@agentorg/cli/dist/node_modules/@agentorg/sdk)"

step "run agentorg --no-open on a fresh home"
home="$work/home"
"$agentorg" --no-open --home "$home" >"$work/app.log" 2>&1 &
pid=$!
echo "pid $pid"
url=""
for _ in $(seq 1 120); do
  url="$(sed -n 's/^AgentOrg at \(http[^,]*\),.*/\1/p' "$work/app.log")"
  [ -n "$url" ] && break
  kill -0 "$pid" 2>/dev/null || { cat "$work/app.log" >&2; exit 1; }
  sleep 0.5
done
[ -n "$url" ] || { echo "No address after 60 s" >&2; cat "$work/app.log" >&2; exit 1; }
echo "$url"

step "first run: the Installer and ChatGPT, running and connected"
ready=""
for _ in $(seq 1 120); do
  if "$agentorg" actors --home "$home" >"$work/actors.json" 2>"$work/actors.err" &&
    node -e '
      const { actors } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const up = (name) => actors.some((a) => a.name === name && a.state === "running" && a.connected);
      process.exit(up("Installer") && up("ChatGPT") ? 0 : 1);
    ' "$work/actors.json"; then
    ready=1
    break
  fi
  kill -0 "$pid" 2>/dev/null || { cat "$work/app.log" >&2; exit 1; }
  sleep 0.5
done
node -e '
  const { actors } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const a of actors) console.log(`${a.name}\t${a.state}\tconnected=${a.connected}`);
' "$work/actors.json" || cat "$work/actors.err"
[ -n "$ready" ] || { echo "Not both running and connected after 60 s" >&2; cat "$work/app.log" >&2; exit 1; }

step "the gateway serves the shell, the sign-in page and the frame runtime"
for path in / /app.js /app.css /signin /signin.js /frames/runtime.js; do
  status="$(curl -s -o /dev/null -w '%{http_code}' "$url$path")"
  echo "$status $path"
  [ "$status" = 200 ] || exit 1
done

step "the Hub builds an agent's source against the installed SDK, interfaces and zod"
"$agentorg" call packages build "$counter" --home "$home" >"$work/build.json"
built "$work/build.json"

step "and a view in JSX against the installed React, react-dom and kit"
"$agentorg" call packages build "$kit" --home "$home" >"$work/kit.json"
built "$work/kit.json"

step "stop by pid"
kill -TERM "$pid"
wait "$pid" || true
pid=""

step "the global install's Hub builds the kit widget too"
ghome="$work/ghome"
"$global/bin/agentorg" hub --home "$ghome" >"$work/hub.log" 2>&1 &
hubpid=$!
for _ in $(seq 1 120); do
  [ -s "$ghome/url" ] && break
  kill -0 "$hubpid" 2>/dev/null || { cat "$work/hub.log" >&2; exit 1; }
  sleep 0.5
done
[ -s "$ghome/url" ] || { echo "The global Hub wrote no address after 60 s" >&2; exit 1; }
"$global/bin/agentorg" call packages build "$kit" --home "$ghome" >"$work/gkit.json"
built "$work/gkit.json"
kill -TERM "$hubpid"
wait "$hubpid" || true
hubpid=""

step "an earlier release's home: the published 0.0.3 makes it, this build takes it over"
old="$work/old"
mkdir "$old"
(cd "$old" && echo '{"private":true}' >package.json &&
  npm install --silent --no-audit --no-fund --cache "$work/cache" @agentorg/cli@0.0.3)
uphome="$work/uphome"
start_on "$old/node_modules/.bin/agentorg" "$uphome" "$work/old.log"
made="$(both_ready "$old/node_modules/.bin/agentorg" "$uphome")" ||
  { echo "0.0.3's first run didn't finish" >&2; cat "$work/old.log" >&2; exit 1; }
echo "0.0.3: $made"
stop_app
start_on "$agentorg" "$uphome" "$work/up.log"
kept="$(both_ready "$agentorg" "$uphome")" ||
  { echo "This build didn't take the home over" >&2; cat "$work/up.log" >&2; exit 1; }
echo "this build: $kept"
[ "$made" = "$kept" ] || { echo "The Installer or ChatGPT is another Actor now" >&2; exit 1; }
grep '^First run: upgraded' "$work/up.log" || true
# The upgraded Installer installs: the counter, built by the Hub, with its store.
"$agentorg" call packages build "$counter" --home "$uphome" >"$work/up-build.json"
hash="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hash)' "$work/up-build.json")"
"$agentorg" call installer install \
  "{\"package\":\"$hash\",\"name\":\"Counter\",\"connections\":{\"counter.store\":{\"actor\":\"storage\",\"export\":\"kv\"}}}" \
  --home "$uphome" >"$work/up-install.json"
node -e '
  const { actorId } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!/^act_/.test(actorId)) process.exit(1);
  console.log(`installed the counter as ${actorId}`);
' "$work/up-install.json"
stop_app
echo "smoke passed"
