#!/usr/bin/env bash
# The published package as a person gets it: @agentorg/cli packed, with the other @agentorg
# packages inside it (dist/node_modules), installed from its tarball into an empty folder with a
# cache of its own, and globally with a prefix of its own. Then `agentorg` runs on a fresh home:
# first run must make ChatGPT, the providers and management, all connected; an agent must be made
# with `agentorg call agents create`; and the gateway must serve the shell and the sign-in page.
# Last, this build must start on a home each published version made:
# - 0.0.5: its old Actors closed, and `agents create` working;
# - 0.0.6: a connection that must still answer, and an agent whose conversation must be the
#   person's;
# - 0.0.7, 0.0.8 and 0.0.9: an agent that must still run, bound exactly as it was (to its model
#   and a connection's tools among others), whose two chats must become one conversation with the
#   person, the one last written in, which takes a message;
# - 0.0.10 to 0.0.13: an agent with an AgentOrg control unit that must still run, bound exactly
#   as it was, whose conversation takes a message, and whose unit's skill is this build's.
# Once a version is published, it gets a section here, or joins the loop of an earlier version
# when it takes the same commands and the same is asked of this build on its home (not in the
# change that releases it: the registry has it only after its tag). A section makes, with that
# version's own commands, what the version let a person keep, then starts this build on that home
# and uses it.
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
# The person's slot for a chat, asked of `agentorg` ($1) on a home ($2); empty if there is none.
chat_slot() {
  "$1" call bindings list '{"actor":"person"}' --home "$2" 2>/dev/null |
    node -e '
      const { bindings } = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(bindings.find((b) => b.export === "chat")?.slot ?? "");
    '
}

# What an agent ($3, its id) is bound to, asked of `agentorg` ($1) on a home ($2): a line for each
# of its slots, with the interface, the Actor and the export it reaches, sorted.
agent_bindings() {
  "$1" call bindings list "{\"actor\":\"$3\"}" --home "$2" |
    node -e '
      const { bindings } = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const own = bindings.filter((b) => b.consumer === process.argv[1]);
      const line = (b) => `${b.slot} ${b.interface} ${b.provider} ${b.export}`;
      console.log(own.map(line).sort().join("\n"));
    ' "$3"
}
# Make a connection to the MCP test fixture with `agentorg` ($1) on a home ($2), once a way to
# connect is offered there, and print its id; nothing if none is offered in time.
fixture_connection() {
  for _ in $(seq 1 120); do
    "$1" call connections providers --home "$2" >"$work/mcp.json" 2>/dev/null &&
      grep -Eq '"kind": ?"command"' "$work/mcp.json" && break
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  grep -Eq '"kind": ?"command"' "$work/mcp.json" || return 0
  "$1" call connections create "$(node -e '
    const { providers: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify({
      provider: one.provider, kind: "command", name: "Fixture",
      params: { command: process.execPath, args: [process.argv[2]] },
    }));
  ' "$work/mcp.json" "$root/packages/mcp/dist/test/fixtures/server.js")" --home "$2" |
    node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).connection)'
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
connection="$(fixture_connection "$was" "$home6")"
[ -n "$connection" ] ||
  { echo "0.0.6 offered no way to connect" >&2; cat "$work/old6.log" >&2; exit 1; }
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
slot="$(chat_slot "$was" "$home6")"
[ -n "$slot" ] || { echo "0.0.6 gave the person no chat" >&2; exit 1; }
"$was" call "$slot" send '{"text":"Said on 0.0.6."}' --home "$home6" >/dev/null
stop_app
start_on "$agentorg" "$home6" "$work/up6.log"
# Its chats changed shape since 0.0.6: the person's reach to them must answer, at the slot it had,
# with the conversation as the person's. The slot keeps its name while the agent is away, so the
# name alone doesn't say the reach works: its conversations must answer.
for _ in $(seq 1 120); do
  [ "$(chat_slot "$agentorg" "$home6")" = "$slot" ] &&
    "$agentorg" call "$slot" list --home "$home6" >"$work/chats6.json" 2>/dev/null && break
  kill -0 "$pid" 2>/dev/null || { cat "$work/up6.log" >&2; exit 1; }
  sleep 0.5
done
[ -s "$work/chats6.json" ] ||
  { echo "The person lost the 0.0.6 agent's chat on this build" >&2; cat "$work/up6.log" >&2; exit 1; }
<"$work/chats6.json" \
  node -e '
    const { conversations } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [one] = conversations;
    if (conversations.length !== 1 || one.with !== "person" || one.latest?.text !== "Said on 0.0.6.") {
      console.error(JSON.stringify(conversations));
      process.exit(1);
    }
    console.log(`0.0.6'"'"'s conversation is the person'"'"'s, its latest "${one.latest.text}"`);
  '
wait_answers "$agentorg" ||
  { echo "0.0.6's connection doesn't work on this build" >&2; cat "$work/up6.log" >&2; exit 1; }
"$agentorg" call connections remove "{\"connection\":\"$connection\"}" --home "$home6" >/dev/null
"$agentorg" call connections list --home "$home6" | grep -q "$connection" &&
  { echo "The connection is still there" >&2; exit 1; }
echo "0.0.6's connection works here and is removed"
stop_app

# 0.0.7, 0.0.8 and 0.0.9 take the same commands to make an agent, two chats and a connection
# exposed to the agent, and the same is
# asked of this build on each home, so they share this section. A later version joins the list
# only while both hold; one whose commands differ gets its own section after the loop. A published version
# never changes, so one leaves the list only when this build must do something different with its
# home. The homes differ: with no sign-in a 0.0.7 chat is its own work, whose turn failed; a 0.0.8
# or 0.0.9 chat's message waits for the main loop under a mark, and this build puts the next
# message there to the main loop with it. Their work records, and messages that name their work,
# are written only after a model answers, so no home here has them.
for v in 0.0.7 0.0.8 0.0.9; do
  step "a home the published $v made: its agent runs, bound as it was, and its chats are read on this build, the older one added to"
  oldv="$work/old-$v"
  mkdir "$oldv"
  (cd "$oldv" && echo '{"private":true}' >package.json &&
    npm install --silent --no-audit --no-fund --cache "$work/cache" "@agentorg/cli@$v")
  was="$oldv/node_modules/.bin/agentorg"
  homev="$work/home-$v"
  start_on "$was" "$homev" "$work/old-$v.log"
  for _ in $(seq 1 120); do
    "$was" call agents creatable --home "$homev" >"$work/creatable-$v.json" 2>/dev/null &&
      grep -Eq '"id": ?"assistant"' "$work/creatable-$v.json" && break
    kill -0 "$pid" 2>/dev/null || { cat "$work/old-$v.log" >&2; exit 1; }
    sleep 0.5
  done
  grep -Eq '"id": ?"assistant"' "$work/creatable-$v.json" ||
    { echo "$v offered no Assistant" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  create="$(node -e '
    const { creatables: [one] } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify({ stack: { base: { provider: one.provider, creatable: one.id }, units: [] }, name: "Elder" }));
  ' "$work/creatable-$v.json")"
  "$was" call agents create "$create" --home "$homev" >/dev/null
  slot="$(chat_slot "$was" "$homev")"
  [ -n "$slot" ] || { echo "$v gave the person no chat" >&2; exit 1; }
  # The person has the slot as the agent is made; its chats answer once the agent has joined.
  answered=""
  for _ in $(seq 1 60); do
    "$was" call "$slot" list --home "$homev" >/dev/null 2>&1 && { answered=1; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  [ -n "$answered" ] || { echo "$v's chats never answered" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  # Two chats, as the version kept them: with no sign-in each holds its message and no answer.
  # The id of the chat a message ($1) starts on the version.
  started() {
    "$was" call "$slot" send "{\"text\":\"$1\"}" --home "$homev" |
      node -e '
        const { chat } = JSON.parse(require("fs").readFileSync(0, "utf8"));
        if (!chat) process.exit(1);
        console.log(chat);
      '
  }
  started "Said on $v." >/dev/null || { echo "$v started no chat" >&2; exit 1; }
  started "A second chat." >/dev/null || { echo "$v started no second chat" >&2; exit 1; }
  # A connection of the person's, exposed to the agent as tools: the agent must keep it on this
  # build, with what it was bound to as it was made.
  connection="$(fixture_connection "$was" "$homev")"
  [ -n "$connection" ] ||
    { echo "$v offered no way to connect" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  elder="$("$was" call agents list --home "$homev" | node -e '
    const { agents } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(agents.find((a) => a.name === "Elder")?.agent ?? "");
  ')"
  "$was" call agents expose "{\"agent\":\"$elder\",\"connection\":\"$connection\",\"as\":\"fixture\"}" --home "$homev" >/dev/null ||
    { echo "$v exposed no connection to its agent" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  agent_bindings "$was" "$homev" "$elder" >"$work/bound-$v.txt" ||
    { echo "$v didn't say what its agent is bound to" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  for bound in model fixture; do
    grep -q "^$bound " "$work/bound-$v.txt" ||
      { echo "$v bound its agent to no $bound" >&2; cat "$work/bound-$v.txt" >&2; exit 1; }
  done
  stop_app
  start_on "$agentorg" "$homev" "$work/up-$v.log"
  # The person keeps the slot across the change of the chat interface: its conversations answer
  # once the agent is back.
  for _ in $(seq 1 120); do
    [ "$(chat_slot "$agentorg" "$homev")" = "$slot" ] &&
      "$agentorg" call "$slot" list --home "$homev" >"$work/chats-$v.json" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || { cat "$work/up-$v.log" >&2; exit 1; }
    sleep 0.5
  done
  [ -s "$work/chats-$v.json" ] ||
    { echo "The person lost the $v agent's chats on this build" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  # The chat last written in is the person's one conversation, which takes a message after what
  # the version kept there; the other chat is gone.
  "$agentorg" call "$slot" send '{"text":"And on this build."}' --home "$homev" >/dev/null
  "$agentorg" call "$slot" history '{}' --home "$homev" >"$work/history-$v.json"
  "$agentorg" call agents list --home "$homev" >"$work/agents-$v.json"
  node -e '
    const read = (f) => JSON.parse(require("fs").readFileSync(f, "utf8"));
    const got = {
      agent: read(process.argv[3]).agents.find((a) => a.name === "Elder")?.status.state,
      with: read(process.argv[1]).conversations.map((one) => one.with),
      said: read(process.argv[2]).messages.filter((m) => m.role === "user").map((m) => m.text),
    };
    const want = {
      agent: "running",
      with: ["person"],
      said: ["A second chat.", "And on this build."],
    };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(JSON.stringify(got));
      process.exit(1);
    }
    console.log(`${process.argv[4]}'"'"'s agent is ${got.agent}, its chat last written in is the person'"'"'s conversation and took a message`);
  ' "$work/chats-$v.json" "$work/history-$v.json" "$work/agents-$v.json" "$v" ||
    { echo "This build lost something of the $v home" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  # The agent is bound exactly as it was: to its model, its tools, and the rest.
  agent_bindings "$agentorg" "$homev" "$elder" >"$work/bound-$v-now.txt" ||
    { echo "This build didn't say what the $v agent is bound to" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  diff "$work/bound-$v.txt" "$work/bound-$v-now.txt" ||
    { echo "The $v agent is not bound on this build as it was" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  echo "$v's agent is bound as it was:"
  cat "$work/bound-$v.txt"
  if grep -E "didn't work|Error" "$work/up-$v.log"; then
    echo "This build reported a problem on the $v home" >&2
    exit 1
  fi
  stop_app
done

# 0.0.10 to 0.0.13 keep one conversation with each agent where those before them kept chats, and
# take the same commands, so they share this section. Each agent has an AgentOrg control unit,
# whose skill the version copied into the home: this build brings it up to date at its first
# start, if it isn't already.
# The skill as this build's AgentOrg control gives it.
node --input-type=module -e '
  const { skillFile } = await import(process.argv[1]);
  process.stdout.write(skillFile("SKILL.md"));
' "$work/install/node_modules/@agentorg/cli/dist/node_modules/@agentorg/manager/dist/src/control.js" >"$work/delegating-now.md"
[ -s "$work/delegating-now.md" ] || { echo "This build gave no delegating skill" >&2; exit 1; }
for v in 0.0.10 0.0.11 0.0.12 0.0.13; do
  step "a home the published $v made: its agent runs, bound as it was, its conversation takes a message, and its unit's skill is this build's"
  oldv="$work/old-$v"
  mkdir "$oldv"
  (cd "$oldv" && echo '{"private":true}' >package.json &&
    npm install --silent --no-audit --no-fund --cache "$work/cache" "@agentorg/cli@$v")
  was="$oldv/node_modules/.bin/agentorg"
  homev="$work/home-$v"
  start_on "$was" "$homev" "$work/old-$v.log"
  for _ in $(seq 1 120); do
    "$was" call agents creatable --home "$homev" >"$work/creatable-$v.json" 2>/dev/null &&
      grep -Eq '"id": ?"assistant"' "$work/creatable-$v.json" &&
      "$was" call agents units --home "$homev" >"$work/units-$v.json" 2>/dev/null &&
      grep -Eq '"id": ?"control"' "$work/units-$v.json" && break
    kill -0 "$pid" 2>/dev/null || { cat "$work/old-$v.log" >&2; exit 1; }
    sleep 0.5
  done
  grep -Eq '"id": ?"control"' "$work/units-$v.json" ||
    { echo "$v offered no AgentOrg control" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  create="$(node -e '
    const read = (f) => JSON.parse(require("fs").readFileSync(f, "utf8"));
    const { creatables: [one] } = read(process.argv[1]);
    const control = read(process.argv[2]).units.find((unit) => unit.id === "control");
    const templates = control.form.find((field) => field.id === "templates").options;
    console.log(JSON.stringify({
      stack: {
        base: { provider: one.provider, creatable: one.id },
        units: [{ provider: control.provider, unit: "control", values: { templates: [templates[0].value] } }],
      },
      name: "Elder",
    }));
  ' "$work/creatable-$v.json" "$work/units-$v.json")"
  "$was" call agents create "$create" --home "$homev" >/dev/null ||
    { echo "$v made no agent with AgentOrg control" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  # The skill as the home keeps it: it must be this build's text once this build has started.
  skill="$homev/programs/management/skills/delegating/SKILL.md"
  [ -f "$skill" ] || { echo "$v copied no delegating skill" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  # A version's copy is already this build's text when the skill hasn't changed since it.
  had=""
  cmp -s "$skill" "$work/delegating-now.md" && had=1
  slot="$(chat_slot "$was" "$homev")"
  [ -n "$slot" ] || { echo "$v gave the person no conversation" >&2; exit 1; }
  # Its conversation answers once the agent has joined; then one message is said in it.
  answered=""
  for _ in $(seq 1 60); do
    "$was" call "$slot" history '{}' --home "$homev" >/dev/null 2>&1 && { answered=1; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  [ -n "$answered" ] || { echo "$v's conversation never answered" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  "$was" call "$slot" send "{\"text\":\"Said on $v.\"}" --home "$homev" >/dev/null ||
    { echo "$v's conversation took no message" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  connection="$(fixture_connection "$was" "$homev")"
  [ -n "$connection" ] || { echo "$v offered no way to connect" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  elder="$("$was" call agents list --home "$homev" | node -e '
    const { agents } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(agents.find((a) => a.name === "Elder")?.agent ?? "");
  ')"
  "$was" call agents expose "{\"agent\":\"$elder\",\"connection\":\"$connection\",\"as\":\"fixture\"}" --home "$homev" >/dev/null ||
    { echo "$v exposed no connection to its agent" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  agent_bindings "$was" "$homev" "$elder" >"$work/bound-$v.txt" ||
    { echo "$v didn't say what its agent is bound to" >&2; cat "$work/old-$v.log" >&2; exit 1; }
  for bound in model fixture control; do
    grep -q "^$bound " "$work/bound-$v.txt" ||
      { echo "$v bound its agent to no $bound" >&2; cat "$work/bound-$v.txt" >&2; exit 1; }
  done
  stop_app
  start_on "$agentorg" "$homev" "$work/up-$v.log"
  # The person keeps the conversation's slot, which answers once the agent is back.
  back=""
  for _ in $(seq 1 120); do
    [ "$(chat_slot "$agentorg" "$homev")" = "$slot" ] &&
      "$agentorg" call "$slot" history '{}' --home "$homev" >/dev/null 2>&1 && { back=1; break; }
    kill -0 "$pid" 2>/dev/null || { cat "$work/up-$v.log" >&2; exit 1; }
    sleep 0.5
  done
  [ -n "$back" ] ||
    { echo "The person lost the $v agent's conversation on this build" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  # The skill is brought up to date as management starts, beside the agent coming back.
  for _ in $(seq 1 60); do
    cmp -s "$skill" "$work/delegating-now.md" && break
    sleep 0.5
  done
  cmp -s "$skill" "$work/delegating-now.md" ||
    { echo "This build didn't bring $v's delegating skill up to date" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  if [ -n "$had" ]; then
    echo "$v's delegating skill was this build's already, and still is"
  else
    echo "This build brought $v's delegating skill up to date"
  fi
  "$agentorg" call "$slot" send '{"text":"And on this build."}' --home "$homev" >/dev/null
  "$agentorg" call "$slot" history '{}' --home "$homev" >"$work/history-$v.json"
  "$agentorg" call agents list --home "$homev" >"$work/agents-$v.json"
  node -e '
    const read = (f) => JSON.parse(require("fs").readFileSync(f, "utf8"));
    const got = {
      agent: read(process.argv[2]).agents.find((a) => a.name === "Elder")?.status.state,
      said: read(process.argv[1]).messages.filter((m) => m.role === "user").map((m) => m.text),
    };
    const want = { agent: "running", said: [`Said on ${process.argv[3]}.`, "And on this build."] };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(JSON.stringify(got));
      process.exit(1);
    }
    console.log(`${process.argv[3]}'"'"'s agent is ${got.agent}, and its conversation took a message`);
  ' "$work/history-$v.json" "$work/agents-$v.json" "$v" ||
    { echo "This build lost something of the $v home" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  agent_bindings "$agentorg" "$homev" "$elder" >"$work/bound-$v-now.txt" ||
    { echo "This build didn't say what the $v agent is bound to" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  diff "$work/bound-$v.txt" "$work/bound-$v-now.txt" ||
    { echo "The $v agent is not bound on this build as it was" >&2; cat "$work/up-$v.log" >&2; exit 1; }
  echo "$v's agent is bound as it was:"
  cat "$work/bound-$v.txt"
  if grep -E "didn't work|Error" "$work/up-$v.log"; then
    echo "This build reported a problem on the $v home" >&2
    exit 1
  fi
  stop_app
done
echo "smoke passed"
