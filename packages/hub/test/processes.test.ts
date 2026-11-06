import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubActors, hubAudit } from "@agentorg/interfaces";
import type { Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { Hub, type HubOptions, listen, PERSON, STORAGE } from "../src/index.ts";
import { isolation } from "./fixtures/isolation/src/main.ts";
import { probe } from "./fixtures/probe/src/main.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixtures = join(root, "packages", "hub", "test", "fixtures");
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(10);
  }
};
/** A sandbox that passes the probe and runs nothing else: a process that never says hello. */
const SILENT = ["/bin/sh", "-c", 'case "$2" in -e) exit 0;; esac; exec sleep 30', "sandbox"];
/** A sandbox that can't run at all. */
const BROKEN = ["/bin/sh", "-c", "echo 'no namespaces here' >&2; exit 1", "sandbox"];

/** A Hub in a fresh home, serving on loopback, with the person connected to manage Actors. */
async function setup(t: test.TestContext, options: HubOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-processes-")));
  const home = join(dir, "home");
  let hub = Hub.open(home, options);
  let server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const asPerson = async () => {
    const person = await connect({
      hubUrl: server.url,
      actorId: PERSON,
      credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
      slots: { actors: hubActors, audit: hubAudit },
      declare: false,
    });
    open.push(person);
    return person;
  };
  let person = await asPerson();
  const add = async (name: string) => {
    const built = await buildPackage(join(fixtures, name), { out: join(dir, "out") });
    hub.state.addPackage(PERSON, built.file);
    return built.hash;
  };
  /** An external Actor whose slot is bound to the export: how to connect as it. */
  const caller = (slot: string, provider: string, exported: string) => {
    const made = hub.state.createActor(PERSON, {
      name: "caller",
      bindings: [{ slot, provider, export: exported }],
    });
    return { hubUrl: server.url, actorId: made.actorId, credential: made.credential as string };
  };
  /** Close the Hub, as a shutdown would, and open it again in the same home. */
  const reopen = async () => {
    for (const client of open.splice(0)) client.close();
    await server.close();
    hub.close();
    hub = Hub.open(home, options);
    server = await listen(hub);
    person = await asPerson();
    return { hub, person };
  };
  return { hub, home, person, add, caller, reopen, dir };
}

test("start runs the board's process, stop ends it, and its state outlives both", async (t) => {
  const { hub, add, person } = await setup(t);
  const hash = await add("../../../../examples/board");
  const { actorId } = await person.slots.actors.call.create({
    name: "board",
    package: hash,
    bindings: [{ slot: "logic.store", provider: STORAGE, export: "kv" }],
  });
  await person.slots.actors.call.start({ actorId });
  await until(() => hub.connected(actorId));
  const got = await person.slots.actors.call.get({ actorId });
  assert.deepEqual(got.host, { available: true });
  await hub.viewCall(actorId, "panel", "board", "add", { title: "spawned" });

  await person.slots.actors.call.stop({ actorId });
  assert.equal(hub.connected(actorId), false, "stop returns once the process is gone");
  const stopped = await person.slots.actors.call.get({ actorId });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.restarts, 0, "a stop isn't a crash");
  assert.ok(stopped.lastExit, "the exit is recorded");

  await person.slots.actors.call.start({ actorId });
  await until(() => hub.connected(actorId));
  const listed = (await hub.viewCall(actorId, "panel", "board", "list", {})) as {
    cards: { title: string }[];
  };
  assert.deepEqual(
    listed.cards.map((card) => card.title),
    ["spawned"],
  );
});

test("a crash restarts the process after a doubling backoff; stop during the backoff cancels it", async (t) => {
  const { hub, add, person, caller } = await setup(t, {
    processes: { backoffMs: 200, maxBackoffMs: 800 },
  });
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  const client = await connect({ ...caller("probe", actorId, "main.probe"), slots: { probe } });
  t.after(() => client.close());
  await until(() => hub.connected(actorId));

  /** From the crash's recorded exit to the restarted process's admission: never less than the backoff. */
  const crashAt = async () => {
    await client.slots.probe.call.crash({});
    await until(() => !hub.connected(actorId));
    await until(() => hub.connected(actorId));
    const back = Date.now();
    const { lastExit } = await person.slots.actors.call.get({ actorId });
    return back - Date.parse(lastExit?.at ?? "");
  };
  const first = await crashAt();
  const second = await crashAt();
  assert.ok(first >= 190, `the first restart waited ${first} ms (backoff 200)`);
  assert.ok(second >= 390, `the second restart waited ${second} ms (backoff 400)`);
  const got = await person.slots.actors.call.get({ actorId });
  assert.equal(got.state, "running");
  assert.equal(got.restarts, 2);
  assert.notEqual(got.lastExit?.code, 0);

  // Crashed a third time, its restart waits 800 ms; stopping now means it never comes.
  await client.slots.probe.call.crash({});
  await until(() => !hub.connected(actorId));
  await person.slots.actors.call.stop({ actorId });
  await later(1200);
  assert.equal(hub.connected(actorId), false);
  assert.equal((await person.slots.actors.call.get({ actorId })).state, "stopped");
});

test("a process that never says hello is killed at the deadline, which counts as a crash", async (t) => {
  const { add, person } = await setup(t, {
    processes: { sandbox: SILENT, helloMs: 300, backoffMs: 60_000 },
  });
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  let got = await person.slots.actors.call.get({ actorId });
  for (let waited = 0; !got.lastExit && waited < 5000; waited += 50) {
    await later(50);
    got = await person.slots.actors.call.get({ actorId });
  }
  assert.equal(got.lastExit?.signal, "SIGKILL");
  assert.equal(got.restarts, 1);
  await person.slots.actors.call.stop({ actorId });
});

test("where the sandbox can't run, start is refused and every package Actor says why", async (t) => {
  const { add, person } = await setup(t, { processes: { sandbox: BROKEN } });
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await assert.rejects(
    person.slots.actors.call.start({ actorId }),
    (error: Refused) => error.code === "unsupported" && /can't start/.test(error.message),
  );
  const got = await person.slots.actors.call.get({ actorId });
  assert.equal(got.state, "created");
  assert.equal(got.host?.available, false);
  assert.match(got.host?.reason ?? "", /no namespaces here/);
  const { entries } = await person.slots.audit.call.list({});
  assert.equal(
    entries.filter((entry) => entry.kind === "host.status").length,
    1,
    "the status is audited once, when it changes",
  );
});

test("Actors running when the Hub stopped get their processes back when it opens again", async (t) => {
  const { hub, add, person, reopen } = await setup(t);
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  await until(() => hub.connected(actorId));
  const again = await reopen();
  await until(() => again.hub.connected(actorId));
  assert.equal((await again.person.slots.actors.call.get({ actorId })).restarts, 0);
});

test("a process's ctx.log and plain output are its Actor's log lines", async (t) => {
  const { hub, add, person } = await setup(t);
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  await until(() => hub.connected(actorId));
  let lines: { level: string; message: string; module?: string; data?: unknown }[] = [];
  for (let waited = 0; lines.length < 3 && waited < 5000; waited += 50) {
    await later(50);
    ({ lines } = await person.slots.actors.call.logs({ actorId, limit: 10 }));
  }
  const brief = lines.map(({ level, message, module, data }) => ({ level, message, module, data }));
  assert.deepEqual(
    brief.find((line) => line.message === "starting"),
    { level: "info", message: "starting", module: "main", data: { step: 1 } },
  );
  assert.deepEqual(
    brief.find((line) => line.message === "plain stdout"),
    { level: "info", message: "plain stdout", module: undefined, data: undefined },
  );
  assert.deepEqual(
    brief.find((line) => line.message === "plain stderr"),
    { level: "error", message: "plain stderr", module: undefined, data: undefined },
  );
});

test("a host process holds no capability: files, processes, network, DNS, signals, environment, memory", async (t) => {
  const { hub, home, dir, add, person, caller } = await setup(t, {
    processes: { memoryMb: 64, backoffMs: 60_000 },
  });
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  // A Unix socket the Hub's user owns, as a session bus or a docker socket would be.
  const socket = join(dir, "s.sock");
  const unix = createServer((connection) => connection.end("reached"));
  await new Promise<void>((resolve) => unix.listen(socket, resolve));
  t.after(() => unix.close());
  const hash = await add("isolation");
  const { actorId } = await person.slots.actors.call.create({ name: "isolation", package: hash });
  await person.slots.actors.call.start({ actorId });
  const client = await connect({
    ...caller("isolation", actorId, "main.isolation"),
    slots: { isolation },
  });
  t.after(() => client.close());
  await until(() => hub.connected(actorId));

  const rows = await client.slots.isolation.call.tryAll({
    hubPid: process.pid,
    port,
    socket,
    home,
  });
  assert.equal(rows.own, "allowed", "its own package is readable");
  // On Linux the socket isn't there at all (ENOENT: no host path is in the root); on macOS the
  // sandbox refuses it (EPERM).
  for (const row of [
    "read",
    "write",
    "child",
    "worker",
    "fetch",
    "tcp",
    "dns",
    "signal",
    "unix",
    "home",
    "environ",
  ])
    assert.match(
      String(rows[row as keyof typeof rows]),
      /^blocked: (?!TIMEOUT)/,
      `${row}: ${rows[row as keyof typeof rows]}`,
    );
  assert.equal(rows.env, "", "an empty environment");

  // Past its heap limit, the process dies, as a crash.
  await client.slots.isolation.call.allocate({}).catch(() => {});
  await until(() => !hub.connected(actorId));
  let got = await person.slots.actors.call.get({ actorId });
  for (let waited = 0; !got.lastExit && waited < 5000; waited += 50) {
    await later(50);
    got = await person.slots.actors.call.get({ actorId });
  }
  assert.ok(got.lastExit && (got.lastExit.code !== 0 || got.lastExit.signal), "it died");
  await person.slots.actors.call.stop({ actorId });
});

/**
 * A sandbox whose process ignores SIGTERM (so a stop waits out its grace) and counts each launch
 * in a file; the probe passes.
 */
const slowToStop = (launches: string) => [
  "/bin/sh",
  "-c",
  // The trap first: a stop sent as soon as the launch is seen must find SIGTERM ignored already.
  'case "$2" in -e) exit 0;; esac; trap "" TERM; echo launch >> "$0"; exec sleep 30',
  launches,
];
const launched = (launches: string) => {
  try {
    return readFileSync(launches, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

test("a start while the process is still stopping waits for it, then runs a new one", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-launches-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launches = join(dir, "launches");
  const { add, person } = await setup(t, {
    processes: { sandbox: slowToStop(launches), stopMs: 600, helloMs: 60_000 },
  });
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  await until(() => launched(launches) === 1);
  const stopping = person.slots.actors.call.stop({ actorId });
  await later(100); // stop has begun: its process ignores SIGTERM, so it lasts its grace
  await person.slots.actors.call.start({ actorId });
  assert.equal(launched(launches), 1, "nothing new while the old process is still there");
  await stopping;
  await until(() => launched(launches) === 2);
  assert.equal((await person.slots.actors.call.get({ actorId })).state, "running");
  await person.slots.actors.call.stop({ actorId });
});

test("closing an Actor whose start waits on a stop runs nothing more", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-launches-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launches = join(dir, "launches");
  const { add, person } = await setup(t, {
    processes: { sandbox: slowToStop(launches), stopMs: 600, helloMs: 60_000 },
  });
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  await until(() => launched(launches) === 1);
  const stopping = person.slots.actors.call.stop({ actorId });
  await later(100);
  await person.slots.actors.call.start({ actorId });
  await person.slots.actors.call.close({ actorId });
  await stopping;
  await later(300);
  assert.equal(launched(launches), 1, "the waiting start didn't run");
  assert.equal((await person.slots.actors.call.get({ actorId })).state, "closed");
});

test("a process that floods its output keeps a budget of lines, and says what it dropped", async (t) => {
  const { hub, add, person, caller } = await setup(t);
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await person.slots.actors.call.start({ actorId });
  const client = await connect({ ...caller("probe", actorId, "main.probe"), slots: { probe } });
  t.after(() => client.close());
  await until(() => hub.connected(actorId));
  await client.slots.probe.call.flood({ lines: 1000 });
  let lines: { message: string }[] = [];
  for (let waited = 0; waited < 5000; waited += 50) {
    ({ lines } = await person.slots.actors.call.logs({ actorId, limit: 1000 }));
    if (lines.some((line) => line.message.includes("dropped"))) break;
    await later(50);
  }
  const flooded = lines.filter((line) => line.message.startsWith("flood "));
  // Its earlier lines (start's own) count toward the same budget.
  assert.ok(flooded.length <= 500 && flooded.length > 490, `${flooded.length} flood lines kept`);
  assert.equal(flooded.at(-1)?.message, `flood ${flooded.length - 1}`, "the first ones are kept");
  assert.ok(lines.some((line) => /more than 500 lines/.test(line.message)));
});

// Run by CI on Ubuntu with kernel.apparmor_restrict_unprivileged_userns=1, the stock setting.
test("on stock Ubuntu, the real sandbox can't start, and the reason names the setting", {
  skip: process.env.AGENTORG_EXPECT_NO_USERNS !== "1",
}, async (t) => {
  const { add, person } = await setup(t);
  const hash = await add("probe");
  const { actorId } = await person.slots.actors.call.create({ name: "probe", package: hash });
  await assert.rejects(
    person.slots.actors.call.start({ actorId }),
    (error: Refused) =>
      error.code === "unsupported" &&
      error.message.includes("kernel.apparmor_restrict_unprivileged_userns"),
  );
});
