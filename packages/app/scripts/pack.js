// Pack @agentorg/cli for publishing: the app's own files, with the repository's other @agentorg
// packages, which aren't published, inside it at dist/node_modules/@agentorg/<name>, each as its
// own `npm pack` gives it. They're plain files of the cli, not bundleDependencies: npm treats
// everything in a bundling package's own node_modules as bundled, and a global install nests the
// cli's dependencies there, so a dependency's install script could fail. The code
// finds them as it finds them in the workspace, by name from its own location (dist/src walks up
// to dist/node_modules), and so do the paths read at run time: the shell's files and the ajv
// worker. Their third-party
// dependencies are the cli's own, found further up. Run after `npm run build`:
// `node packages/app/scripts/pack.js <destination>`, which prints the tarball's path.
//
// Its dependencies from the registry are pinned by an npm-shrinkwrap.json made here from the root
// lockfile: each, and what each needs in turn, at the version and integrity the repository was
// tested with. AgentComputer's SDK, @agentorg/computer-sdk, is one of them. The workspace's own
// packages inside it are files, not dependencies, so they aren't in it; they are told by the
// workspace's list, not by their scope, which the SDK shares.
//
// The core and the frontend are also packed alone, as files of a release, not published:
// - `--core`: the same cli without the shell, as `agentorg-core-<version>.tgz`; it serves the
//   frontend it is given;
// - `--frontend`: the shell's built folder, as `frontend/` in `agentorg-frontend-<version>.tgz`.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const BUNDLED = [
  "wire",
  "sdk",
  "interfaces",
  "coordinator/hub",
  "shell",
  "coordinator/mcp",
  "coordinator/manager",
  "chatgpt",
  "looper",
  "assistant",
  "memory",
  "computer",
];
/** The names of the workspace's own packages: shipped inside the cli, never fetched. */
const OWN = new Set(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces.map(
    (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name,
  ),
);
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const destination = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? ".");
const alone = flags.includes("--core") ? "core" : flags.includes("--frontend") ? "frontend" : "";
const { version: release } = JSON.parse(
  readFileSync(join(root, "packages/app/package.json"), "utf8"),
);

/**
 * Where npm finds `name` for the package at `from` in a lockfile's tree: its own node_modules, then
 * each one above it, as Node does. `undefined` when it isn't installed.
 */
function resolveIn(packages, from, name) {
  for (let at = from; ; ) {
    const found = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[found]) return found;
    if (!at) return undefined;
    const up = at.lastIndexOf("/node_modules/");
    at = up >= 0 ? at.slice(0, up) : "";
  }
}

/**
 * The npm-shrinkwrap.json of `cli`, the staged package, from the root lockfile: its third-party
 * dependencies as the app at `packages/app` has them, and each one's own, transitively. A
 * bundled package whose dependency the workspace resolves to another copy than the cli's would
 * ship untested, so that is refused.
 */
function shrinkwrap(cli, bundledDirs) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const { packages } = lock;
  const app = "packages/app";
  // The app's own node_modules is the package's root once published.
  const placed = (at) => (at.startsWith(`${app}/`) ? at.slice(app.length + 1) : at);
  const kept = new Map();
  const visit = (from, name, optional) => {
    const at = resolveIn(packages, from, name);
    if (at === undefined) {
      if (optional) return;
      throw new Error(`The lockfile has no ${name} for ${from || "the root"}: run npm install.`);
    }
    const entry = packages[at];
    if (entry.link) throw new Error(`${name} is a workspace package, not one from the registry.`);
    const path = placed(at);
    const before = kept.get(path);
    if (before !== undefined) {
      if (before !== entry) throw new Error(`Two copies of ${name} would go at ${path}.`);
      return;
    }
    kept.set(path, entry);
    for (const dep of Object.keys(entry.dependencies ?? {})) visit(at, dep, false);
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) visit(at, dep, true);
    for (const dep of Object.keys(entry.peerDependencies ?? {}))
      visit(at, dep, entry.peerDependenciesMeta?.[dep]?.optional === true);
  };
  for (const dep of Object.keys(cli.dependencies)) visit(app, dep, false);
  for (const dir of bundledDirs) {
    const own = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    for (const dep of Object.keys({ ...own.dependencies, ...own.peerDependencies })) {
      if (OWN.has(dep) || !cli.dependencies[dep]) continue;
      const tested = resolveIn(packages, dir, dep);
      const shipped = resolveIn(packages, app, dep);
      if (tested && packages[tested] !== packages[shipped])
        throw new Error(
          `${dir} is tested with ${dep}@${packages[tested].version}, but the cli ships ${packages[shipped]?.version}.`,
        );
    }
  }
  const own = { name: cli.name, version: cli.version, license: cli.license };
  for (const key of ["dependencies", "bin", "engines"]) if (cli[key]) own[key] = cli[key];
  const listed = { "": own };
  for (const path of [...kept.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
    const { dev, devOptional, extraneous, ...entry } = kept.get(path);
    listed[path] = entry;
  }
  return {
    name: cli.name,
    version: cli.version,
    lockfileVersion: 3,
    requires: true,
    packages: listed,
  };
}

/** The workspace's `npm pack` of `dir`, unpacked into `into`. */
function unpack(dir, into, work) {
  const [{ filename }] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", work, "-w", dir],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", join(work, filename), "-C", into, "--strip-components=1"]);
  rmSync(join(work, filename));
  return JSON.parse(readFileSync(join(into, "package.json"), "utf8"));
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-pack-")));
try {
  if (alone === "frontend") {
    const built = join(root, "packages/shell/dist");
    if (!existsSync(join(built, "index.html")))
      throw new Error("The shell isn't built: npm run build first.");
    cpSync(built, join(work, "frontend"), { recursive: true });
    // Its own licence, the repository's, and what the shell carries under licences of its own; the
    // packages it bundles are in its THIRD_PARTY_LICENSES.txt, which the build wrote.
    copyFileSync(join(root, "LICENSE"), join(work, "frontend", "LICENSE"));
    copyFileSync(join(root, "packages/shell/NOTICE"), join(work, "frontend", "NOTICE"));
    mkdirSync(destination, { recursive: true });
    const file = join(destination, `agentorg-frontend-${release}.tgz`);
    execFileSync("tar", ["-czf", file, "-C", work, "frontend"]);
    console.log(file);
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }
  const stage = join(work, "package");
  const cli = unpack("packages/app", stage, work);
  for (const file of ["README.md", "LICENSE"]) copyFileSync(join(root, file), join(stage, file));
  const bundled = [];
  const bundledDirs = [];
  // The core alone carries no frontend: it serves the one it is given.
  if (alone === "core") delete cli.dependencies["@agentorg/shell"];
  for (const name of BUNDLED.filter((one) => !(alone === "core" && one === "shell"))) {
    const dir = `packages/${name}`;
    bundledDirs.push(dir);
    // Under its own name, scoped or not: the code finds it by that name.
    const { name: published } = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const own = unpack(dir, join(stage, "dist", "node_modules", published), work);
    // Shipped as files, never fetched: not a dependency of the published cli.
    delete cli.dependencies[own.name];
    bundled.push(own.name);
    // What each needs from the registry, the cli must have: it's found from there.
    for (const [dep, range] of Object.entries({ ...own.dependencies, ...own.peerDependencies }))
      if (!OWN.has(dep) && cli.dependencies[dep] !== range)
        throw new Error(
          `${own.name} needs ${dep}@${range}; the cli's dependencies must say so too.`,
        );
  }
  cli.files = [...cli.files, "dist/node_modules", "npm-shrinkwrap.json"];
  delete cli.devDependencies;
  delete cli.scripts;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(cli, null, 2)}\n`);
  writeFileSync(
    join(stage, "npm-shrinkwrap.json"),
    `${JSON.stringify(shrinkwrap(cli, bundledDirs), null, 2)}\n`,
  );
  mkdirSync(destination, { recursive: true });
  // The core alone is packed apart first: under the cli's own name it would take the cli's file.
  const packedTo = alone === "core" ? work : destination;
  const [{ filename, files }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", packedTo, stage], {
      encoding: "utf8",
    }),
  );
  for (const name of bundled)
    if (!files.some(({ path }) => path === `dist/node_modules/${name}/package.json`))
      throw new Error(`${filename} doesn't hold ${name}.`);
  if (!files.some(({ path }) => path === "npm-shrinkwrap.json"))
    throw new Error(`${filename} doesn't hold its npm-shrinkwrap.json.`);
  if (alone === "core") {
    const file = join(destination, `agentorg-core-${release}.tgz`);
    // Copied, not moved: the work folder may be on another disk.
    copyFileSync(join(work, filename), file);
    console.log(file);
  } else console.log(join(destination, filename));
} finally {
  rmSync(work, { recursive: true, force: true });
}
