import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex as NodeDuplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubActors, hubBindings, installer, kv, layout } from "@agentorg/interfaces";
import { type Duplex, Refused } from "@agentorg/sdk";
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
  // The person's layout, as the gateway would serve it: a list kept here.
  const placements: { id: string; actor: string; module: string; title?: string; by?: string }[] =
    [];
  const layoutMade = hub.state.createActor(PERSON, { name: "layout provider" });
  const layoutProvider = await connect({
    hubUrl: server.url,
    actorId: layoutMade.actorId,
    credential: layoutMade.credential as string,
    exports: { layout },
    start(ctx) {
      ctx.exports.layout.implement({
        get: async () => ({ home: placements }),
        place: async (input, { caller }) => {
          if (input.title === "refused") throw new Refused("invalid", "This layout won't take it.");
          const id = `p${placements.length + 1}`;
          placements.push({
            id,
            actor: input.actor,
            module: input.module,
            title: input.title,
            by: caller,
          });
          return { id };
        },
        remove: async ({ id }) => {
          placements.splice(placements.findIndex((p) => p.id === id) >>> 0, 1);
          return {};
        },
        move: async () => ({}),
      });
    },
  });
  open.push(layoutProvider);
  const { actorId: installerId } = await person.slots.actors.call.create({
    name: "installer",
    package: installerHash,
    bindings: [
      ...MANAGEMENT.filter((name) => options.manager !== false || name !== "bindings").map(
        (name) => ({ slot: `installer.${name}`, provider: HUB, export: name }),
      ),
      { slot: "installer.storage", provider: STORAGE, export: "admin" },
      { slot: "installer.layout", provider: layoutMade.actorId, export: "layout" },
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
  return { hub, person, shell, assistant, bare, seeded, installerHash, as, track, add, placements };
}

test("plan proposes, for each open slot, the running exports of exactly its interface", async (t) => {
  const { hub, person, shell, seeded } = await setup(t);
  const plan = await shell.slots.installer.call.plan({ package: seeded });
  assert.deepEqual(plan, {
    slots: [
      { slot: "counter.store", interface: "kv@1", candidates: [{ actor: STORAGE, export: "kv" }] },
    ],
    views: [],
    exposes: [],
  });
  // An Actor that isn't running doesn't serve: a created counter's export is no candidate.
  const { actorId } = await person.slots.actors.call.create({ name: "idle", package: seeded });
  const again = await shell.slots.installer.call.plan({ package: seeded });
  assert.ok(!JSON.stringify(again).includes(actorId));
  assert.ok(hub.state.actor(actorId));
});

test("a view's in-frame slots aren't the installer's: plan and install leave out ui.shell", async (t) => {
  const { shell, add } = await setup(t);
  // The assistant's chat view takes the shell (ui.shell@1), which its frame serves itself.
  const assistant = await add(join(packages, "assistant"));
  const plan = await shell.slots.installer.call.plan({ package: assistant });
  assert.ok(!plan.slots.some((s) => s.slot === "chat.shell"), JSON.stringify(plan.slots));
  assert.ok(
    plan.slots.some((s) => s.slot === "logic.model"),
    "its other slots are planned",
  );
  const { unbound } = await shell.slots.installer.call.install({
    package: assistant,
    name: "Helper",
    connections: {},
  });
  assert.ok(!unbound.includes("chat.shell"));
  assert.ok(unbound.includes("logic.model"));
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

test("only a manager exports the system: an agent holding the installer is refused", async (t) => {
  const { shell, assistant, bare } = await setup(t);
  for (const caller of [assistant, bare])
    await assert.rejects(
      caller.slots.installer.call.exportSystem({}),
      (e: Refused) => e.code === "forbidden" && /isn't a manager/.test(e.message),
    );
  // A manager, as the person is through its shell.
  const { composition } = await shell.slots.installer.call.exportSystem({});
  assert.equal(composition.format, "agentorg.system/1");
});

test("a system exported from one home is made again in another, by names, with what can't be listed", async (t) => {
  const a = await setup(t);
  const board = await a.add(join(packages, "..", "examples", "board"));
  const made = await a.shell.slots.installer.call.install({
    package: board,
    name: "Board",
    connections: { "logic.store": { actor: STORAGE, export: "kv" } },
    start: true,
  });
  a.placements.push({ id: "p1", actor: made.actorId, module: "panel", title: "Launch" });
  // An Actor the manager gave the Hub's management and storage.admin: a manager in this home.
  const powerful = await a.shell.slots.installer.call.install({
    package: a.installerHash,
    name: "deputy",
    connections: {
      "installer.bindings": { actor: HUB, export: "bindings" },
      "installer.storage": { actor: STORAGE, export: "admin" },
    },
  });
  assert.equal(a.hub.state.isManager(powerful.actorId), true);
  const { composition, unresolved } = await a.shell.slots.installer.call.exportSystem({});
  const boardRef = composition.actors.Board?.package ?? "";
  assert.match(boardRef, new RegExp(`^board@[^#]+#${board}$`));
  assert.deepEqual(composition.actors.Board, { package: boardRef, running: true });
  assert.deepEqual(
    composition.connections.filter((c) => c.consumer === "Board"),
    [{ consumer: "Board", slot: "logic.store", provider: STORAGE, export: "kv" }],
  );
  assert.deepEqual(composition.layout.home, [{ actor: "Board", module: "panel", title: "Launch" }]);
  // The test's own programs connect themselves, and this home's installer is its own: listed.
  assert.ok(unresolved.some((u) => u.what === "shell" && /external/.test(u.why)));
  assert.ok(unresolved.some((u) => u.what === "installer" && /its own/.test(u.why)));
  assert.equal(composition.actors.installer, undefined);
  assert.doesNotMatch(JSON.stringify({ composition, unresolved }), /act_/, "by names, never ids");

  // In another home, with the board's package added: the same Actor, connection and layout.
  const b = await setup(t);
  await b.add(join(packages, "..", "examples", "board"));
  // The export records the deputy's management connections faithfully.
  assert.deepEqual(
    composition.connections
      .filter((c) => c.consumer === "deputy")
      .map((c) => `${c.provider}.${c.export}`),
    ["hub.bindings", "storage.admin"],
  );
  // As exported, unchanged.
  const system = composition;
  const imported = await b.shell.slots.installer.call.importSystem({ composition: system });
  // Even for a manager, an import grants no management: the deputy is made, not made a manager,
  // and what it would need is listed for the person to grant.
  const deputy = imported.created.deputy as string;
  assert.ok(deputy);
  assert.equal(b.hub.state.isManager(deputy), false);
  assert.equal(b.hub.state.binding(deputy, "installer.storage"), undefined);
  assert.deepEqual(
    imported.ungranted.map((c) => `${c.consumer}.${c.slot} → ${c.provider}.${c.export}`),
    ["deputy.installer.bindings → hub.bindings", "deputy.installer.storage → storage.admin"],
  );
  const boardId = imported.created.Board as string;
  assert.equal(b.hub.state.actor(boardId).name, "Board");
  assert.equal(b.hub.state.actor(boardId).state, "running");
  assert.equal(b.hub.state.binding(boardId, "logic.store")?.provider, STORAGE);
  assert.deepEqual(
    b.placements.map((p) => [p.actor, p.module, p.title]),
    [[boardId, "panel", "Launch"]],
  );
  // Again: the name is taken, so the second is made under another, and says so.
  const again = await b.shell.slots.installer.call.importSystem({ composition: system });
  assert.equal(b.hub.state.actor(again.created.Board as string).name, "Board (2)");
  assert.ok(again.unresolved.some((u) => u.what === "Board" && /Board \(2\)/.test(u.why)));

  // What isn't here is listed, never guessed: a package not added, and an Actor needing sign-in.
  const chatgpt = await b.add(join(packages, "chatgpt"));
  const partial = await b.shell.slots.installer.call.importSystem({
    composition: {
      format: "agentorg.system/1",
      actors: {
        Missing: { package: `nope@1.0.0#sha256-${"0".repeat(64)}` },
        ChatGPT: { package: `chatgpt@0.0.1#${chatgpt}` },
      },
      connections: [{ consumer: "Missing", slot: "logic.store", provider: STORAGE, export: "kv" }],
      layout: { home: [{ actor: "Missing", module: "panel" }] },
    },
  });
  assert.deepEqual(Object.keys(partial.created), ["ChatGPT"]);
  const why = (what: string) => partial.unresolved.filter((u) => u.what === what).map((u) => u.why);
  assert.match(why("Missing").join(), /isn't here: add it/);
  assert.match(why("ChatGPT").join(), /sign-in/);
  assert.match(why("Missing.logic.store").join(), /isn't here/);
});

test("an import grants nothing its caller couldn't, and takes back all it made when it fails", async (t) => {
  const { hub, shell, assistant, seeded, as, track, add, placements } = await setup(t);
  const count = () => hub.state.actors().length;
  const before = count();
  const ref = `seeded@0.1.0#${seeded}`;
  // Connecting one new Actor to another's export takes a manager: the assistant isn't one.
  await assert.rejects(
    assistant.slots.installer.call.importSystem({
      composition: {
        format: "agentorg.system/1",
        actors: { One: { package: ref }, Two: { package: ref } },
        connections: [
          { consumer: "One", slot: "counter.store", provider: "Two", export: "counter.counter" },
        ],
        layout: { home: [] },
      },
    }),
    (e: Refused) =>
      e.code === "forbidden" && e.message.includes("One.counter.store → Two.counter.counter"),
  );
  assert.equal(count(), before, "nothing was created");
  // Storage's kv, which it holds itself, it may connect, and the seed lands (41, so 42 next).
  const done = await assistant.slots.installer.call.importSystem({
    composition: {
      format: "agentorg.system/1",
      actors: { Counter: { package: ref, running: true } },
      connections: [
        { consumer: "Counter", slot: "counter.store", provider: STORAGE, export: "kv" },
      ],
      layout: { home: [] },
    },
  });
  const counterId = done.created.Counter as string;
  await until(() => hub.connected(counterId));
  const user = track(
    await connect({
      ...as("user", [{ slot: "counter", provider: counterId, export: "counter.counter" }]),
      slots: { counter },
    }),
  );
  await until(() => user.slots.counter.bound);
  assert.deepEqual(await user.slots.counter.call.increment({}), { value: 42 });
  // The person's layout isn't the assistant's: the Actor is made, its placement isn't.
  const board = await add(join(packages, "..", "examples", "board"));
  const boardRef = `board@${hub.state.package(board).manifest.version}#${board}`;
  const placedBy = await assistant.slots.installer.call.importSystem({
    composition: {
      format: "agentorg.system/1",
      actors: { Board: { package: boardRef } },
      connections: [{ consumer: "Board", slot: "logic.store", provider: STORAGE, export: "kv" }],
      layout: { home: [{ actor: "Board", module: "panel" }] },
    },
  });
  assert.ok(placedBy.created.Board);
  assert.deepEqual(placements, []);
  assert.ok(placedBy.unresolved.some((u) => u.what === "Board.panel" && /can't place/.test(u.why)));
  // A failure after anything is made takes it all back, placements too.
  const actorsBefore = hub.state.actors().filter((a) => a.state !== "closed").length;
  await assert.rejects(
    shell.slots.installer.call.importSystem({
      composition: {
        format: "agentorg.system/1",
        actors: { Board: { package: boardRef } },
        connections: [],
        layout: {
          home: [
            { actor: "Board", module: "panel", title: "kept, then taken back" },
            { actor: "Board", module: "panel", title: "refused" },
          ],
        },
      },
    }),
    (e: Refused) => e.code === "invalid",
  );
  assert.deepEqual(placements, []);
  assert.equal(hub.state.actors().filter((a) => a.state !== "closed").length, actorsBefore);
  // A composition can't name an Actor after a built-in.
  await assert.rejects(
    shell.slots.installer.call.importSystem({
      composition: {
        format: "agentorg.system/1",
        actors: { storage: { package: ref } },
        connections: [],
        layout: { home: [] },
      },
    }),
    (e: Refused) => e.code === "invalid",
  );
  assert.equal(hub.state.binding(counterId, "counter.store")?.export, "kv");
});

test("install exposes what it lists: a manager's now, an agent's to itself as its own request, nothing else", async (t) => {
  const { hub, shell, assistant, bare, seeded } = await setup(t);
  const count = () => hub.state.actors().filter((a) => a.state !== "closed").length;
  const expose = [{ export: "counter.counter", to: assistant.self.actorId }];

  // plan says how each would settle for its caller.
  assert.deepEqual((await shell.slots.installer.call.plan({ package: seeded, expose })).exposes, [
    { ...expose[0], settles: "granted" },
  ]);
  assert.deepEqual(
    (await assistant.slots.installer.call.plan({ package: seeded, expose })).exposes,
    [{ ...expose[0], settles: "request" }],
  );

  // A manager's is made at once, on the Actor it names.
  const granted = await shell.slots.installer.call.install({
    package: seeded,
    name: "Quest Counter",
    connections: {},
    expose,
  });
  assert.deepEqual(granted.exposures, [
    { ...expose[0], settles: "granted", slot: "questCounter_counter" },
  ]);
  assert.equal(hub.state.binding(assistant.self.actorId, "questCounter_counter")?.exposed, true);
  assert.equal(hub.state.actor(granted.actorId).installedFor, shell.self.actorId);

  // An agent's to itself is left for it to file: the exact call, which is its own request.
  const left = await assistant.slots.installer.call.install({
    package: seeded,
    name: "Mine",
    connections: {},
    expose,
  });
  const call = { provider: left.actorId, export: "counter.counter", to: assistant.self.actorId };
  assert.deepEqual(left.exposures, [{ ...expose[0], settles: "request", call }]);
  assert.equal(hub.state.actor(left.actorId).installedFor, assistant.self.actorId);
  assert.deepEqual(
    hub.state.bindings(assistant.self.actorId).filter((b) => b.provider === left.actorId),
    [],
  );
  const filed = hub.state.expose(assistant.self.actorId, call);
  assert.equal(filed.exposed, false);
  assert.deepEqual(
    hub.state.mine(assistant.self.actorId).map((r) => [r.exposed, r.provider, r.status]),
    [[true, left.actorId, "open"]],
  );

  // Exposing to another Actor takes a manager: refused whole, naming who, and nothing is made.
  const before = count();
  await assert.rejects(
    assistant.slots.installer.call.install({
      package: seeded,
      name: "Theirs",
      connections: {},
      expose: [{ export: "counter.counter", to: bare.self.actorId }],
    }),
    (e: Refused) =>
      e.code === "forbidden" &&
      e.message.includes(`assistant (${assistant.self.actorId})`) &&
      e.message.includes(`bare (${bare.self.actorId})`) &&
      /nothing was created/.test(e.message),
  );
  await assert.rejects(
    assistant.slots.installer.call.plan({
      package: seeded,
      expose: [{ export: "counter.counter", to: bare.self.actorId }],
    }),
    (e: Refused) => e.code === "forbidden",
  );
  // An export the package doesn't have, or an Actor that isn't there.
  await assert.rejects(
    shell.slots.installer.call.install({
      package: seeded,
      name: "Wrong",
      connections: {},
      expose: [{ export: "counter.store", to: assistant.self.actorId }],
    }),
    (e: Refused) => e.code === "invalid" && e.message.includes("counter.counter"),
  );
  await assert.rejects(
    shell.slots.installer.call.install({
      package: seeded,
      name: "Nobody",
      connections: {},
      expose: [{ export: "counter.counter", to: "act_nobody" }],
    }),
    (e: Refused) => e.code === "unknown",
  );
  assert.equal(count(), before);
});

test("only a host module's rpc exports are exposed, never to the Hub's own Actors", async (t) => {
  const { hub, shell, assistant, seeded, add } = await setup(t);
  const count = () => hub.state.actors().filter((a) => a.state !== "closed").length;
  const before = count();
  // A manager's plan refuses a built-in target as install would, before anything is made.
  for (const to of [HUB, STORAGE, "net"]) {
    const expose = [{ export: "counter.counter", to }];
    await assert.rejects(
      shell.slots.installer.call.plan({ package: seeded, expose }),
      (e: Refused) =>
        e.code === "forbidden" && /takes no slots; nothing was planned/.test(e.message),
    );
    await assert.rejects(
      shell.slots.installer.call.install({ package: seeded, name: "x", connections: {}, expose }),
      (e: Refused) => e.code === "forbidden" && /nothing was created/.test(e.message),
    );
  }
  // A view's export (the assistant's chat view) runs in its frame: it isn't one to expose.
  const helper = await add(join(packages, "assistant"));
  await assert.rejects(
    shell.slots.installer.call.install({
      package: helper,
      name: "Helper",
      connections: {},
      expose: [{ export: "chat.view", to: assistant.self.actorId }],
    }),
    (e: Refused) => e.code === "invalid" && e.message.includes("logic.chat"),
  );
  assert.equal(count(), before);
});
