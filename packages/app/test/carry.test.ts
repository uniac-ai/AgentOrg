// Carrying a home from an earlier release: its `hub.db` and `storage.db` written as that release
// left them, and this build started on it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PERSON } from "@agentorg/hub";
import { type App, type CarryPlan, prepareCarry, startApp } from "../src/index.ts";
import { type Person, personOf } from "./person.ts";

const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "bundled");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const entry = (id: string, role: string, content: string) => ({
  id,
  role,
  at: "2026-11-01T00:00:00.000Z",
  items: [{ type: "message", role, content }],
});

/** A home as an earlier release leaves it: two agents of one name, and what else it ran. */
async function earlierHome(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-carry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const app = await startApp({ home, firstRun: false });
  const person = personOf(app, home);
  const index = JSON.parse(readFileSync(join(bundled, "index.json"), "utf8")) as Record<
    string,
    string
  >;
  const add = async (name: string) =>
    (
      await person.call<{ hash: string }>("packages", "add", {
        path: join(bundled, index[name] as string),
      })
    ).hash;
  const assistant = await add("assistant");
  const board = await add("board");
  const installer = await add("installer");
  const make = (name: string, hash: string) =>
    app.hub.state.createActor(PERSON, { name, package: hash }).actorId;
  const one = make("Scout", assistant);
  const two = make("Scout", assistant);
  const built = make("Board", board);
  const madeInstaller = make("Installer", installer);
  await person.close();
  await app.close();

  const db = new DatabaseSync(join(home, "storage.db"));
  const put = (consumer: string, slot: string, key: string, value: unknown) =>
    db
      .prepare("INSERT INTO store (consumer, slot, key, value, size) VALUES (?, ?, ?, ?, 1)")
      .run(consumer, slot, key, JSON.stringify(value));
  put(PERSON, "store", "app/first-run", { assistant, assistants: [assistant] });
  put(PERSON, "store", "layout", [{ id: "p1" }]);
  put(one, "logic.store", "msg/000000000001", entry("000000000001", "user", "first of one"));
  put(one, "logic.store", "msg/000000000002", entry("000000000002", "assistant", "reply of one"));
  put(one, "logic.store", "settings/model", "gpt-chosen");
  put(two, "logic.store", "msg/000000000001", entry("000000000001", "user", "first of two"));
  put(built, "logic.store", "count", 7);
  put(madeInstaller, "installer.store", "credential", "the-old-sign-in");
  db.close();
  return { home, old: { one, two, built, madeInstaller } };
}

async function run(t: test.TestContext, home: string) {
  const app: App = await startApp({ home, firstRun: { log: () => {} } });
  const person: Person = personOf(app, home);
  const ran = await app.firstRun;
  assert.ok(ran);
  t.after(async () => {
    await person.close();
    await app.close();
  });
  const stop = async () => {
    await person.close();
    await app.close();
  };
  return { app, person, stop };
}
const plan = (home: string) =>
  JSON.parse(readFileSync(join(home, "carry", "plan.json"), "utf8")) as CarryPlan;
type Agents = { agents: { agent: string; name: string; status: { state: string } }[] };
type Binding = { provider: string; export: string; slot: string };
const texts = async (person: Person, agent: string) => {
  const { bindings } = await person.call<{ bindings: Binding[] }>("bindings", "list", {
    actor: "person",
  });
  const slot = bindings.find((b) => b.provider === agent && b.export === "chat")?.slot as string;
  assert.ok(slot);
  let messages: { text: string }[] = [];
  await until(
    () =>
      person.call<{ messages: { text: string }[] }>(slot, "history").then(
        (page) => {
          messages = page.messages;
          return true;
        },
        () => false,
      ),
    "the chat to answer",
  );
  return messages.map((message) => message.text);
};

test("an earlier home's agents come back by name, with their records, and nothing is lost", async (t) => {
  const { home, old } = await earlierHome(t);
  const before = sha(join(home, "storage.db"));
  const hubBefore = sha(join(home, "hub.db"));
  const { app, person, stop } = await run(t, home);

  const { agents } = await person.call<Agents>("agents", "list");
  assert.deepEqual(
    agents.map((one) => [one.name, one.status.state]),
    [
      ["Scout", "running"],
      ["Scout", "running"],
    ],
  );
  const [first, second] = plan(home).agents.map((one) => one.agent as string);
  assert.deepEqual(await texts(person, first as string), ["first of one", "reply of one"]);
  assert.deepEqual(await texts(person, second as string), ["first of two"]);
  const chosen = join(
    home,
    "programs",
    "agents",
    "agents",
    first as string,
    "kv",
    "settings%2Fmodel",
  );
  assert.equal(JSON.parse(readFileSync(chosen, "utf8")), "gpt-chosen");

  // The old Actors are closed and none removed.
  for (const id of Object.values(old)) assert.equal(app.hub.state.actor(id).state, "closed");
  assert.equal(plan(home).done, true);
  await stop();

  // What the person had stays exactly as it was, and the private copy has gone.
  assert.equal(sha(join(home, "storage.db")), before);
  assert.equal(sha(join(home, "hub.db.before-carry")), hubBefore);
  assert.equal(statSync(join(home, "hub.db.before-carry")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(home, "carry", "storage")), false);
});

test("carrying again makes nothing twice", async (t) => {
  const { home } = await earlierHome(t);
  const first = await run(t, home);
  const { agents } = await first.person.call<Agents>("agents", "list");
  await first.stop();
  const second = await run(t, home);
  assert.deepEqual(
    (await second.person.call<Agents>("agents", "list")).agents.map((one) => one.agent),
    agents.map((one) => one.agent),
  );
  await second.stop();

  // A start that stopped between making an agent and noting it: it finds that agent by name.
  const noted = plan(home);
  writeFileSync(
    join(home, "carry", "plan.json"),
    JSON.stringify({ agents: noted.agents.map(({ old, name }) => ({ old, name })) }),
  );
  const third = await run(t, home);
  const after = (await third.person.call<Agents>("agents", "list")).agents;
  assert.deepEqual(after.map((one) => one.agent).sort(), agents.map((one) => one.agent).sort());
  assert.equal(plan(home).done, true);
  assert.deepEqual(await texts(third.person, plan(home).agents[0]?.agent as string), [
    "first of one",
    "reply of one",
  ]);
  await third.stop();
});

test("a carry that fails part way loses nothing, deletes its copy, and finishes at the next start", async (t) => {
  const { home, old } = await earlierHome(t);
  const before = sha(join(home, "storage.db"));
  const carry = prepareCarry(home);
  assert.ok(carry);
  const copy = join(home, "carry", "storage");
  assert.equal(statSync(copy).mode & 0o777, 0o700);
  assert.equal(statSync(join(copy, "storage.db")).mode & 0o777, 0o600);
  let creates = 0;
  await assert.rejects(
    carry
      .finish(
        {
          call: async (slot, method) => {
            assert.equal(slot, "agents");
            if (method === "creatable")
              return { creatables: [{ provider: "act_provider", id: "assistant" }] };
            if (method === "list") return { agents: [] };
            if (method === "create") {
              if (++creates === 2) throw new Error("no more");
              return { agent: "act_madeearlier" };
            }
            return {};
          },
        },
        () => {},
      )
      .finally(() => carry.discard()),
    /no more/,
  );
  assert.equal(existsSync(copy), false);
  assert.equal(sha(join(home, "storage.db")), before);
  assert.deepEqual(
    plan(home).agents.map((one) => [one.old, one.agent, one.done]),
    [
      [old.one, "act_madeearlier", true],
      [old.two, undefined, undefined],
    ],
  );

  const { person, stop } = await run(t, home);
  assert.equal(plan(home).done, true);
  assert.deepEqual(await texts(person, plan(home).agents[1]?.agent as string), ["first of two"]);
  assert.equal(sha(join(home, "storage.db")), before);
  await stop();
});

test("a fresh home has no storage.db, and nothing to carry", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-carry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { stop } = await run(t, home);
  assert.equal(existsSync(join(home, "storage.db")), false);
  assert.equal(existsSync(join(home, "carry")), false);
  await stop();
});
