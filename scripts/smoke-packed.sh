#!/usr/bin/env bash
# The published package as a person gets it: @agentorg/cli packed, with the other @agentorg
# packages bundled inside it, installed from its tarball into an empty folder with a cache of its
# own, and `agentorg` run from there on a fresh home. First run must make the Installer and
# ChatGPT, both running and connected; the gateway must serve the shell, the sign-in page and the
# frame runtime; and the Hub must build an agent's source, which resolves the SDK, the interfaces
# and zod from the installed package. Run after `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$root/packages/app/dist/bundled/index.json" ]; then
  echo "Build first: npm run build" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/agentorg-smoke.XXXXXX")"
pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

step() { echo "== $*"; }

step "pack the cli"
tarball="$(node "$root/packages/app/scripts/pack.js" "$work/packs")"
tar -tzf "$tarball" | sed 's#^package/##' | awk -F/ '{ print ($1 == "node_modules" ? $1 "/" $2 "/" $3 : NF > 1 ? $1 "/" $2 : $1) }' | sort | uniq -c

step "install the one tarball into an empty folder"
mkdir "$work/install"
(cd "$work/install" && echo '{"private":true}' >package.json &&
  npm install --silent --no-audit --no-fund --cache "$work/cache" "$tarball")
agentorg="$work/install/node_modules/.bin/agentorg"
# Every @agentorg package is the one bundled in the cli: none came from the registry.
(cd "$work/install" && npm ls --all --cache "$work/cache" | grep '@agentorg/' | sed 's/^[^@]*//' | sort | uniq -c)
top="$(ls "$work/install/node_modules/@agentorg")"
[ "$top" = cli ] || { echo "Installed beside the cli: $top" >&2; exit 1; }

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
fixture="$root/packages/hub/test/fixtures/counter"
files="$(node -e '
  const fs = require("fs");
  const dir = process.argv[1];
  const files = {};
  for (const path of ["package.json", "src/counter.ts", "src/interface.ts"])
    files[path] = fs.readFileSync(`${dir}/${path}`, "utf8");
  console.log(JSON.stringify({ files }));
' "$fixture")"
"$agentorg" call packages build "$files" --home "$home" >"$work/build.json"
node -e '
  const { hash, manifest } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!/^sha256-/.test(hash)) process.exit(1);
  console.log(`${manifest.name} ${hash}`);
' "$work/build.json"

step "stop by pid"
kill -TERM "$pid"
wait "$pid" || true
pid=""
echo "smoke passed"
