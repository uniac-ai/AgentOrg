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
  "hub",
  "shell",
  "mcp",
  "manager",
  "chatgpt",
  "looper",
  "assistant",
  "computer",
];
/** The AgentComputer SDK, without the service beside it in that package: the app never ships one. */
const COMPUTER_SDK = "@agentorg/computer";
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const destination = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? ".");
const alone = flags.includes("--core") ? "core" : flags.includes("--frontend") ? "frontend" : "";
const { version: release } = JSON.parse(
  readFileSync(join(root, "packages/app/package.json"), "utf8"),
);

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
  // The core alone carries no frontend: it serves the one it is given.
  if (alone === "core") delete cli.dependencies["@agentorg/shell"];
  for (const name of BUNDLED.filter((one) => !(alone === "core" && one === "shell"))) {
    const dir = `packages/${name}`;
    // Under its own name, scoped or not: the code finds it by that name.
    const { name: published } = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const own = unpack(dir, join(stage, "dist", "node_modules", published), work);
    // Shipped as files, never fetched: not a dependency of the published cli.
    delete cli.dependencies[own.name];
    bundled.push(own.name);
    // What each needs from the registry, the cli must have: it's found from there.
    for (const [dep, range] of Object.entries({ ...own.dependencies, ...own.peerDependencies }))
      if (!dep.startsWith("@agentorg/") && cli.dependencies[dep] !== range)
        throw new Error(
          `${own.name} needs ${dep}@${range}; the cli's dependencies must say so too.`,
        );
  }
  const sdk = join(root, "node_modules", COMPUTER_SDK);
  const sdkInto = join(stage, "dist", "node_modules", COMPUTER_SDK);
  const { version, license, type } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  for (const path of [
    "dist/sdk.js",
    "dist/types",
    "dist/THIRD_PARTY_LICENSES.txt",
    "NOTICE",
    "LICENSE",
  ])
    cpSync(join(sdk, path), join(sdkInto, path), { recursive: true });
  writeFileSync(
    join(sdkInto, "package.json"),
    `${JSON.stringify(
      {
        name: COMPUTER_SDK,
        version,
        license,
        type,
        exports: { ".": { types: "./dist/types/sdk.d.ts", default: "./dist/sdk.js" } },
      },
      null,
      2,
    )}\n`,
  );
  cli.files = [...cli.files, "dist/node_modules"];
  delete cli.devDependencies;
  delete cli.scripts;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(cli, null, 2)}\n`);
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
  if (alone === "core") {
    const file = join(destination, `agentorg-core-${release}.tgz`);
    // Copied, not moved: the work folder may be on another disk.
    copyFileSync(join(work, filename), file);
    console.log(file);
  } else console.log(join(destination, filename));
} finally {
  rmSync(work, { recursive: true, force: true });
}
