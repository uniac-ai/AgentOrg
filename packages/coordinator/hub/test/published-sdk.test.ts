import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hubActors, hubGrants, kv } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import { Hub, listen, PERSON } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 3000) => {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > ms) throw new Error("timed out waiting");
    await later(5);
  }
};

/**
 * The package scripts/sdk/pack.mjs packs, installed alone in an empty folder: unpacked into its
 * node_modules beside a link to the workspace's zod. Returns the folder.
 */
function installPacked(dir: string) {
  const out = execFileSync(process.execPath, [join(root, "scripts", "sdk", "pack.mjs"), dir], {
    encoding: "utf8",
  });
  const tarball = out.trim().split("\n").at(-1) ?? "";
  const consumer = join(dir, "consumer");
  const installed = join(consumer, "node_modules", "@agentorg", "sdk");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
  symlinkSync(join(root, "node_modules", "zod"), join(consumer, "node_modules", "zod"), "dir");
  return consumer;
}

test("a provider made only from the packed @agentorg/sdk joins a Hub and answers a call", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-published-sdk-")));
  const home = join(dir, "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const open: { close(): void }[] = [];
  t.after(async () => {
    for (const client of open) client.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The provider's code and its contract come from the installed package, found from its folder.
  const consumer = installPacked(dir);
  const from = createRequire(join(consumer, "provider.js"));
  const installed = async (specifier: string) => {
    const file = from.resolve(specifier);
    assert.ok(file.startsWith(`${consumer}/`), `${specifier} is ${file}`);
    return import(pathToFileURL(file).href);
  };
  const packed = {
    client: (await installed("@agentorg/sdk/client")) as typeof import("@agentorg/sdk/client"),
    interfaces: (await installed(
      "@agentorg/sdk/interfaces",
    )) as typeof import("@agentorg/interfaces"),
  };
  assert.notEqual(packed.client.connect, connect, "the provider's client is the packed one");

  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants },
    declare: false,
  });
  open.push(person);
  const make = async (name: string) => {
    const made = await person.slots.actors.call.create({ name });
    assert.ok(made.credential);
    return { actorId: made.actorId, credential: made.credential };
  };
  const p = await make("provider");
  const c = await make("consumer");

  const provider = await packed.client.connect({
    hubUrl: server.url,
    ...p,
    exports: { kv: packed.interfaces.kv },
    start: (ctx) =>
      ctx.exports.kv.implement({
        get: async ({ key }) => ({ value: `the value of ${key}` }),
        set: async () => ({}),
        delete: async () => ({ deleted: false }),
        list: async () => ({ keys: [], next: null }),
      }),
  });
  open.push(provider);
  // The workspace's kv@1 on the consumer's side: the Hub binds it to the packed one only if the
  // two are the same contract.
  const consumerClient = await connect({ hubUrl: server.url, ...c, slots: { kv } });
  open.push(consumerClient);

  assert.deepEqual(
    await person.slots.grants.call.bind({
      consumer: c.actorId,
      slot: "kv",
      provider: p.actorId,
      export: "kv",
    }),
    { bound: true },
  );
  await until(() => consumerClient.slots.kv.bound);
  assert.deepEqual(await consumerClient.slots.kv.call.get({ key: "greeting" }), {
    value: "the value of greeting",
  });
});
