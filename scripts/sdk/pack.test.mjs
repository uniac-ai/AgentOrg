// The packed @agentorg/sdk as a consumer gets it: installed alone in an empty folder, without the
// network, by unpacking it into node_modules/@agentorg/sdk beside a link to the workspace's zod.
// It packs into a temporary folder, or takes the tarball SDK_TARBALL names. Run after
// `npm run build`: `node --test scripts/sdk/pack.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const NESTED = "dist/node_modules/@agentorg";

let work;
/** The tarball's files, by their path in the package. */
let files;
/** The installed package's folder, and the consumer folder it is installed in. */
let installed;
let consumer;
/** Import `specifier` as a module of the consumer folder imports it. */
let load;

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-sdk-test-")));
  const tarball = process.env.SDK_TARBALL
    ? resolve(process.env.SDK_TARBALL)
    : execFileSync(process.execPath, [join(here, "pack.mjs"), join(work, "packed")], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .at(-1);
  files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^package\//, ""));
  consumer = join(work, "consumer");
  installed = join(consumer, "node_modules", "@agentorg", "sdk");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
  symlinkSync(join(root, "node_modules", "zod"), join(consumer, "node_modules", "zod"), "dir");
  writeFileSync(join(consumer, "load.mjs"), "export default (specifier) => import(specifier);\n");
  ({ default: load } = await import(pathToFileURL(join(consumer, "load.mjs")).href));
});
after(() => rmSync(work, { recursive: true, force: true }));

/** Where Node resolves `specifier` from a file in `dir`. */
const resolveFrom = (dir, specifier) => createRequire(join(dir, "index.js")).resolve(specifier);

/** The built files of packages/<dir>/src, as the package holds them, but for those `without`. */
function builtFiles(dir, without = []) {
  const kept = readdirSync(join(root, "packages", dir, "src"), { recursive: true })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -".ts".length))
    .filter((file) => !without.includes(file));
  return kept.flatMap((file) => [`dist/src/${file}.js`, `dist/src/${file}.d.ts`]).sort();
}

test("it holds core's three packages, without the person's command line", () => {
  const entries = ["client", "index", "interfaces", "testing"];
  const top = files.filter((path) => !path.startsWith(`${NESTED}/`)).sort();
  assert.deepEqual(
    top,
    [
      "LICENSE",
      "README.md",
      ...entries.flatMap((entry) => [`dist/${entry}.d.ts`, `dist/${entry}.js`]),
      "package.json",
    ].sort(),
  );
  const nested = (name) =>
    files
      .filter((path) => path.startsWith(`${NESTED}/${name}/`))
      .map((path) => path.slice(`${NESTED}/${name}/`.length))
      .sort();
  for (const [name, without] of [
    ["wire", []],
    ["sdk", ["cli", "person-commands"]],
    ["interfaces", []],
  ])
    assert.deepEqual(nested(name), [...builtFiles(name, without), "package.json"].sort(), name);
  assert.deepEqual(
    files.filter((path) => /(^|\/)(cli|person-commands)\./.test(path)),
    [],
  );

  const manifest = readJson(join(installed, "package.json"));
  assert.equal(manifest.bin, undefined);
  assert.deepEqual(Object.keys(manifest.exports), [".", "./client", "./testing", "./interfaces"]);
  const sdk = readJson(join(installed, NESTED, "sdk", "package.json"));
  assert.equal(sdk.bin, undefined);
  assert.deepEqual(Object.keys(sdk.exports).sort(), [".", "./client", "./testing"]);
});

test("every contract it exports hashes to the committed hash, all 18", async () => {
  const committed = readJson(join(root, "packages", "interfaces", "test", "interface-hashes.json"));
  assert.equal(Object.keys(committed).length, 18);
  const { describeInterface } = await load("@agentorg/sdk");
  const contracts = await load("@agentorg/sdk/interfaces");
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  // What `defineInterface` returns, as packages/interfaces/test/exports.test.ts tells it.
  const isInterface = (value) =>
    isObject(value) &&
    value.kind === "rpc" &&
    typeof value.name === "string" &&
    Number.isInteger(value.major) &&
    isObject(value.methods) &&
    isObject(value.events);
  const hashes = {};
  for (const value of Object.values(contracts).filter(isInterface)) {
    const { id, hash } = describeInterface(value);
    hashes[id] = hash;
  }
  assert.deepEqual(hashes, committed);
});

test("the four entry points resolve, there is one sdk, and the wire isn't exported", async () => {
  assert.equal(typeof (await load("@agentorg/sdk")).defineInterface, "function");
  assert.equal(typeof (await load("@agentorg/sdk/client")).connect, "function");
  assert.equal(typeof (await load("@agentorg/sdk/testing")).createTestContext, "function");
  assert.equal(typeof (await load("@agentorg/sdk/interfaces")).hubActors, "object");

  // The contracts' own `@agentorg/sdk` is the one module a consumer gets from the package's root.
  const fromContracts = resolveFrom(
    join(installed, NESTED, "interfaces", "dist", "src"),
    "@agentorg/sdk",
  );
  assert.equal(fromContracts, join(installed, NESTED, "sdk", "dist", "src", "index.js"));
  const contractsSdk = await import(pathToFileURL(fromContracts).href);
  const rootSdk = await load("@agentorg/sdk");
  assert.ok(Object.keys(rootSdk).length > 0);
  for (const [name, value] of Object.entries(rootSdk))
    assert.equal(value, contractsSdk[name], name);
  assert.ok(resolveFrom(consumer, "@agentorg/sdk").startsWith(`${installed}/`));

  for (const specifier of [
    "@agentorg/sdk/wire",
    "@agentorg/sdk/cli",
    "@agentorg/sdk/person-commands",
    `@agentorg/sdk/${NESTED}/wire/dist/src/index.js`,
  ])
    await assert.rejects(load(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, specifier);
  await assert.rejects(load("@agentorg/wire"), { code: "ERR_MODULE_NOT_FOUND" });
});

test("its zod is its own dependency, exactly the version the workspace installs", () => {
  const { packages } = readJson(join(root, "package-lock.json"));
  const { dependencies } = readJson(join(installed, "package.json"));
  assert.deepEqual(dependencies, { zod: packages["node_modules/zod"].version });
});
