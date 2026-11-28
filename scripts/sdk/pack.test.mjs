// The packed @agentorg/sdk as a consumer gets it. It packs into a temporary folder, or takes the
// tarball SDK_TARBALL names, and installs it alone in two empty folders:
// - "unpacked": unpacked into node_modules/@agentorg/sdk beside a link to the workspace's zod,
//   without npm or the network;
// - "npm install": installed by npm, as a consumer installs it. This one step needs the network.
//   `--prefer-offline` takes zod's tarball from npm's cache, which `npm ci` fills, and asks the
//   registry only for zod's metadata, which `npm ci` doesn't cache: with `--offline`, npm would
//   stop there.
// Each install must resolve the four entry points to one sdk and make the 18 committed hashes, and
// a strict TypeScript consumer must type-check against the npm install. Run after
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
const INSTALLS = ["unpacked", "npm install"];

let work;
/** The tarball's files, by their path in the package. */
let files;
/**
 * Each install by its name in INSTALLS: its consumer folder, the package's folder in it, and
 * `load`, which imports a specifier as a module of the consumer folder imports it.
 */
const installs = {};

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

  const unpacked = join(work, "unpacked");
  mkdirSync(join(unpacked, "node_modules", "@agentorg", "sdk"), { recursive: true });
  execFileSync("tar", [
    "-xzf",
    tarball,
    "-C",
    join(unpacked, "node_modules", "@agentorg", "sdk"),
    "--strip-components=1",
  ]);
  symlinkSync(join(root, "node_modules", "zod"), join(unpacked, "node_modules", "zod"), "dir");

  const npmInstalled = join(work, "npm-installed");
  mkdirSync(npmInstalled);
  writeFileSync(
    join(npmInstalled, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, type: "module" })}\n`,
  );
  execFileSync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", tarball], {
    cwd: npmInstalled,
    stdio: ["ignore", "ignore", "inherit"],
  });

  for (const [name, consumer] of [
    ["unpacked", unpacked],
    ["npm install", npmInstalled],
  ]) {
    writeFileSync(join(consumer, "load.mjs"), "export default (specifier) => import(specifier);\n");
    const { default: load } = await import(pathToFileURL(join(consumer, "load.mjs")).href);
    installs[name] = {
      consumer,
      installed: join(consumer, "node_modules", "@agentorg", "sdk"),
      load,
    };
  }
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

  const { installed } = installs.unpacked;
  const manifest = readJson(join(installed, "package.json"));
  assert.equal(manifest.bin, undefined);
  assert.deepEqual(Object.keys(manifest.exports), [".", "./client", "./testing", "./interfaces"]);
  const sdk = readJson(join(installed, NESTED, "sdk", "package.json"));
  assert.equal(sdk.bin, undefined);
  assert.deepEqual(Object.keys(sdk.exports).sort(), [".", "./client", "./testing"]);
});

for (const name of INSTALLS) {
  test(`every contract it exports hashes to the committed hash, all 18 (${name})`, async () => {
    const { load } = installs[name];
    const committed = readJson(
      join(root, "packages", "interfaces", "test", "interface-hashes.json"),
    );
    assert.equal(Object.keys(committed).length, 18);
    const { describeInterface } = await load("@agentorg/sdk");
    const contracts = await load("@agentorg/sdk/interfaces");
    const isObject = (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value);
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

  test(`the four entry points resolve, there is one sdk, and the wire isn't exported (${name})`, async () => {
    const { consumer, installed, load } = installs[name];
    assert.equal(typeof (await load("@agentorg/sdk")).defineInterface, "function");
    assert.equal(typeof (await load("@agentorg/sdk/client")).connect, "function");
    assert.equal(typeof (await load("@agentorg/sdk/testing")).createTestContext, "function");
    assert.equal(typeof (await load("@agentorg/sdk/interfaces")).hubActors, "object");

    // The contracts' own `@agentorg/sdk` is the one module a consumer gets from the package's
    // root.
    const fromContracts = resolveFrom(
      join(installed, NESTED, "interfaces", "dist", "src"),
      "@agentorg/sdk",
    );
    assert.equal(fromContracts, join(installed, NESTED, "sdk", "dist", "src", "index.js"));
    const contractsSdk = await import(pathToFileURL(fromContracts).href);
    const rootSdk = await load("@agentorg/sdk");
    assert.ok(Object.keys(rootSdk).length > 0);
    for (const [exported, value] of Object.entries(rootSdk))
      assert.equal(value, contractsSdk[exported], exported);
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
}

test("its zod is its own dependency, exactly the version the workspace installs", () => {
  const { packages } = readJson(join(root, "package-lock.json"));
  const tested = packages["node_modules/zod"].version;
  const { dependencies } = readJson(join(installs.unpacked.installed, "package.json"));
  assert.deepEqual(dependencies, { zod: tested });
  const { consumer } = installs["npm install"];
  assert.equal(readJson(join(consumer, "node_modules", "zod", "package.json")).version, tested);
});

/**
 * A strict consumer of the four entry points. Each `@ts-expect-error` must meet its error: the
 * wire is not to be reached, and kv@1's types are its own, not `any`.
 */
const CONSUMER = `import { defineActor, describeInterface, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { kv } from "@agentorg/sdk/interfaces";
import { createTestContext } from "@agentorg/sdk/testing";
// @ts-expect-error: the wire is the package's own, not one of its entry points.
import type {} from "@agentorg/sdk/wire";
// @ts-expect-error: nor a package of the consumer's.
import type {} from "@agentorg/wire";

/** kv@1 answered from a Map, by a provider that joins a coordinator. */
export async function provide(hubUrl: string, actorId: string, credential: string) {
  const store = new Map<string, string>();
  return connect({
    hubUrl,
    actorId,
    credential,
    exports: { kv },
    start: (ctx) =>
      ctx.exports.kv.implement({
        get: async ({ key }) => {
          // @ts-expect-error: kv@1's key is a string.
          const notAKey: number = key;
          return store.has(key) ? { value: store.get(key) ?? null } : {};
        },
        set: async ({ key, value }) => {
          store.set(key, JSON.stringify(value));
          return {};
        },
        delete: async ({ key }) => ({ deleted: store.delete(key) }),
        list: async () => ({ keys: [...store.keys()], next: null }),
      }),
  });
}

export const id: string = describeInterface(kv).id;
export const refused: Refused = new Refused("invalid", "a refusal");
export const tested = createTestContext(defineActor({ exports: { kv }, start: () => {} }));
`;

test("a strict TypeScript consumer type-checks against the npm install", () => {
  const { consumer, installed } = installs["npm install"];
  // zod's own types, as the wire's, name web globals such as URL and ReadableStream.
  const compilerOptions = {
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2023",
    lib: ["es2023", "dom"],
    types: [],
    strict: true,
    skipLibCheck: false,
    noEmit: true,
  };
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions, files: ["consumer.ts"] })}\n`,
  );
  writeFileSync(join(consumer, "consumer.ts"), CONSUMER);
  const tsc = (...args) =>
    execFileSync(
      join(root, "node_modules", ".bin", "tsc"),
      ["-p", "tsconfig.json", "--pretty", "false", ...args],
      { cwd: consumer, encoding: "utf8" },
    );
  try {
    tsc();
  } catch (error) {
    assert.fail(`tsc found errors:\n${error.stdout}`);
  }

  // Each file of the program, by its path from the consumer, with why it is in the program.
  const program = new Map();
  let file;
  for (const line of tsc("--explainFiles").split("\n").filter(Boolean)) {
    if (/^\s/.test(line)) {
      program.get(file)?.push(line.trim());
      continue;
    }
    file = line;
    program.set(file, []);
  }
  /** The files that import `path` by `specifier`. */
  const importers = (path, specifier) => {
    const via = `Imported via "${specifier}" from file '`;
    const found = (program.get(path) ?? [])
      .filter((reason) => reason.startsWith(via))
      .map((reason) => reason.slice(via.length, reason.indexOf("'", via.length)));
    return [...new Set(found)].sort();
  };
  const nested = `node_modules/@agentorg/sdk/${NESTED}`;

  // One sdk in the program, the nested one, and every interfaces file that names `@agentorg/sdk`
  // takes it from there.
  const sdkIndex = `${nested}/sdk/dist/src/index.d.ts`;
  assert.deepEqual(
    [...program.keys()].filter((path) => path.endsWith("/sdk/dist/src/index.d.ts")),
    [sdkIndex],
  );
  const contracts = join(installed, NESTED, "interfaces", "dist", "src");
  const naming = readdirSync(contracts, { recursive: true })
    .filter((path) => path.endsWith(".d.ts"))
    .filter((path) => readFileSync(join(contracts, path), "utf8").includes('"@agentorg/sdk"'))
    .map((path) => `${nested}/interfaces/dist/src/${path}`)
    .sort();
  assert.ok(naming.length > 0);
  assert.deepEqual(importers(sdkIndex, "@agentorg/sdk"), naming);
  // The wire's types are the client's alone.
  assert.deepEqual(importers(`${nested}/wire/dist/src/index.d.ts`, "@agentorg/wire"), [
    `${nested}/sdk/dist/src/client.d.ts`,
  ]);
});
