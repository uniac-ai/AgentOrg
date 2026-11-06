import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex as NodeDuplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Duplex } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { Hub, listen, PERSON, STORAGE } from "../src/index.ts";
import { probe } from "./fixtures/probe/src/main.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixtures = join(root, "packages", "hub", "test", "fixtures");
const runner = fileURLToPath(import.meta.resolve("@agentorg/sdk/host/runner.js"));
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 10_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(10);
  }
};

/** A Hub with a package added, and a way to run an Actor's host process over an fd-3 pipe. */
async function setup(t: test.TestContext, packageDir: string) {
  // The real path: --allow-fs-read matches resolved paths, and macOS's tmpdir is behind a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-runner-")));
  const home = join(dir, "home");
  const hub = Hub.open(home);
  const out = join(dir, "out");
  const built = await buildPackage(packageDir, { out });
  hub.state.addPackage(PERSON, built.file);
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Spawn the runner for an Actor, as the Hub's spawner will (without the sandbox). */
  const run = (actorId: string, options: { permission?: boolean } = {}) => {
    const packageDir = join(home, "packages", built.hash);
    // The two paths the spawner will allow, and nothing else.
    const permission = options.permission
      ? ["--permission", `--allow-fs-read=${runner}`, `--allow-fs-read=${packageDir}/`]
      : [];
    const child = spawn(process.execPath, [...permission, runner, packageDir, actorId], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: {},
    });
    children.push(child);
    const lines: string[] = [];
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
    const pipe = child.stdio[3] as NodeDuplex;
    hub.accept(NodeDuplex.toWeb(pipe) as unknown as Duplex, { actorId });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    return { child, lines, exited };
  };
  return { hub, home, built, run };
}

test("the board runs in its own process: a view's calls reach its logic, and state outlives a restart", async (t) => {
  const { hub, built, run } = await setup(t, join(root, "examples", "board"));
  const { actorId } = hub.state.createActor(PERSON, {
    name: "board",
    package: built.hash,
    bindings: [{ slot: "logic.store", provider: STORAGE, export: "kv" }],
  });
  hub.state.start(PERSON, actorId);
  // Under Node's permission model, reading only the runner and the package's folder is enough.
  const first = run(actorId, { permission: true });
  await until(() => hub.connected(actorId));
  const card = (await hub.viewCall(actorId, "panel", "board", "add", {
    title: "write the runner",
  })) as {
    title: string;
  };
  assert.equal(card.title, "write the runner");

  first.child.kill("SIGKILL");
  await first.exited;
  await until(() => !hub.connected(actorId));
  const second = run(actorId);
  await until(() => hub.connected(actorId));
  const listed = (await hub.viewCall(actorId, "panel", "board", "list", {})) as {
    cards: { title: string }[];
  };
  assert.deepEqual(
    listed.cards.map((c) => c.title),
    ["write the runner"],
  );
  second.child.kill("SIGTERM");
});

test("start runs before hello, logs come out as lines, and a crash ends the process", async (t) => {
  const { hub, built, run } = await setup(t, join(fixtures, "probe"));
  const server = await listen(hub);
  t.after(() => server.close());
  const { actorId } = hub.state.createActor(PERSON, { name: "probe", package: built.hash });
  hub.state.start(PERSON, actorId);
  const made = hub.state.createActor(PERSON, {
    name: "caller",
    bindings: [{ slot: "probe", provider: actorId, export: "main.probe" }],
  });
  const caller = await connect({
    hubUrl: server.url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { probe },
  });
  t.after(() => caller.close());
  const running = run(actorId, { permission: true });
  // Called the moment the Actor is admitted: its 30 ms start is already done.
  await until(() => hub.connected(actorId));
  assert.deepEqual(await caller.slots.probe.call.ping({}), { ready: true });
  const entry = running.lines
    .map((line) => {
      try {
        return JSON.parse(line) as { message?: string; module?: string; data?: unknown };
      } catch {
        return undefined;
      }
    })
    .find((parsed) => parsed?.message === "starting");
  assert.deepEqual([entry?.module, entry?.data], ["main", { step: 1 }]);
  assert.ok(running.lines.includes("plain stdout") && running.lines.includes("plain stderr"));

  // An error the module's own SDK made keeps its code, and one the runner made is still its class.
  await assert.rejects(caller.slots.probe.call.refuse({}), { name: "Refused", code: "not_found" });
  assert.deepEqual(await caller.slots.probe.call.unbound({}), { notConnected: true });
  // Logging what JSON can't hold neither throws nor drops the line.
  assert.deepEqual(await caller.slots.probe.call.oddLog({}), {});
  await until(() => running.lines.some((line) => line.includes('"cycle"')));
  assert.ok(running.lines.some((line) => line.includes('"message":"[unprintable]"')));
  const odd = running.lines.find((line) => line.includes('"odd"'));
  assert.deepEqual(JSON.parse(odd ?? "{}").data, { n: "1", error: "Error: e" });

  await caller.slots.probe.call.crash({});
  assert.notEqual(await running.exited, 0, "an uncaught exception ends the process");
  await until(() => !hub.connected(actorId));
});

test("a start that throws ends the process before its hello", async (t) => {
  const { hub, built, run } = await setup(t, join(fixtures, "crasher"));
  const { actorId } = hub.state.createActor(PERSON, { name: "crasher", package: built.hash });
  hub.state.start(PERSON, actorId);
  const running = run(actorId, { permission: true });
  assert.notEqual(await running.exited, 0);
  assert.ok(running.lines.some((line) => line.includes("bad start")));
  assert.equal(hub.connected(actorId), false);
});
