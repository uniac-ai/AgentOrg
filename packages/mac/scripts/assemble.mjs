// What the app carries beside its own program, made ready for the bundle:
// - Node and Cua Driver, fetched from their own releases as assembly.json pins them, each into a
//   new, empty folder of its own and checked before anything of it is used, and of each only the
//   files assembly.json names;
// - the service, `@agentorg/computer`, from this workspace's install, which its lockfile checked;
// - their licences.
// The bundle takes them from `src-tauri/target/assembly/bundle`, through tauri.conf.json's
// `bundle.macOS.files`: `node` and `cua-driver` into Contents/MacOS, the service and the licences
// into Contents/Resources. Not as Tauri's sidecars, which are copied when the Rust is compiled, so
// that every `cargo build` and `cargo test` would need the fetched files. The bundle copies these
// as they are, signing none of them, so each program and native file is signed here, with the
// app's own identity and the entitlements in ../entitlements, before the bundle around them is.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A folder made new and empty. */
const fresh = (path) => {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
};

/** Copies a file or a folder, making the folder it goes into. */
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

/** A release's address asked for, its answer refused with that address where it fails. */
const asked = async (get, url) => {
  const answer = await get(url).catch((error) => {
    throw new Error(`${url} didn't answer: ${error instanceof Error ? error.message : error}`);
  });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}.`);
  return answer;
};

/**
 * A release's file, fetched into a new, empty folder of its own unless one already there checks.
 * Either way it is checked against its pin, the release's own sums and, where there is one, its
 * GitHub release's digest, before anything of it is used.
 */
export async function fetched(pin, downloads, get) {
  const folder = join(downloads, pin.file.replace(/\.tar\.\w+$/, ""));
  const file = join(folder, pin.file);
  if (!existsSync(file) || sha256(file) !== pin.sha256) {
    fresh(folder);
    const answer = await asked(get, pin.url);
    writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
  }
  const sum = sha256(file);
  if (sum !== pin.sha256) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error(`${pin.file}'s sha256 is ${sum}, not the pinned ${pin.sha256}.`);
  }
  const listed = (await (await asked(get, pin.sums)).text())
    .split("\n")
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === pin.file)?.[0];
  if (listed !== pin.sha256)
    throw new Error(
      `The release's sums give ${pin.file} ${listed ?? "no sha256"}, not the pinned one.`,
    );
  if (pin.release) {
    const release = await (await asked(get, pin.release)).json();
    const digest = release.assets?.find((one) => one.name === pin.file)?.digest;
    if (digest !== `sha256:${pin.sha256}`)
      throw new Error(
        `GitHub's digest of ${pin.file} is ${digest ?? "missing"}, not the pinned one.`,
      );
  }
  return { name: pin.file, url: pin.url, size: statSync(file).size, sha256: sum, at: file };
}

/** Of a checked release, the files its pin names, each a file of its own, into the bundle. */
function took(release, pin, bundle) {
  const into = fresh(join(dirname(release.at), "unpacked"));
  execFileSync("tar", ["-xf", release.at, "-C", into]);
  for (const [from, to] of Object.entries(pin.take)) {
    const path = join(into, from);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error(`${pin.file} has no file ${from}.`);
    copy(path, join(bundle, to));
  }
}

/** A package's folder, as Node would find it from another's, at the version wanted. */
const installed = (start, name, wanted) => {
  for (let at = start; ; at = dirname(at)) {
    const folder = join(at, "node_modules", name);
    if (existsSync(join(folder, "package.json"))) {
      const { version } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
      if (version !== wanted) throw new Error(`${name} is ${version} here, not ${wanted}.`);
      return folder;
    }
    if (dirname(at) === at) throw new Error(`${name} isn't installed here: run npm ci first.`);
  }
};

/** The service as the bundle carries it: its program and licences, and the two packages it loads. */
function service(workspace, wanted, into) {
  const computer = installed(workspace, "@agentorg/computer", wanted);
  const own = JSON.parse(readFileSync(join(computer, "package.json"), "utf8"));
  for (const file of [
    "package.json",
    "LICENSE",
    "NOTICE",
    "dist/agentcomputer.js",
    "dist/THIRD_PARTY_LICENSES.txt",
  ])
    copy(join(computer, file), join(into, file));
  const playwright = installed(computer, "playwright-core", own.dependencies["playwright-core"]);
  copy(playwright, join(into, "node_modules/playwright-core"));
  const pty = installed(computer, "node-pty", own.optionalDependencies["node-pty"]);
  for (const part of ["package.json", "LICENSE", "lib", "prebuilds/darwin-arm64"])
    copy(join(pty, part), join(into, "node_modules/node-pty", part));
  return own.version;
}

/** Signs a program or native file with the app's identity, and the entitlements named. */
export function sign(path, identity, entitlements) {
  execFileSync("codesign", [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    ...(identity === "-" ? [] : ["--timestamp"]),
    ...(entitlements ? ["--entitlements", entitlements] : []),
    path,
  ]);
}

/** What is signed, and with which entitlements, of what the bundle carries. */
const SIGNED = {
  "MacOS/node": "node.plist",
  "MacOS/cua-driver": "cua-driver.plist",
  "Resources/agentcomputer/node_modules/node-pty/prebuilds/darwin-arm64/pty.node": undefined,
  "Resources/agentcomputer/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper": undefined,
};
const PROGRAMS = [
  "MacOS/node",
  "MacOS/cua-driver",
  "Resources/agentcomputer/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
];

/** Makes `bundle` what the app carries, and says what was fetched. */
export async function assemble({ pins, target, workspace, service: wanted, get, signing }) {
  const downloads = join(target, "downloads");
  const node = await fetched(pins.node, downloads, get);
  const driver = await fetched(pins.driver, downloads, get);
  const bundle = fresh(join(target, "bundle"));
  took(node, pins.node, bundle);
  // Of the driver's release, never its perception extension, nor the program inside its
  // CuaDriver.app, whose entitlements are tied to its makers' Team ID: macOS refuses it once it is
  // signed as ours.
  took(driver, pins.driver, bundle);
  const version = service(workspace, wanted, join(bundle, "Resources/agentcomputer"));
  // Each program can run however the bundle is installed: node-pty ships its helper unmarked.
  for (const program of PROGRAMS) chmodSync(join(bundle, program), 0o755);
  for (const [path, entitlements] of Object.entries(SIGNED))
    signing(join(bundle, path), entitlements);
  const said = { fetched: [node, driver], service: version };
  writeFileSync(join(target, "fetched.json"), `${JSON.stringify(said, null, 2)}\n`);
  return said;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = JSON.parse(readFileSync(join(here, "src-tauri/tauri.conf.json"), "utf8"));
  const identity = process.env.APPLE_SIGNING_IDENTITY || config.bundle.macOS.signingIdentity;
  const own = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  try {
    const said = await assemble({
      pins: JSON.parse(readFileSync(join(here, "assembly.json"), "utf8")),
      target: join(here, "src-tauri/target/assembly"),
      workspace: here,
      service: own.dependencies["@agentorg/computer"],
      get: (url) => fetch(url, { signal: AbortSignal.timeout(10 * 60_000) }),
      signing: (path, entitlements) =>
        sign(path, identity, entitlements && join(here, "entitlements", entitlements)),
    });
    for (const one of said.fetched)
      console.log(`${basename(one.at)}: ${one.size} bytes, sha256 ${one.sha256}, from ${one.url}`);
    console.log(`The service: @agentorg/computer ${said.service}`);
  } catch (error) {
    console.error(`The app's assembly stopped: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
