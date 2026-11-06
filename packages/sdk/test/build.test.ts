import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage, readTar, verifyPackage, writeTar } from "../src/build.ts";

// Fixture packages live inside the repo, so they resolve @agentorg/sdk and zod from its workspace.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".test-fixtures");

const iface = (min = 1) => `import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
export const notes = defineInterface({
  name: "notes", major: 1, kind: "rpc",
  methods: { write: method({ input: z.object({ text: z.string().min(${min}) }), output: z.object({}) }) },
});
`;
const host = `import { defineActor } from "@agentorg/sdk";
import { notes } from "./notes.ts";
export default defineActor({ exports: { notes }, start(ctx) { ctx.exports.notes.implement({ write: () => ({}) }); } });
`;

async function fixture(
  t: test.TestContext,
  files: Record<string, string>,
  agentorg: Record<string, unknown>,
) {
  await mkdir(fixtures, { recursive: true });
  const dir = await mkdtemp(join(fixtures, "pkg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", agentorg }),
  );
  await mkdir(join(dir, "src"));
  for (const [path, text] of Object.entries(files)) await writeFile(join(dir, "src", path), text);
  const build = () => buildPackage(dir, { out: join(dir, "out") });
  const edit = (path: string, text: string) => writeFile(join(dir, "src", path), text);
  return { dir, build, edit };
}

test("rebuilding gives the same hashes, and a schema change changes the interface and package hashes", async (t) => {
  const f = await fixture(
    t,
    { "notes.ts": iface(), "logic.ts": host },
    { modules: { logic: "src/logic.ts" } },
  );
  const first = await f.build();
  const again = await f.build();
  assert.equal(again.hash, first.hash);
  assert.match(first.file, /sha256-[0-9a-f]{64}\.agentorg$/);
  assert.deepEqual((await verifyPackage(first.file)).problems, []);
  await f.edit("notes.ts", iface(2));
  const changed = await f.build();
  assert.notEqual(
    changed.manifest.interfaces["notes@1"]?.hash,
    first.manifest.interfaces["notes@1"]?.hash,
  );
  assert.notEqual(changed.hash, first.hash);
});

test("a tampered file or an edited interface hash is detected", async (t) => {
  const f = await fixture(
    t,
    { "notes.ts": iface(), "logic.ts": host },
    { modules: { logic: "src/logic.ts" } },
  );
  const built = await f.build();
  const files = readTar(new Uint8Array(await readFile(built.file)));
  const tampered = new Map(files);
  const code = tampered.get("dist/logic.js") as Uint8Array;
  tampered.set("dist/logic.js", new Uint8Array([...code, 0x20]));
  const tamperedFile = join(f.dir, "tampered.agentorg");
  await writeFile(tamperedFile, writeTar(tampered));
  assert.match((await verifyPackage(tamperedFile, built.hash)).problems.join(), /hashes to/);

  const manifest = JSON.parse(new TextDecoder().decode(files.get("agentorg.json")));
  manifest.interfaces["notes@1"].methods.write.input.properties.text.minLength = 0;
  const edited = new Map(files);
  edited.set("agentorg.json", new TextEncoder().encode(JSON.stringify(manifest)));
  const editedFile = join(f.dir, "edited.agentorg");
  await writeFile(editedFile, writeTar(edited));
  const problems = (await verifyPackage(editedFile, built.hash)).problems.join("\n");
  assert.match(problems, /notes@1's recorded hash doesn't match its schemas/);
  assert.match(problems, /hashes to/);
});

test("a connection must join a slot to an export of the same interface", async (t) => {
  const other = `import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
export const other = defineInterface({ name: "other", major: 1, kind: "rpc",
  methods: { ping: method({ input: z.object({}), output: z.object({}) }) } });
`;
  const widget = `import { defineWidget } from "@agentorg/sdk";
import { other } from "./other.ts";
export default defineWidget({ slots: { notes: other }, start() {} });
`;
  const files = { "notes.ts": iface(), "other.ts": other, "logic.ts": host, "panel.ts": widget };
  const modules = { logic: "src/logic.ts", panel: "src/panel.ts" };
  const wrong = await fixture(t, files, { modules, connections: [["panel.notes", "logic.notes"]] });
  await assert.rejects(wrong.build(), /joins other@1 to notes@1/);
  const missing = await fixture(t, files, {
    modules,
    connections: [["panel.nope", "logic.notes"]],
  });
  await assert.rejects(missing.build(), /"panel.nope" isn't a slot/);
});

test("one package can't hold two definitions of the same interface", async (t) => {
  const widget = `import { defineWidget } from "@agentorg/sdk";
import { notes } from "./notes2.ts";
export default defineWidget({ slots: { notes }, start() {} });
`;
  const f = await fixture(
    t,
    { "notes.ts": iface(), "notes2.ts": iface(3), "logic.ts": host, "panel.ts": widget },
    { modules: { logic: "src/logic.ts", panel: "src/panel.ts" } },
  );
  await assert.rejects(f.build(), /notes@1 with other schemas/);
});

test("a module whose top level touches DOM globals or does I/O fails with a clear error", async (t) => {
  const widget = (topLevel: string) => `import { defineWidget } from "@agentorg/sdk";
${topLevel}
export default defineWidget({ start() {} });
`;
  const run = async (topLevel: string) =>
    (
      await fixture(t, { "panel.ts": widget(topLevel) }, { modules: { panel: "src/panel.ts" } })
    ).build();
  await assert.rejects(
    run(`const title = document.title;`),
    /Module panel: its top level failed .*document is not defined.*must not do I\/O or touch DOM globals/s,
  );
  await assert.rejects(
    run(`await fetch("https://example.com");`),
    /fetch is not available at a module's top level/,
  );
  await assert.rejects(
    run(`import { readFileSync } from "node:fs"; readFileSync("/etc/hosts");`),
    /node:fs/,
  );
});

test("the default export must be a module", async (t) => {
  const f = await fixture(
    t,
    { "logic.ts": `export default { start() {} };\n` },
    { modules: { logic: "src/logic.ts" } },
  );
  await assert.rejects(f.build(), /isn't a module: define it with defineActor or defineWidget/);
});

test("the archive is deterministic and its reader refuses what a package can't hold", () => {
  const files = new Map([
    ["b.txt", new TextEncoder().encode("b")],
    ["a/x.js", new TextEncoder().encode("x".repeat(600))],
  ]);
  const archive = writeTar(files);
  assert.deepEqual(writeTar(new Map([...files].reverse())), archive);
  assert.deepEqual(readTar(archive), new Map([...files].sort()));
  const corrupt = archive.slice();
  corrupt[10] = 0x41;
  assert.throws(() => readTar(corrupt), /Corrupt tar header/);
  assert.throws(() => readTar(writeTar(new Map([["../x", new Uint8Array()]]))), /Unsafe path/);
});
