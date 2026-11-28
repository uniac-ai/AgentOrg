#!/usr/bin/env node
// Packs the published @agentorg/sdk: AgentOrg's contracts, and the code a provider uses to join a
// coordinator and answer them. `node scripts/sdk/pack.mjs <out-dir>` writes
// agentorg-sdk-<version>.tgz into <out-dir>, with the version of this folder's package.json, and
// prints the tarball's path on its last line. Run after `npm run build`: it packs the workspaces'
// built files, and fails if one is missing or older than its source.
//
// This folder's package.json is the package's manifest. Inside the package, at
// dist/node_modules/@agentorg/<name>, are core's three workspace packages, wire, sdk and
// interfaces, each as its own `npm pack` gives it. They're plain files of the package, not
// bundleDependencies, as in @agentorg/cli. sdk leaves out the person's command line: cli and
// person-commands, their exports and its bin. The code finds the others by name from its own
// location, as in the workspace: interfaces' `@agentorg/sdk` and sdk's `@agentorg/wire` resolve to
// the packages beside them. Node refuses an export that points into a node_modules folder, so each
// of the manifest's exports is a file of ENTRIES that re-exports one of sdk's or interfaces'
// modules by its path: the sdk a consumer imports from the package's root is then the one module
// the contracts are made with. Each dependency they take from the registry, zod today, the pack
// writes into the package's manifest at exactly the version package-lock.json installs for the
// workspace that takes it: a contract's hash is computed from zod's JSON Schema output.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");
/** Core's workspaces, under packages/: all of each goes in, but for sdk's LEFT_OUT. */
const CORE = ["wire", "sdk", "interfaces"];
/** The person's command line, sdk's files that stay out, by their name under src without `.ts`. */
const LEFT_OUT = ["cli", "person-commands"];
/** The entry files in dist/, each with the module it re-exports, by its path from dist/. */
const ENTRIES = {
  index: "node_modules/@agentorg/sdk/dist/src/index.js",
  client: "node_modules/@agentorg/sdk/dist/src/client.js",
  testing: "node_modules/@agentorg/sdk/dist/src/testing.js",
  interfaces: "node_modules/@agentorg/interfaces/dist/src/index.js",
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** npm's output, run in `cwd`. */
const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8" });

/** Where npm finds `name` for the package at `from` in the lockfile's tree, as Node does. */
function resolveIn(packages, from, name) {
  for (let at = from; ; ) {
    const found = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[found]) return packages[found];
    if (!at) return undefined;
    const up = at.lastIndexOf("/");
    at = up >= 0 ? at.slice(0, up) : "";
  }
}

/** Fails unless every source of packages/<dir>/src has its built .js and .d.ts, newer than it. */
function checkBuilt(dir) {
  const src = join(root, "packages", dir, "src");
  for (const file of readdirSync(src, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = statSync(join(src, file)).mtimeMs;
    for (const ext of [".js", ".d.ts"]) {
      const built = join(root, "packages", dir, "dist", "src", file.replace(/\.ts$/, ext));
      if (!existsSync(built) || statSync(built).mtimeMs < source)
        throw new Error(
          `packages/${dir} isn't built from its source (dist/src/${file.replace(/\.ts$/, ext)}): run npm run build first.`,
        );
    }
  }
}

/** The workspace's `npm pack` of packages/<dir>, unpacked into `into`; returns its manifest. */
function unpack(dir, into, work) {
  const [{ filename }] = JSON.parse(
    npm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", work, "-w", `packages/${dir}`],
      root,
    ),
  );
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", join(work, filename), "-C", into, "--strip-components=1"]);
  rmSync(join(work, filename));
  return readJson(join(into, "package.json"));
}

/** sdk without the person's command line: its files, exports and bin. */
function leaveOut(dir, manifest) {
  const built = join(dir, "dist", "src");
  for (const file of readdirSync(built))
    if (LEFT_OUT.some((name) => file.startsWith(`${name}.`))) rmSync(join(built, file));
  for (const file of readdirSync(built))
    for (const name of LEFT_OUT)
      if (readFileSync(join(built, file), "utf8").includes(`"./${name}.js"`))
        throw new Error(`packages/sdk's ${file} takes ${name}, which the package leaves out.`);
  for (const name of LEFT_OUT) delete manifest.exports[`./${name}`];
  delete manifest.bin;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function pack(out) {
  const { publishConfig, ...manifest } = readJson(join(here, "package.json"));
  if (manifest.dependencies)
    throw new Error(
      "scripts/sdk/package.json names no dependencies: the pack writes them from package-lock.json.",
    );
  const { packages } = readJson(join(root, "package-lock.json"));
  for (const dir of CORE) checkBuilt(dir);
  const own = new Set(
    CORE.map((dir) => readJson(join(root, "packages", dir, "package.json")).name),
  );
  const work = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-sdk-pack-")));
  try {
    const stage = join(work, "package");
    const dependencies = {};
    for (const dir of CORE) {
      const { name } = readJson(join(root, "packages", dir, "package.json"));
      const into = join(stage, "dist", "node_modules", name);
      const nested = unpack(dir, into, work);
      if (dir === "sdk") leaveOut(into, nested);
      // What each needs from the registry, the package depends on, at exactly the version the
      // lockfile installs for that workspace.
      for (const [dep, range] of Object.entries({
        ...nested.dependencies,
        ...nested.peerDependencies,
      })) {
        if (own.has(dep)) continue;
        const tested = resolveIn(packages, `packages/${dir}`, dep)?.version;
        if (!tested)
          throw new Error(
            `${name} needs ${dep}@${range}, which package-lock.json doesn't install: run npm install.`,
          );
        if (dependencies[dep] !== undefined && dependencies[dep] !== tested)
          throw new Error(
            `${name} is tested with ${dep} ${tested}, another of core's packages with ${dependencies[dep]}: the package can depend on only one.`,
          );
        dependencies[dep] = tested;
      }
    }
    const packed = {
      ...manifest,
      dependencies: Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b, "en")),
      ),
      publishConfig,
    };
    // Each entry's .d.ts passes the module's types on as its .js passes the module's values.
    for (const [entry, module] of Object.entries(ENTRIES))
      for (const ext of [".js", ".d.ts"])
        writeFileSync(join(stage, "dist", `${entry}${ext}`), `export * from "./${module}";\n`);
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(packed, null, 2)}\n`);
    copyFileSync(join(here, "README.md"), join(stage, "README.md"));
    copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
    for (const [subpath, targets] of Object.entries(manifest.exports))
      for (const target of Object.values(targets))
        if (!existsSync(join(stage, target)))
          throw new Error(`The export ${subpath} names ${target}, which the package doesn't hold.`);

    mkdirSync(out, { recursive: true });
    const [{ filename, files }] = JSON.parse(
      npm(["pack", "--json", "--ignore-scripts", "--pack-destination", out, stage], work),
    );
    const expected = `agentorg-sdk-${manifest.version}.tgz`;
    if (filename !== expected) throw new Error(`npm packed ${filename}, not ${expected}.`);
    for (const name of own)
      if (!files.some(({ path }) => path === `dist/node_modules/${name}/package.json`))
        throw new Error(`${filename} doesn't hold ${name}.`);
    return join(out, filename);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [out, ...rest] = process.argv.slice(2);
if (!out || rest.length > 0) {
  console.error("Usage: node scripts/sdk/pack.mjs <out-dir>");
  process.exit(2);
}
try {
  console.log(pack(resolve(out)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
