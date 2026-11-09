// First run on a fresh home: the programs made once and started in this process, and the person
// reaching management and each agent's chat through `/api`, as `agentorg call` does.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type App, startApp } from "../src/index.ts";
import { type Person, personOf } from "./person.ts";

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
type Binding = { consumer: string; slot: string; provider: string; export: string };
const wiring = async (person: Person, actor: string) =>
  (await person.call<{ bindings: Binding[] }>("bindings", "list", { actor })).bindings
    .filter((b) => b.consumer === actor)
    .map((b) => `${b.slot} ${b.provider}.${b.export}`)
    .sort();
/** The slot the agent's chat was exposed to the person under, found as the pages find it. */
const chatSlot = async (person: Person, agent: string) => {
  const { bindings } = await person.call<{ bindings: Binding[] }>("bindings", "list", {
    actor: "person",
  });
  return bindings.find((b) => b.provider === agent && b.export === "chat")?.slot as string;
};

async function open(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-programs-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const started: { app: App; person: Person }[] = [];
  const start = async () => {
    const app = await startApp({ home, firstRun: { log: () => {} } });
    const person = personOf(app, home);
    started.push({ app, person });
    return { app, person, ran: await app.firstRun };
  };
  const stop = async () => {
    const last = started.pop();
    await last?.person.close();
    await last?.app.close();
  };
  t.after(async () => {
    while (started.length) await stop();
  });
  return { home, start, stop };
}

const createAssistant = async (person: Person, name: string) => {
  const { creatables } = await person.call<{ creatables: { provider: string; id: string }[] }>(
    "agents",
    "creatable",
  );
  const [assistant] = creatables;
  assert.equal(assistant?.id, "assistant");
  return (
    await person.call<{ agent: string }>("agents", "create", {
      provider: assistant.provider,
      creatable: assistant.id,
      name,
      answers: {},
    })
  ).agent;
};

test("first run makes the programs once, connected to each other, with no installer", async (t) => {
  const s = await open(t);
  const { person, ran, app } = await s.start();
  const { chatgpt, agents, mcp, management } = ran as NonNullable<typeof ran>;
  for (const id of [chatgpt, agents, mcp, management]) assert.ok(id && app.hub.connected(id));
  assert.deepEqual(await wiring(person, agents as string), [
    "actors hub.actors",
    `model ${chatgpt}.session`,
  ]);
  assert.deepEqual(await wiring(person, mcp as string), ["actors hub.actors"]);
  const person_ = await wiring(person, "person");
  for (const expected of [
    `login ${chatgpt}.login`,
    `agents ${management}.agents`,
    `connections ${management}.connections`,
    `skills ${management}.skills`,
  ])
    assert.ok(person_.includes(expected), expected);
  assert.ok(!person_.some((line) => line.startsWith("installer ") || line.startsWith("store ")));
  const { actors } = await person.call<{ actors: { name: string; state: string }[] }>(
    "actors",
    "list",
  );
  assert.ok(!actors.some((actor) => actor.name === "Installer"));
  // Each provider is connected by exposing its export to management.
  assert.equal(
    (await person.call<{ providers: unknown[] }>("agents", "providers")).providers.length,
    1,
  );
  assert.equal(
    (await person.call<{ providers: unknown[] }>("connections", "providers")).providers.length,
    1,
  );
  // Each credential is the person's to keep: readable only by this user.
  for (const name of ["chatgpt", "agents", "mcp", "management"]) {
    const { mode } = statSync(join(s.home, "programs", `${name}.identity`));
    assert.equal(mode & 0o777, 0o600);
  }

  await s.stop();
  const again = await s.start();
  assert.deepEqual(
    [again.ran?.chatgpt, again.ran?.agents, again.ran?.mcp, again.ran?.management],
    [chatgpt, agents, mcp, management],
  );
  assert.equal(
    (await again.person.call<{ providers: unknown[] }>("agents", "providers")).providers.length,
    1,
  );
});

test("an agent is made through agents, and the person reaches its chat, across a restart", async (t) => {
  const s = await open(t);
  let { person } = await s.start();
  const agent = await createAssistant(person, "Scout");
  const slot = await chatSlot(person, agent);
  assert.ok(slot);
  await until(
    () =>
      person.call(slot, "state").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  assert.deepEqual(await person.call(slot, "state"), { state: "idle" });

  // Its events reach the person too; with no sign-in, the turn ends in that error.
  const sub = await person.subscribe(slot, "status");
  await person.call(slot, "send", { text: "hello" });
  await until(
    () =>
      person.heard.some(
        (reply) =>
          reply.sub === sub && (reply.payload as { state?: string } | undefined)?.state === "error",
      ),
    "the turn to fail for want of a sign-in",
  );
  const { messages } = await person.call<{ messages: { text: string }[] }>(slot, "history");
  assert.deepEqual(
    messages.map((message) => message.text),
    ["hello"],
  );

  await s.stop();
  ({ person } = await s.start());
  await until(
    () =>
      person.call(slot, "history").then(
        () => true,
        () => false,
      ),
    "the chat to be back",
  );
  assert.deepEqual(
    (await person.call<{ messages: { text: string }[] }>(slot, "history")).messages.map(
      (message) => message.text,
    ),
    ["hello"],
  );
  assert.equal(
    (await person.call<{ agents: { name: string }[] }>("agents", "list")).agents[0]?.name,
    "Scout",
  );
});

test("a slot not bound to the person is refused, and an exposure's name reaches nothing once gone", async (t) => {
  const s = await open(t);
  const { person } = await s.start();
  await assert.rejects(person.call("nothing", "state"), refused("invalid"));
  await assert.rejects(person.call("agents", "nothing"), refused("invalid"));
  const agent = await createAssistant(person, "Scout");
  const slot = await chatSlot(person, agent);
  await until(
    () =>
      person.call(slot, "state").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  await assert.rejects(person.call(slot, "nothing"), refused("invalid"));
  await person.call("agents", "remove", { agent });
  await until(
    () => person.call(slot, "state").then(() => false, refused("invalid")),
    "the slot to go",
  );
});

test("the app's notes are its own file, and the person's store answers from it", async (t) => {
  const s = await open(t);
  const { person } = await s.start();
  assert.deepEqual(await person.call("store", "get", { key: "a" }), {});
  await person.call("store", "set", { key: "a", value: { b: 1 } });
  assert.deepEqual(await person.call("store", "get", { key: "a" }), { value: { b: 1 } });
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "app-notes.json"), "utf8")).a, { b: 1 });
  assert.equal(statSync(join(s.home, "app-notes.json")).mode & 0o777, 0o600);
  assert.ok(existsSync(join(s.home, "programs", "agents")));
  await assert.rejects(person.call("store", "nothing"), refused("invalid"));
});
