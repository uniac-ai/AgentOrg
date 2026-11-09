#!/usr/bin/env bash
# The published package as a person gets it: @agentorg/cli packed, with the other @agentorg
# packages inside it (dist/node_modules), installed from its tarball into an empty folder with a
# cache of its own, and globally with a prefix of its own. Then `agentorg` runs on a fresh home:
# first run must make ChatGPT, both providers and management, all connected; an agent must be made
# with `agentorg call agents create`; the gateway must serve the shell, the sign-in page and the
# frame runtime; and the Hub must build an agent's source, which resolves the SDK, the interfaces
# and zod from the installed package. Last, a home the published 0.0.5 made must be carried: an
# agent of the same name with the same transcript and model, the old Actors closed and none
# removed, and storage.db unchanged. Run after `npm run build`.
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
sha_of() { node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
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

step "first run: ChatGPT, both providers and management, connected"
ready=""
for _ in $(seq 1 120); do
  if "$agentorg" actors --home "$home" >"$work/actors.json" 2>"$work/actors.err" &&
    node -e '
      const { actors } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const up = (name) => actors.some((a) => a.name === name && a.connected);
      process.exit(["ChatGPT", "Agents", "MCP", "Management"].every(up) ? 0 : 1);
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
    grep -q '"id":"assistant"' "$work/creatable.json" && break
  sleep 0.5
done
create="$(node -e '
  const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ provider: one.provider, creatable: one.id, name: "Scout", answers: {} }));
' "$work/creatable.json")"
"$agentorg" call agents create "$create" --home "$home" >"$work/created.json"
"$agentorg" call agents list --home "$home" >"$work/agents.json"
node -e '
  const { agents } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const scout = agents.find((a) => a.name === "Scout");
  if (scout?.status.state !== "running") { console.error(JSON.stringify(agents)); process.exit(1); }
  console.log(`Scout is ${scout.status.state}`);
' "$work/agents.json"

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

step "a home the published 0.0.5 made: this build carries it"
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
"$was" call store get '{"key":"app/first-run"}' --home "$uphome" >"$work/old-record.json"
agent_input="$(node -e '
  const { value } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const chatgpt = /ChatGPT=(\S+)/.exec(process.argv[2])[1];
  console.log(JSON.stringify({ package: value.assistant, name: "Keeper", start: true, connections: {
    "logic.model": { actor: chatgpt, export: "model.session" },
    "logic.store": { actor: "storage", export: "kv" },
  } }));
' "$work/old-record.json" "$made")"
idof='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).actorId))'
keeper="$("$was" call installer install "$agent_input" --home "$uphome" | node -e "$idof")"
echo "0.0.5's agent: $keeper"
# Said to it through its chat view, as the page does. With no sign-in the turn fails, and the
# person's message stays in the record.
node - "$old/node_modules/ws" "$uphome" "$keeper" <<'SAY'
const fs = require("fs");
const [wsPath, home, actor] = process.argv.slice(2);
const WebSocket = require(wsPath);
const { url } = JSON.parse(fs.readFileSync(`${home}/app.json`, "utf8"));
const token = fs.readFileSync(`${home}/cli-token`, "utf8").trim();
const socket = new WebSocket(`${url.replace("http", "ws")}/api`, {
  headers: { Authorization: `Bearer ${token}` },
});
const waiting = new Map();
let id = 0;
socket.on("message", (data) => {
  const reply = JSON.parse(String(data));
  waiting.get(reply.id)?.(reply);
});
const call = (method, input) =>
  new Promise((done) => {
    waiting.set(++id, done);
    socket.send(JSON.stringify({ id, op: "call", slot: "chat", method, input, view: { actor, module: "chat" } }));
  });
socket.once("open", async () => {
  // The agent's process may still be starting.
  for (let i = 0; i < 120; i++) {
    const { error } = await call("send", { text: "hello from 0.0.5" });
    if (!error) break;
    if (i === 119) throw new Error(JSON.stringify(error));
    await new Promise((r) => setTimeout(r, 500));
  }
  for (let i = 0; i < 120; i++) {
    const { result } = await call("history", {});
    if (result?.messages?.some((m) => m.text === "hello from 0.0.5")) {
      console.log("0.0.5 recorded the message");
      socket.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("0.0.5 didn't record the message");
});
SAY
# Something built and placed on Home.
"$was" call packages build "$kit" --home "$uphome" >"$work/old-kit.json"
kit_hash="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hash)' "$work/old-kit.json")"
widget="$("$was" call installer install "{\"package\":\"$kit_hash\",\"name\":\"Widget\",\"connections\":{},\"start\":true}" --home "$uphome" | node -e "$idof")"
"$was" call layout place "{\"actor\":\"$widget\",\"module\":\"panel\"}" --home "$uphome" >/dev/null
"$was" actors --home "$uphome" >"$work/old-actors.json"
stop_app
# A STAND-IN: 0.0.5 has no model choice, so a real 0.0.5 home never holds this row. It is written
# here so the step proves a chosen model comes through, for a home that ran a later build.
node - "$uphome/storage.db" "$keeper" <<'SEED'
const { DatabaseSync } = require("node:sqlite");
const [file, agent] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.prepare("INSERT INTO store (consumer, slot, key, value, size) VALUES (?, 'logic.store', 'settings/model', ?, 1)").run(agent, JSON.stringify("gpt-stand-in"));
db.close();
SEED
before="$(sha_of "$uphome/storage.db")"
hubbefore="$(sha_of "$uphome/hub.db")"

start_on "$agentorg" "$uphome" "$work/up.log"
for _ in $(seq 1 120); do
  grep -q '^First run: carried' "$work/up.log" && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
grep '^First run: carried' "$work/up.log" ||
  { echo "This build didn't carry the home" >&2; cat "$work/up.log" >&2; exit 1; }
"$agentorg" call agents list --home "$uphome" >"$work/up-agents.json"
"$agentorg" call bindings list '{"actor":"person"}' --home "$uphome" >"$work/up-person.json"
read -r again slot <<<"$(node -e '
  const fs = require("fs");
  const { agents } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const { bindings } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const kept = agents.filter((a) => a.name === "Keeper");
  if (kept.length !== 1 || kept[0].status.state !== "running") { console.error(JSON.stringify(agents)); process.exit(1); }
  const slot = bindings.find((b) => b.provider === kept[0].agent && b.export === "chat")?.slot;
  if (!slot) process.exit(1);
  console.log(kept[0].agent, slot);
' "$work/up-agents.json" "$work/up-person.json")"
[ -n "$slot" ] || { echo "The agent didn't come back under its name" >&2; exit 1; }
for _ in $(seq 1 60); do
  "$agentorg" call "$slot" history --home "$uphome" >"$work/up-history.json" 2>/dev/null &&
    grep -q 'hello from 0.0.5' "$work/up-history.json" && break
  sleep 0.5
done
grep -q 'hello from 0.0.5' "$work/up-history.json" ||
  { echo "The transcript didn't come over" >&2; cat "$work/up-history.json" >&2; exit 1; }
echo "the transcript came over"
[ "$(cat "$uphome/programs/agents/agents/$again/kv/settings%2Fmodel")" = '"gpt-stand-in"' ] ||
  { echo "The chosen model didn't come over" >&2; exit 1; }
echo "the (stand-in) model came over"
"$agentorg" actors --home "$uphome" >"$work/up-actors.json"
node -e '
  const fs = require("fs");
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8")).actors;
  const [before, after] = process.argv.slice(1).map(read);
  const old = before.filter((a) => !["hub", "person", "storage", "net"].includes(a.actorId));
  if (old.length < 4) { console.error("expected the old Actors"); process.exit(1); }
  for (const a of old) {
    const now = after.find((b) => b.actorId === a.actorId);
    if (now?.state !== "closed") { console.error(`${a.name} is ${now?.state ?? "removed"}`); process.exit(1); }
  }
  console.log(`${old.length} old Actors closed, none removed`);
' "$work/old-actors.json" "$work/up-actors.json"
"$agentorg" call agents creatable --home "$uphome" >"$work/up-creatable.json"
create="$(node -e '
  const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ provider: one.provider, creatable: one.id, name: "Newcomer", answers: {} }));
' "$work/up-creatable.json")"
"$agentorg" call agents create "$create" --home "$uphome" >/dev/null
echo "agents create works on the carried home"
stop_app
[ "$(sha_of "$uphome/storage.db")" = "$before" ] ||
  { echo "storage.db changed" >&2; exit 1; }
echo "storage.db is byte for byte what it was"
[ "$(sha_of "$uphome/hub.db.before-carry")" = "$hubbefore" ] ||
  { echo "hub.db wasn't copied aside unchanged" >&2; exit 1; }
[ ! -e "$uphome/carry/storage" ] || { echo "The private copy of storage.db remains" >&2; exit 1; }

step "carrying again makes nothing twice"
start_on "$agentorg" "$uphome" "$work/up2.log"
for _ in $(seq 1 60); do
  "$agentorg" call agents list --home "$uphome" >"$work/up2-agents.json" 2>/dev/null &&
    grep -q '"Keeper"' "$work/up2-agents.json" && break
  sleep 0.5
done
node -e '
  const { agents } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = agents.map((a) => a.name).sort().join();
  if (names !== "Keeper,Newcomer") { console.error(names); process.exit(1); }
  console.log(names);
' "$work/up2-agents.json"
stop_app
[ "$(sha_of "$uphome/storage.db")" = "$before" ] || { echo "storage.db changed" >&2; exit 1; }
echo "smoke passed"
