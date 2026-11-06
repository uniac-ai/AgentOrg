import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BuildError, buildPackage, verifyPackage, writeTar } from "../src/build.ts";
import { checkManifest, readTar, verifyArchive } from "../src/manifest-api.ts";

const sdk = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Fixture packages live inside the repo, so they resolve @agentorg/sdk and zod from its workspace.
const fixtures = join(sdk, ".test-fixtures");

const iface = (min = 1, doc = "") => `import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
export const notes = defineInterface({
  name: "notes", major: 1, kind: "rpc",
  methods: { write: method({ input: z.object({ text: z.string().min(${min})${doc ? `.describe(${JSON.stringify(doc)})` : ""} }), output: z.object({}) }) },
});
`;
const host = `import { defineActor } from "@agentorg/sdk";
import { notes } from "./notes.ts";
export default defineActor({ exports: { notes }, start(ctx) { ctx.exports.notes.implement({ write: () => ({}) }); } });
`;
const reader = `import { defineWidget } from "@agentorg/sdk";
import { notes } from "./notes.ts";
export default defineWidget({ slots: { notes }, start() {} });
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
  const build = (options: { describeTimeoutMs?: number } = {}) =>
    buildPackage(dir, { out: join(dir, "out"), ...options });
  const edit = (path: string, text: string) => writeFile(join(dir, "src", path), text);
  return { dir, build, edit };
}
const one = { "notes.ts": iface(), "logic.ts": host };
const logicOnly = { modules: { logic: "src/logic.ts" } };

test("rebuilding gives the same hashes, and a schema change changes the interface and package hashes", async (t) => {
  const f = await fixture(t, one, logicOnly);
  const first = await f.build();
  assert.equal((await f.build()).hash, first.hash);
  assert.match(first.file, /sha256-[0-9a-f]{64}\.agentorg$/);
  assert.equal((await verifyPackage(first.file)).ok, true);
  await f.edit("notes.ts", iface(2));
  const changed = await f.build();
  assert.notEqual(
    changed.manifest.interfaces["notes@1"]?.hash,
    first.manifest.interfaces["notes@1"]?.hash,
  );
  assert.notEqual(changed.hash, first.hash);
});

test("the same source hashes the same wherever the package sits", async (t) => {
  const near = await fixture(t, one, logicOnly);
  const deeper = join(fixtures, `deeper-${process.pid}`);
  const deep = join(deeper, "still", "further");
  await mkdir(deep, { recursive: true });
  t.after(() => rm(deeper, { recursive: true, force: true }));
  await cp(near.dir, join(deep, "pkg"), { recursive: true });
  const a = await near.build();
  const b = await buildPackage(join(deep, "pkg"), { out: join(deep, "out") });
  assert.equal(b.hash, a.hash);
});

test("the archive sits beside the tree it hashes, and the output folder can't hold the package", async (t) => {
  const f = await fixture(t, one, logicOnly);
  const built = await f.build();
  assert.equal(dirname(built.file), dirname(built.dir));
  assert.deepEqual(
    JSON.parse(await readFile(join(built.dir, "agentorg.json"), "utf8")),
    built.manifest,
  );
  await assert.rejects(buildPackage(f.dir, { out: f.dir }), BuildError);
  await assert.rejects(buildPackage(f.dir, { out: dirname(f.dir) }), /holds the package itself/);
});

test("a tampered file, an edited interface hash, an extra or missing file, or a corrupt archive is detected", async (t) => {
  const f = await fixture(t, one, logicOnly);
  const built = await f.build();
  const bytes = new Uint8Array(await readFile(built.file));
  const files = readTar(bytes);
  assert.equal(verifyArchive(bytes, built.hash).ok, true);
  const problems = (changed: Map<string, Uint8Array>) => {
    const result = verifyArchive(writeTar(changed), built.hash);
    assert.equal(result.ok, false);
    return result.ok ? "" : result.problems.join("\n");
  };
  const code = files.get("dist/logic.js") as Uint8Array;
  assert.match(
    problems(new Map([...files, ["dist/logic.js", new Uint8Array([...code, 32])]])),
    /hashes to/,
  );
  const manifest = JSON.parse(new TextDecoder().decode(files.get("agentorg.json")));
  manifest.interfaces["notes@1"].methods.write.input.properties.text.minLength = 0;
  const edited = new Map([
    ...files,
    ["agentorg.json", new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
  assert.match(problems(edited), /notes@1's recorded hash doesn't match its schemas/);
  assert.match(
    problems(new Map([...files, ["dist/extra.js", new Uint8Array()]])),
    /dist\/extra.js doesn't belong/,
  );
  const missing = new Map(files);
  missing.delete("dist/logic.js");
  assert.match(problems(missing), /dist\/logic.js is missing/);
  const corrupt = bytes.slice();
  corrupt[10] = 0x41;
  const result = verifyArchive(corrupt, built.hash);
  assert.ok(!result.ok && /Corrupt tar header/.test(result.problems.join()));
  const unnamed = await verifyPackage(join(f.dir, "unnamed.agentorg"));
  assert.ok(!unnamed.ok && /No expected hash/.test(unnamed.problems.join()));
});

test("a manifest is checked as data, so a malformed one lists problems instead of throwing", () => {
  assert.deepEqual(checkManifest(null), ["The manifest isn't a JSON object."]);
  const problems = checkManifest({
    format: "other/9",
    name: "x",
    version: "1",
    modules: { logic: { placement: "host", entry: "dist/logic.js" } },
    interfaces: {},
    connections: [["logic.a", "logic.b", "extra"], 5],
    signature: null,
  }).join("\n");
  assert.match(problems, /Unknown format/);
  assert.match(problems, /Module logic needs slots/);
  assert.match(problems, /must be \["module.slot", "module.export"\]/);
});

test("a connection must join a slot to an export of the same interface, once", async (t) => {
  const other = `import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
export const other = defineInterface({ name: "other", major: 1, kind: "rpc",
  methods: { ping: method({ input: z.object({}), output: z.object({}) }) } });
`;
  const wrongWidget = `import { defineWidget } from "@agentorg/sdk";
import { other } from "./other.ts";
export default defineWidget({ slots: { notes: other }, start() {} });
`;
  const modules = { logic: "src/logic.ts", panel: "src/panel.ts" };
  const build = async (files: Record<string, string>, connections: unknown) =>
    (await fixture(t, { ...one, ...files }, { modules, connections })).build();
  await assert.rejects(
    build({ "other.ts": other, "panel.ts": wrongWidget }, [["panel.notes", "logic.notes"]]),
    /joins other@1 to notes@1/,
  );
  await assert.rejects(
    build({ "panel.ts": reader }, [["panel.nope", "logic.notes"]]),
    /"panel.nope" isn't a slot/,
  );
  await assert.rejects(
    build({ "panel.ts": reader }, [["logic.constructor", "logic.constructor"]]),
    /isn't a slot/,
  );
  await assert.rejects(
    build({ "panel.ts": reader }, [["panel.notes", "logic.notes", "extra"]]),
    /must be \["module.slot", "module.export"\]/,
  );
  await assert.rejects(
    build({ "panel.ts": reader }, [
      ["panel.notes", "logic.notes"],
      ["panel.notes", "logic.notes"],
    ]),
    /panel.notes is connected twice/,
  );
  const built = await build({ "panel.ts": reader }, [["panel.notes", "logic.notes"]]);
  assert.deepEqual(built.manifest.connections, [["panel.notes", "logic.notes"]]);
});

test("seed state passes into the manifest as given", async (t) => {
  const f = await fixture(t, one, { ...logicOnly, seed: { "logic.store": { cards: [] } } });
  assert.deepEqual((await f.build()).manifest.seed, { "logic.store": { cards: [] } });
});

test("one package can't hold two definitions of the same interface", async (t) => {
  const widget = reader.replace("./notes.ts", "./notes2.ts");
  const f = await fixture(
    t,
    { ...one, "notes2.ts": iface(3), "panel.ts": widget },
    { modules: { logic: "src/logic.ts", panel: "src/panel.ts" } },
  );
  await assert.rejects(f.build(), /notes@1 with other schemas/);
});

test("a module whose top level touches DOM globals, does I/O or never ends fails the build clearly", async (t) => {
  const widget = (topLevel: string) => `import { defineWidget } from "@agentorg/sdk";
${topLevel}
export default defineWidget({ start() {} });
`;
  const run = async (topLevel: string, describeTimeoutMs?: number) =>
    (
      await fixture(t, { "panel.ts": widget(topLevel) }, { modules: { panel: "src/panel.ts" } })
    ).build({ describeTimeoutMs });
  await assert.rejects(
    run("const title = document.title;"),
    /Module panel: its top level failed .*document is not defined.*must not do I\/O or touch DOM globals/s,
  );
  await assert.rejects(run(`await fetch("https://example.com");`), /fetch is not available/);
  await assert.rejects(
    run(`process.getBuiltinModule("node:dns");`),
    /getBuiltinModule is not available/,
  );
  await assert.rejects(
    run(`const name = ["node", "net"].join(":"); await import(name);`),
    /node:net is not available/,
  );
  // A static import of a built-in doesn't bundle at all.
  await assert.rejects(
    run(`import { readFileSync } from "node:fs"; readFileSync("/etc/hosts");`),
    /node:fs/,
  );
  await assert.rejects(
    run(`process.on("SIGTERM", () => {}); while (true) {}`, 1_000),
    /took over 1000 ms/,
  );
});

test("a module's own output, a large definition or the marker in a schema don't confuse the build", async (t) => {
  const noisy = `import { defineActor } from "@agentorg/sdk";
import { notes } from "./notes.ts";
console.log("agentorg-describe: not the result");
export default defineActor({ slots: { notes }, start() {} });
`;
  const f = await fixture(
    t,
    { "notes.ts": iface(1, `agentorg-describe: ${"x".repeat(100_000)}`), "logic.ts": noisy },
    logicOnly,
  );
  const built = await f.build();
  assert.deepEqual(built.manifest.modules.logic?.slots, { notes: "notes@1" });
  assert.ok(JSON.stringify(built.manifest).length > 100_000);
});

test("the default export must be a module", async (t) => {
  const f = await fixture(t, { "logic.ts": "export default { start() {} };\n" }, logicOnly);
  await assert.rejects(f.build(), /isn't a module: define it with defineActor or defineWidget/);
});

test("the CLI exits 0 on a build, 1 when the package is wrong and 2 without a command", async (t) => {
  const cli = join(sdk, "dist", "src", "cli.js");
  const f = await fixture(t, one, logicOnly);
  const ok = spawnSync(process.execPath, [cli, "build", f.dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^fixture@1\.0\.0 sha256-[0-9a-f]{64}\n/);
  const broken = await fixture(t, { "logic.ts": "export default {};\n" }, logicOnly);
  const failed = spawnSync(process.execPath, [cli, "build", broken.dir], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /isn't a module/);
  assert.doesNotMatch(failed.stderr, /\n\s+at /, "a BuildError prints its message, not a stack");
  assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 2);
});

test("the archive is deterministic and its reader refuses what a package can't hold", () => {
  const files = new Map([
    ["b.txt", new TextEncoder().encode("b")],
    ["a/x.js", new TextEncoder().encode("x".repeat(600))],
  ]);
  const archive = writeTar(files);
  assert.deepEqual(writeTar(new Map([...files].reverse())), archive);
  assert.deepEqual(readTar(archive), new Map([...files].sort()));
  for (const path of ["../x", "./a.js", "a//b", "a/./b", "a\\b", "C:/x"])
    assert.throws(
      () => readTar(writeTar(new Map([[path, new Uint8Array()]]))),
      /Unsafe path/,
      path,
    );
  const prefixed = archive.slice();
  prefixed[345] = 0x70;
  assert.throws(() => readTar(prefixed), /Corrupt tar header|no name prefix/);
  assert.throws(() => readTar(archive.slice(0, 700)), /runs past the end|end marker/);
});
