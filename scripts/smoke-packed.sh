#!/usr/bin/env bash
# The published package as a person gets it: @agentorg/cli packed, with the other @agentorg
# packages inside it (dist/node_modules), installed from its tarball into an empty folder with a
# cache of its own, and globally with a prefix of its own. Then `agentorg` runs on a fresh home:
# first run must make ChatGPT, the providers and management, all connected; an agent must be made
# with `agentorg call agents create`; and the gateway must serve the shell and the sign-in page. Last, this build must start on a home the published 0.0.5
# made: its old Actors closed, and `agents create` working; and on a home the published 0.0.6 made,
# with a connection that must still answer and an agent whose conversation must be its first chat.
# Run after `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$root/packages/app/dist/src/cli.js" ]; then
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
# The AgentComputer SDK is inside; the service beside it in that package is not.
sdk="$work/install/node_modules/@agentorg/cli/dist/node_modules/@agentorg/computer"
[ -f "$sdk/dist/sdk.js" ] || { echo "No AgentComputer SDK in the cli" >&2; exit 1; }
[ ! -e "$sdk/dist/agentcomputer.js" ] || { echo "The cli ships the service" >&2; exit 1; }
ls "$work/install/node_modules/@agentorg/cli/dist/node_modules/@agentorg"
"$agentorg" --version

step "install it globally, with a prefix of its own"
# A global install nests the cli's dependencies in its own folder: the packages inside the cli
# must find their own there.
global="$work/global"
npm install --global --silent --no-audit --no-fund --prefix "$global" --cache "$work/cache" \
  "$tarball"
"$global/bin/agentorg" --version

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

step "first run: ChatGPT, both providers and management, connected"
ready=""
for _ in $(seq 1 120); do
  if "$agentorg" actors --home "$home" >"$work/actors.json" 2>"$work/actors.err" &&
    node -e '
      const { actors } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const up = (name) => actors.some((a) => a.name === name && a.connected);
      process.exit(["ChatGPT", "AgentOrg", "Local", "Computers", "Management"].every(up) ? 0 : 1);
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
[ -n "$ready" ] || { echo "Not all connected after 60 s" >&2; cat "$work/app.log" >&2; exit 1; }

step "agentorg call agents create makes an Assistant, running"
# Management hears of its providers as first run exposes them: asked until it offers Assistant.
for _ in $(seq 1 60); do
  "$agentorg" call agents creatable --home "$home" >"$work/creatable.json" 2>/dev/null &&
    grep -Eq '"id": ?"assistant"' "$work/creatable.json" && break
  sleep 0.5
done
create="$(node -e '
  const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ stack: { base: { provider: one.provider, creatable: one.id }, units: [] }, name: "Scout" }));
' "$work/creatable.json")"
"$agentorg" call agents create "$create" --home "$home" >"$work/created.json"
"$agentorg" call agents list --home "$home" >"$work/agents.json"
node -e '
  const { agents } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const scout = agents.find((a) => a.name === "Scout");
  if (scout?.status.state !== "running") { console.error(JSON.stringify(agents)); process.exit(1); }
  console.log(`Scout is ${scout.status.state}`);
' "$work/agents.json"

step "the gateway serves the shell and the sign-in page"
for path in / /app.js /app.css /signin /signin.js; do
  status="$(curl -s -o /dev/null -w '%{http_code}' "$url$path")"
  echo "$status $path"
  [ "$status" = 200 ] || exit 1
done

step "stop by pid"
kill -TERM "$pid"
wait "$pid" || true
pid=""

step "the global install's Hub starts and answers"
ghome="$work/ghome"
"$global/bin/agentorg" hub --home "$ghome" >"$work/hub.log" 2>&1 &
hubpid=$!
for _ in $(seq 1 120); do
  [ -s "$ghome/url" ] && break
  kill -0 "$hubpid" 2>/dev/null || { cat "$work/hub.log" >&2; exit 1; }
  sleep 0.5
done
[ -s "$ghome/url" ] || { echo "The global Hub wrote no address after 60 s" >&2; exit 1; }
"$global/bin/agentorg" call actors list --home "$ghome" >"$work/gactors.json"
kill -TERM "$hubpid"
wait "$hubpid" || true
hubpid=""

step "a home the published 0.0.5 made: this build starts on it as on a fresh one"
old="$work/old"
mkdir "$old"
(cd "$old" && echo '{"private":true}' >package.json &&
  npm install --silent --no-audit --no-fund --cache "$work/cache" @agentorg/cli@0.0.5)
was="$old/node_modules/.bin/agentorg"
uphome="$work/uphome"
start_on "$was" "$uphome" "$work/old.log"
made="$(both_ready "$was" "$uphome")" ||
  { echo "0.0.5's first run didn't finish" >&2; cat "$work/old.log" >&2; exit 1; }
echo "0.0.5: $made"
"$was" actors --home "$uphome" >"$work/old-actors.json"
stop_app
start_on "$agentorg" "$uphome" "$work/up.log"
for _ in $(seq 1 120); do
  "$agentorg" call agents creatable --home "$uphome" >"$work/up-creatable.json" 2>/dev/null &&
    grep -Eq '"id": ?"assistant"' "$work/up-creatable.json" && break
  kill -0 "$pid" 2>/dev/null || { cat "$work/up.log" >&2; exit 1; }
  sleep 0.5
done
grep -Eq '"id": ?"assistant"' "$work/up-creatable.json" ||
  { echo "This build didn't start on the 0.0.5 home" >&2; cat "$work/up.log" >&2; exit 1; }
if grep -E "didn't work|Error" "$work/up.log"; then
  echo "This build reported a problem on the 0.0.5 home" >&2
  exit 1
fi
"$agentorg" actors --home "$uphome" >"$work/up-actors.json"
node -e '
  const fs = require("fs");
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8")).actors;
  const [before, after] = process.argv.slice(1).map(read);
  const old = before.filter((a) => a.name === "Installer" || a.name === "ChatGPT");
  if (old.length !== 2) { console.error("expected the old Actors"); process.exit(1); }
  for (const a of old) {
    const now = after.find((b) => b.actorId === a.actorId);
    if (now?.state !== "closed") { console.error(`${a.name} is ${now?.state ?? "removed"}`); process.exit(1); }
  }
  console.log(`${old.length} old Actors closed`);
' "$work/old-actors.json" "$work/up-actors.json"
create="$(node -e '
  const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ stack: { base: { provider: one.provider, creatable: one.id }, units: [] }, name: "Newcomer" }));
' "$work/up-creatable.json")"
"$agentorg" call agents create "$create" --home "$uphome" >/dev/null
echo "agents create works on the 0.0.5 home"
stop_app

step "a home the published 0.0.6 made: its connection and its agent's conversation work on this build"
old6="$work/old6"
mkdir "$old6"
(cd "$old6" && echo '{"private":true}' >package.json &&
  npm install --silent --no-audit --no-fund --cache "$work/cache" @agentorg/cli@0.0.6)
was="$old6/node_modules/.bin/agentorg"
home6="$work/home6"
start_on "$was" "$home6" "$work/old6.log"
for _ in $(seq 1 120); do
  "$was" call connections providers --home "$home6" >"$work/mcp.json" 2>/dev/null &&
    grep -Eq '"kind": ?"command"' "$work/mcp.json" && break
  kill -0 "$pid" 2>/dev/null || { cat "$work/old6.log" >&2; exit 1; }
  sleep 0.5
done
grep -Eq '"kind": ?"command"' "$work/mcp.json" ||
  { echo "0.0.6 offered no way to connect" >&2; cat "$work/old6.log" >&2; exit 1; }
create="$(node -e '
  const { providers: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({
    provider: one.provider, kind: "command", name: "Fixture",
    params: { command: process.execPath, args: [process.argv[2]] },
  }));
' "$work/mcp.json" "$root/packages/mcp/dist/test/fixtures/server.js")"
connection="$("$was" call connections create "$create" --home "$home6" |
  node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).connection)')"
# Whether the connection answers with its tools, asked of `agentorg` ($1) on the 0.0.6 home.
answers() {
  "$1" call connections get "{\"connection\":\"$connection\"}" --home "$home6" 2>/dev/null |
    node -e '
      const { status } = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.exit(status.state === "connected" && status.tools.length > 0 ? 0 : 1);
    '
}
wait_answers() {
  for _ in $(seq 1 120); do
    answers "$1" && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}
wait_answers "$was" || { echo "0.0.6's connection never answered" >&2; cat "$work/old6.log" >&2; exit 1; }
# An agent with something said to it, as 0.0.6 kept it: one conversation, reached at one slot.
for _ in $(seq 1 60); do
  "$was" call agents creatable --home "$home6" >"$work/creatable6.json" 2>/dev/null &&
    grep -Eq '"id": ?"assistant"' "$work/creatable6.json" && break
  sleep 0.5
done
grep -Eq '"id": ?"assistant"' "$work/creatable6.json" ||
  { echo "0.0.6 offered no Assistant" >&2; cat "$work/old6.log" >&2; exit 1; }
create="$(node -e '
  const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ provider: one.provider, creatable: one.id, name: "Elder", answers: {} }));
' "$work/creatable6.json")"
"$was" call agents create "$create" --home "$home6" >/dev/null
# The person's slot for a chat, asked of `agentorg` ($1) on the 0.0.6 home; empty if there is none.
chat_slot() {
  "$1" call bindings list '{"actor":"person"}' --home "$home6" 2>/dev/null |
    node -e '
      const { bindings } = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(bindings.find((b) => b.export === "chat")?.slot ?? "");
    '
}
slot="$(chat_slot "$was")"
[ -n "$slot" ] || { echo "0.0.6 gave the person no chat" >&2; exit 1; }
"$was" call "$slot" send '{"text":"Said on 0.0.6."}' --home "$home6" >/dev/null
stop_app
start_on "$agentorg" "$home6" "$work/up6.log"
# Its chats changed shape, so the Hub dropped the person's reach to them: it must come back, at
# the slot it had, with the conversation as the agent's first chat.
for _ in $(seq 1 120); do
  [ "$(chat_slot "$agentorg")" = "$slot" ] && break
  kill -0 "$pid" 2>/dev/null || { cat "$work/up6.log" >&2; exit 1; }
  sleep 0.5
done
[ "$(chat_slot "$agentorg")" = "$slot" ] ||
  { echo "The person lost the 0.0.6 agent's chat on this build" >&2; cat "$work/up6.log" >&2; exit 1; }
"$agentorg" call "$slot" list --home "$home6" |
  node -e '
    const { chats } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (chats.length !== 1 || chats[0].title !== "Said on 0.0.6.") {
      console.error(JSON.stringify(chats));
      process.exit(1);
    }
    console.log(`0.0.6'"'"'s conversation is the chat "${chats[0].title}"`);
  '
wait_answers "$agentorg" ||
  { echo "0.0.6's connection doesn't work on this build" >&2; cat "$work/up6.log" >&2; exit 1; }
"$agentorg" call connections remove "{\"connection\":\"$connection\"}" --home "$home6" >/dev/null
"$agentorg" call connections list --home "$home6" | grep -q "$connection" &&
  { echo "The connection is still there" >&2; exit 1; }
echo "0.0.6's connection works here and is removed"
stop_app
echo "smoke passed"
