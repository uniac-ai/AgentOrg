// Pack @agentorg/cli for publishing: the app's own files, with the repository's other @agentorg
// packages, which aren't published, bundled inside it at node_modules/@agentorg/<name>, each as
// its own `npm pack` gives it. The code finds them there as it finds them in the workspace, by
// name from its own location, and so do the paths read at run time: the shell's files, the frame
// runtime, the host runner, the ajv worker and what a Hub build imports. Their third-party
// dependencies are the cli's own. Run after `npm run build`:
// `node packages/app/scripts/pack.js <destination>`, which prints the tarball's path.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
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
const BUNDLED = ["wire", "sdk", "interfaces", "hub", "shell"];
const destination = resolve(process.argv[2] ?? ".");

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

// By its real path: staged under a symlink (macOS's /var), npm packs without the bundled packages.
const work = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-pack-")));
try {
  const stage = join(work, "package");
  const cli = unpack("packages/app", stage, work);
  for (const file of ["README.md", "LICENSE"]) copyFileSync(join(root, file), join(stage, file));
  const bundled = [];
  for (const name of BUNDLED) {
    const own = unpack(`packages/${name}`, join(stage, "node_modules", "@agentorg", name), work);
    cli.dependencies[own.name] = own.version;
    bundled.push(own.name);
    // What each needs from the registry, the cli must have: it's found from there.
    for (const [dep, range] of Object.entries({ ...own.dependencies, ...own.peerDependencies }))
      if (!dep.startsWith("@agentorg/") && cli.dependencies[dep] !== range)
        throw new Error(
          `${own.name} needs ${dep}@${range}; the cli's dependencies must say so too.`,
        );
  }
  cli.bundleDependencies = bundled;
  delete cli.devDependencies;
  delete cli.scripts;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(cli, null, 2)}\n`);
  mkdirSync(destination, { recursive: true });
  const [{ filename, files }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", destination, stage], {
      encoding: "utf8",
    }),
  );
  for (const name of bundled)
    if (!files.some(({ path }) => path === `node_modules/${name}/package.json`))
      throw new Error(`${filename} doesn't hold ${name}.`);
  console.log(join(destination, filename));
} finally {
  rmSync(work, { recursive: true, force: true });
}
