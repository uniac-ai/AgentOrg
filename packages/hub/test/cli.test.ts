import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defineInterface, method } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect, openChannel } from "@agentorg/sdk/client";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const cli = join(root, "packages", "sdk", "dist", "src", "cli.js");
const notes = defineInterface({
  name: "notes",
  major: 1,
  kind: "rpc",
  methods: {
    write: method({ input: z.object({ text: z.string() }), output: z.object({ n: z.number() }) }),
  },
});
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the CLI to its end: its exit code, stdout and stderr. */
const run = (...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], (error, out, err) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, out, err }),
    );
  });

/** `agentorg hub` in a fresh home, until its url file shows it listening; stopped with the test. */
async function startHub(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-cli-"));
  const home = join(dir, "home");
  const hub: ChildProcess = spawn(process.execPath, [cli, "hub", "--home", home], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  hub.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  t.after(async () => {
    // Still running: neither exited nor killed by a signal (a SIGKILL leaves exitCode null).
    if (hub.exitCode === null && hub.signalCode === null) {
      hub.kill("SIGTERM");
      await new Promise((resolve) => hub.once("exit", resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (let waited = 0; !existsSync(join(home, "url")); waited += 20) {
    if (waited > 10_000 || hub.exitCode !== null)
      throw new Error(`the Hub didn't start: ${stderr}`);
    await later(20);
  }
  const url = readFileSync(join(home, "url"), "utf8").trim();
  const credential = readFileSync(join(home, "person-credential"), "utf8").trim();
  return { home, hub, url, credential };
}

test("the person's commands map one to one onto the hub's methods", async (t) => {
  const { home, url } = await startHub(t);
  const actors = await run("actors", "--home", home);
  assert.equal(actors.code, 0, actors.err);
  assert.deepEqual(
    (JSON.parse(actors.out) as { actors: { actorId: string }[] }).actors.map((a) => a.actorId),
    ["hub", "person"],
  );

  const out = mkdtempSync(join(tmpdir(), "board-for-cli-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(join(root, "examples", "board"), { out });
  const added = await run("add", built.file, "--home", home);
  assert.equal(added.code, 0, added.err);
  assert.equal((JSON.parse(added.out) as { hash: string }).hash, built.hash);

  // Two external Actors made by `call`, connected with a slot and an export, then bound by `bind`.
  const make = async (name: string) => {
    const made = await run("call", "actors", "create", JSON.stringify({ name }), "--home", home);
    assert.equal(made.code, 0, made.err);
    return JSON.parse(made.out) as { actorId: string; credential: string };
  };
  const p = await make("provider");
  const c = await make("consumer");
  const provider = await connect({
    hubUrl: url,
    ...p,
    exports: { notes },
    start: (ctx) => ctx.exports.notes.implement({ write: async () => ({ n: 1 }) }),
  });
  const consumer = await connect({ hubUrl: url, ...c, slots: { notes } });
  t.after(() => {
    provider.close();
    consumer.close();
  });
  const bound = await run("bind", `${c.actorId}.notes`, `${p.actorId}.notes`, "--home", home);
  assert.equal(bound.code, 0, bound.err);
  assert.deepEqual(JSON.parse(bound.out), { bound: true });
  for (const list of ["bindings", "exports", "audit"]) {
    const listed = await run(list, "--home", home);
    assert.equal(listed.code, 0, `${list}: ${listed.err}`);
    assert.ok(JSON.parse(listed.out), list);
  }
  const audit = JSON.parse((await run("audit", "--home", home)).out) as {
    entries: { kind: string }[];
  };
  assert.ok(audit.entries.some((e) => e.kind === "bind"));
});

test("refusals exit 1 with the reason, and usage mistakes exit 2", async (t) => {
  const { home } = await startHub(t);
  const refused = await run("bind", "person.nope", "hub.grants", "--home", home);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^Refused \(unknown\): /);
  assert.equal((await run("call", "nope", "list", "{}", "--home", home)).code, 1);

  for (const args of [
    [],
    ["frob"],
    ["bind", "person"],
    ["call", "actors"],
    ["call", "actors", "list", "{"],
    ["add"],
  ]) {
    const result = await run(...args, "--home", home);
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.err}`);
    assert.match(result.err, /Usage: agentorg/);
  }
  const elsewhere = mkdtempSync(join(tmpdir(), "agentorg-nohub-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const nowhere = await run("actors", "--home", elsewhere);
  assert.equal(nowhere.code, 1);
  assert.match(nowhere.err, /Is a Hub running there/);
});

test("the CLI never takes over a channel the person already has, and says so", async (t) => {
  const { home, url, credential, hub } = await startHub(t);
  const held = await openChannel({ hubUrl: url, actorId: "person", credential });
  const blocked = await run("actors", "--home", home);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /Something else holds the person's channel/);
  // The holder kept its channel.
  assert.ok(await held.call("actors", "list", {}));
  held.close();
  await held.closed;
  // Once the Hub has seen it go (a moment later), the CLI gets the channel.
  let after = await run("actors", "--home", home);
  for (let tries = 0; after.code !== 0 && tries < 20; tries++)
    after = await run("actors", "--home", home);
  assert.equal(after.code, 0, after.err);

  // A stopped Hub takes its address with it.
  hub.kill("SIGTERM");
  await new Promise((resolve) => hub.once("exit", resolve));
  assert.equal(hub.exitCode, 0);
  assert.equal(existsSync(join(home, "url")), false);
  const stopped = await run("actors", "--home", home);
  assert.equal(stopped.code, 1);
});

test("one Hub per home; commands run at once all succeed; a stale address is NotConnected", async (t) => {
  const { home, hub } = await startHub(t);
  const second = await run("hub", "--home", home);
  assert.equal(second.code, 1);
  assert.match(second.err, /Another Hub has .* open \(process \d+\)/);
  assert.ok(existsSync(join(home, "url")), "the running Hub's address stays");

  const together = await Promise.all(
    Array.from({ length: 4 }, () => run("actors", "--home", home)),
  );
  assert.deepEqual(
    together.map((r) => r.code),
    [0, 0, 0, 0],
    together.map((r) => r.err).join(""),
  );

  // Killed outright, the Hub leaves its address and lock behind: commands say NotConnected, and
  // the next Hub takes the home over.
  hub.kill("SIGKILL");
  await new Promise((resolve) => hub.once("exit", resolve));
  const stale = await run("actors", "--home", home);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /^NotConnected: /);
  const next = spawn(process.execPath, [cli, "hub", "--home", home], { stdio: "ignore" });
  t.after(async () => {
    if (next.exitCode !== null || next.signalCode !== null) return;
    next.kill("SIGTERM");
    await new Promise((resolve) => next.once("exit", resolve));
  });
  let again = await run("actors", "--home", home);
  for (let tries = 0; again.code !== 0 && tries < 50; tries++) {
    await later(50);
    again = await run("actors", "--home", home);
  }
  assert.equal(again.code, 0, again.err);
  assert.equal((await run("--help")).code, 0);
  assert.equal((await run("hub", "--port", "", "--home", home)).code, 2);
});
