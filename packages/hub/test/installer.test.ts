import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex as NodeDuplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubActors, hubBindings, installer, kv } from "@agentorg/interfaces";
import type { Duplex, Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { HUB, Hub, type HubOptions, listen, PERSON, STORAGE } from "../src/index.ts";
import { counter } from "./fixtures/seeded/src/interface.ts";

// dist/test/installer.test.js → the repository's packages, and this package's fixtures.
const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtures = join(packages, "hub", "test", "fixtures");
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(10);
  }
};
const runner = fileURLToPath(import.meta.resolve("@agentorg/sdk/host/runner.js"));
const MANAGEMENT = ["packages", "actors", "grants", "exports", "bindings"] as const;

/**
 * A Hub with the installer running as a package Actor, bound as the first run binds it (the Hub's
 * management and storage.admin), and a client bound to its installer export. `manager: false`
 * leaves its hub.bindings slot unbound, as a replacement installer without that power would be.
 */
async function setup(
  t: test.TestContext,
  options: { manager?: boolean; hub?: HubOptions; runInstaller?: "spawned" | "by hand" } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-installer-")));
  const home = join(dir, "home");
  const hub = Hub.open(home, options.hub);
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors },
    declare: false,
  });
  open.push(person);
  const add = async (dirOf: string) => {
    const built = await buildPackage(dirOf, { out: join(dir, "out") });
    hub.state.addPackage(PERSON, built.file);
    return built.hash;
  };
  const installerHash = await add(join(packages, "installer"));
  const { actorId: installerId } = await person.slots.actors.call.create({
    name: "installer",
    package: installerHash,
    bindings: [
      ...MANAGEMENT.filter((name) => options.manager !== false || name !== "bindings").map(
        (name) => ({ slot: `installer.${name}`, provider: HUB, export: name }),
      ),
      { slot: "installer.storage", provider: STORAGE, export: "admin" },
    ],
  });
  if (options.runInstaller === "by hand") {
    // Where the Hub can't run host processes, its runner is started here, as runner.test does.
    hub.state.start(PERSON, installerId);
    const child = spawn(
      process.execPath,
      [runner, join(home, "packages", installerHash), installerId],
      { stdio: ["ignore", "ignore", "ignore", "pipe"], env: {} },
    );
    t.after(() => void child.kill("SIGKILL"));
    hub.accept(NodeDuplex.toWeb(child.stdio[3] as NodeDuplex) as unknown as Duplex, {
      actorId: installerId,
    });
  } else await person.slots.actors.call.start({ actorId: installerId });
  await until(() => hub.connected(installerId));
  /** An external Actor with these slots bound: how to connect as it. */
  const as = (name: string, bindings: { slot: string; provider: string; export: string }[]) => {
    const made = hub.state.createActor(PERSON, { name, bindings });
    return { hubUrl: server.url, actorId: made.actorId, credential: made.credential as string };
  };
  const toInstaller = { slot: "installer", provider: installerId, export: "installer.installer" };
  const track = <C extends { close(): void }>(c: C) => {
    open.push(c);
    return c;
  };
  // A shell, as the person's is: a manager (bound to hub.bindings), so it may grant anything.
  const shell = track(
    await connect({
      ...as("shell", [toInstaller, { slot: "bindings", provider: HUB, export: "bindings" }]),
      slots: { installer, bindings: hubBindings },
    }),
  );
  // An assistant's kind of caller: bound to storage's kv itself, and to nothing of the hub's.
  const assistant = track(
    await connect({
      ...as("assistant", [toInstaller, { slot: "store", provider: STORAGE, export: "kv" }]),
      slots: { installer, store: kv },
    }),
  );
  // A caller that holds the installer and nothing else.
  const bare = track(await connect({ ...as("bare", [toInstaller]), slots: { installer } }));
  await until(
    () =>
      shell.slots.installer.bound && assistant.slots.installer.bound && bare.slots.installer.bound,
  );
  const seeded = await add(join(fixtures, "seeded"));
  return { hub, person, shell, assistant, bare, seeded, installerHash, as, track };
}

test("plan proposes, for each open slot, the running exports of exactly its interface", async (t) => {
  const { hub, person, shell, seeded } = await setup(t);
  const plan = await shell.slots.installer.call.plan({ package: seeded });
  assert.deepEqual(plan, {
    slots: [
      { slot: "counter.store", interface: "kv@1", candidates: [{ actor: STORAGE, export: "kv" }] },
    ],
    views: [],
  });
  // An Actor that isn't running doesn't serve: a created counter's export is no candidate.
  const { actorId } = await person.slots.actors.call.create({ name: "idle", package: seeded });
  const again = await shell.slots.installer.call.plan({ package: seeded });
  assert.ok(!JSON.stringify(again).includes(actorId));
  assert.ok(hub.state.actor(actorId));
});

test("install makes the Actor with exactly the connections given, seeds its store and starts it", async (t) => {
  const { hub, shell, seeded, as, track } = await setup(t);
  const done = await shell.slots.installer.call.install({
    package: seeded,
    name: "counter",
    connections: { "counter.store": { actor: STORAGE, export: "kv" } },
    start: true,
  });
  assert.deepEqual([done.unbound, done.unseeded], [[], []]);
  await until(() => hub.connected(done.actorId));
  // The seed (count 41) is in its store: the first increment gives 42.
  const user = track(
    await connect({
      ...as("user", [{ slot: "counter", provider: done.actorId, export: "counter.counter" }]),
      slots: { counter },
    }),
  );
  await until(() => user.slots.counter.bound);
  assert.deepEqual(await user.slots.counter.call.increment({}), { value: 42 });

  // Slots left out stay unbound, and are listed.
  const bare = await shell.slots.installer.call.install({
    package: seeded,
    name: "bare",
    connections: {},
  });
  assert.deepEqual([bare.unbound, bare.unseeded], [["counter.store"], ["counter.store"]]);
  assert.equal(hub.state.binding(bare.actorId, "counter.store"), undefined);
});

test("install is all or none: a connection it can't make leaves nothing behind", async (t) => {
  const { hub, shell, seeded } = await setup(t);
  const before = hub.state.actors().length;
  // A slot that isn't the package's, and an export that isn't there.
  await assert.rejects(
    shell.slots.installer.call.install({
      package: seeded,
      name: "wrong",
      connections: { "counter.nope": { actor: STORAGE, export: "kv" } },
    }),
    (e: Refused) => e.code === "invalid",
  );
  await assert.rejects(
    shell.slots.installer.call.install({
      package: seeded,
      name: "missing",
      connections: { "counter.store": { actor: STORAGE, export: "nope" } },
    }),
  );
  assert.equal(hub.state.actors().length, before);
});

test("an installer that isn't a manager refuses an install it can't grant, whole", async (t) => {
  const { hub, shell, seeded } = await setup(t, { manager: false });
  const before = hub.state.actors().length;
  await assert.rejects(
    shell.slots.installer.call.install({
      package: seeded,
      name: "counter",
      connections: { "counter.store": { actor: STORAGE, export: "kv" } },
    }),
    (e: Refused) => e.code === "forbidden" && /nothing was created/.test(e.message),
  );
  assert.equal(hub.state.actors().length, before);
});

test("a seed or a start that fails after the Actor is made takes the Actor with it", async (t) => {
  // A store too small for the seed: refused by storage once the Actor exists.
  const small = await setup(t, { hub: { storage: { maxValue: 1024, maxPerConsumer: 4 } } });
  await assert.rejects(
    small.shell.slots.installer.call.install({
      package: small.seeded,
      name: "counter",
      connections: { "counter.store": { actor: STORAGE, export: "kv" } },
    }),
    (e: Refused) => e.code === "quota",
  );
  assert.deepEqual(
    small.hub.state
      .actors()
      .filter((a) => a.name === "counter")
      .map((a) => a.state),
    ["closed"],
  );
  // A Hub where host processes can't start: the install's start is refused, and so is the Actor.
  const broken = await setup(t, {
    hub: {
      processes: { sandbox: ["/bin/sh", "-c", "echo 'no namespaces here' >&2; exit 1", "x"] },
    },
    runInstaller: "by hand",
  });
  await assert.rejects(
    broken.shell.slots.installer.call.install({
      package: broken.seeded,
      name: "counter",
      connections: { "counter.store": { actor: STORAGE, export: "kv" } },
      start: true,
    }),
    (e: Refused) => e.code === "unsupported",
  );
  assert.deepEqual(
    broken.hub.state
      .actors()
      .filter((a) => a.name === "counter")
      .map((a) => a.state),
    ["closed"],
  );
});

test("the installer grants nothing its caller couldn't: delegation only narrows", async (t) => {
  const { hub, shell, assistant, bare, seeded, installerHash } = await setup(t);
  const count = () => hub.state.actors().filter((a) => a.state !== "closed").length;
  const before = count();
  // A caller holding only the installer can't hand out the Hub's management or storage.admin,
  // even through a package (the installer's own) that asks for them.
  await assert.rejects(
    bare.slots.installer.call.install({
      package: installerHash,
      name: "escalated",
      connections: {
        "installer.bindings": { actor: HUB, export: "bindings" },
        "installer.storage": { actor: STORAGE, export: "admin" },
      },
    }),
    (e: Refused) =>
      e.code === "forbidden" &&
      e.message.includes("installer.bindings → hub.bindings") &&
      e.message.includes("installer.storage → storage.admin"),
  );
  // Nor storage's kv, which it isn't bound to.
  await assert.rejects(
    bare.slots.installer.call.install({
      package: seeded,
      name: "counter",
      connections: { "counter.store": { actor: STORAGE, export: "kv" } },
    }),
    (e: Refused) => e.code === "forbidden",
  );
  assert.equal(count(), before, "nothing was created");
  // An assistant bound to kv may wire kv, and gets the seed; not the hub's management it lacks.
  const made = await assistant.slots.installer.call.install({
    package: seeded,
    name: "counter",
    connections: { "counter.store": { actor: STORAGE, export: "kv" } },
  });
  assert.deepEqual(made.unseeded, []);
  await assert.rejects(
    assistant.slots.installer.call.install({
      package: installerHash,
      name: "escalated",
      connections: { "installer.bindings": { actor: HUB, export: "bindings" } },
    }),
    (e: Refused) => e.code === "forbidden",
  );
  // A manager installs anything.
  const anything = await shell.slots.installer.call.install({
    package: installerHash,
    name: "second installer",
    connections: {
      "installer.bindings": { actor: HUB, export: "bindings" },
      "installer.storage": { actor: STORAGE, export: "admin" },
    },
  });
  assert.equal(hub.state.isManager(anything.actorId), true);
});
