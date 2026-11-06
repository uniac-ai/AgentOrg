import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { hashOf, sha256 } from "./canonical.js";
import type { ModuleDescription } from "./describe.js";
import {
  compareInterfaces,
  type DescribedInterface,
  hashInterface,
  type InterfaceSchemas,
} from "./interface.js";
import type { Placement } from "./module.js";
import { readTar, writeTar } from "./tar.js";

export const FORMAT = "agentorg.package/1";

/** An interface as `agentorg.json` records it, keyed by its `name@major`. */
export type ManifestInterface = DescribedInterface extends infer D
  ? D extends unknown
    ? Omit<D, "id">
    : never
  : never;
export interface ManifestModule {
  placement: Placement;
  entry: string;
  slots: Record<string, string>;
  exports: Record<string, string>;
}
/** `agentorg.json`, generated from the package's code. */
export interface Manifest {
  format: typeof FORMAT;
  name: string;
  version: string;
  description?: string;
  modules: Record<string, ManifestModule>;
  interfaces: Record<string, ManifestInterface>;
  /** The package's own wiring: `[ "module.slot", "module.export" ]`. Other slots are the installer's. */
  connections: [string, string][];
  /** Optional initial state for state slots, the only runtime state a package may carry. */
  seed: unknown;
  signature: null;
}

/** What a package's `package.json` says under `agentorg`. */
interface Config {
  modules: Record<string, string>;
  connections?: [string, string][];
  seed?: unknown;
}

export interface Built {
  manifest: Manifest;
  /** SHA-256 over the canonical file tree: what a composition pins and grants follow. */
  hash: string;
  /** The `.agentorg` archive, named by the hash. */
  file: string;
  /** The tree: `agentorg.json` and `dist/`. */
  dir: string;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;

class BuildError extends Error {
  override readonly name = "BuildError";
}

/** The canonical tree hash: SHA-256 over the sorted `[path, sha256(bytes)]` of every file. */
export function treeHash(files: Map<string, Uint8Array>): string {
  return hashOf(
    [...files.keys()].sort().map((path) => [path, sha256(files.get(path) as Uint8Array)]),
  );
}

/**
 * Build a package: bundle each module with every library into one ESM file, read each module's
 * definition from its code, write `agentorg.json`, hash the tree, and archive it as
 * `<hash>.agentorg`. The tree and archive go to `out` (default `<dir>/agentorg-build`), which is
 * replaced.
 */
export async function buildPackage(dir: string, options: { out?: string } = {}): Promise<Built> {
  const root = resolve(dir);
  const out = resolve(options.out ?? join(root, "agentorg-build"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    description?: string;
    agentorg?: Config;
  };
  const config = pkg.agentorg;
  if (!pkg.name || !pkg.version) throw new BuildError("package.json needs a name and a version.");
  if (!config || typeof config.modules !== "object" || !Object.keys(config.modules).length)
    throw new BuildError(`package.json needs "agentorg": { "modules": { "<name>": "<entry>" } }.`);
  for (const name of Object.keys(config.modules))
    if (!NAME.test(name))
      throw new BuildError(`${JSON.stringify(name)} isn't a valid module name.`);

  const bundles = new Map<string, Uint8Array>();
  const described: Record<string, ModuleDescription> = {};
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "agentorg-build-")));
  try {
    for (const [name, entry] of Object.entries(config.modules)) {
      bundles.set(`dist/${name}.js`, await bundle(root, { entryPoints: [join(root, entry)] }));
      // The definition is read by running the module's code, so the describer is bundled with it.
      const describer = await bundle(root, {
        stdin: {
          contents: [
            `import definition from ${JSON.stringify(join(root, entry))};`,
            `import { describeModule } from "@agentorg/sdk/describe";`,
            "export default describeModule(definition);",
          ].join("\n"),
          resolveDir: root,
          sourcefile: `describe-${name}.js`,
        },
      });
      described[name] = await describeInChild(scratch, name, describer);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const interfaces: Record<string, ManifestInterface> = {};
  const record = (where: string, iface: DescribedInterface) => {
    const { id, ...entry } = iface;
    const known = interfaces[id];
    if (known && compareInterfaces({ id, hash: known.hash }, iface) === "conflict")
      throw new BuildError(
        `${where} uses ${id} with other schemas than another module does: one package has one definition of each interface.`,
      );
    interfaces[id] = entry;
    return id;
  };
  const modules: Record<string, ManifestModule> = {};
  for (const [name, d] of Object.entries(described))
    modules[name] = {
      placement: d.placement,
      entry: `dist/${name}.js`,
      slots: Object.fromEntries(
        Object.entries(d.slots).map(([slot, i]) => [slot, record(`${name}.${slot}`, i)]),
      ),
      exports: Object.fromEntries(
        Object.entries(d.exports).map(([exp, i]) => [exp, record(`${name}.${exp}`, i)]),
      ),
    };

  const connections = config.connections ?? [];
  const wired = new Set<string>();
  for (const connection of connections) {
    const [from, to] = connection;
    const end = (path: string, side: "slots" | "exports") => {
      const [module, member, extra] = String(path).split(".");
      const id = module && member && !extra ? modules[module]?.[side][member] : undefined;
      if (!id)
        throw new BuildError(
          `Connection ${JSON.stringify(connection)}: ${JSON.stringify(path)} isn't a ${side === "slots" ? "slot" : "export"} of a module here, as "module.${side === "slots" ? "slot" : "export"}".`,
        );
      return id;
    };
    const slot = end(from, "slots");
    const exported = end(to, "exports");
    if (slot !== exported)
      throw new BuildError(
        `Connection ${JSON.stringify(connection)} joins ${slot} to ${exported}.`,
      );
    if (wired.has(from)) throw new BuildError(`${from} is connected twice.`);
    wired.add(from);
  }

  const manifest: Manifest = {
    format: FORMAT,
    name: pkg.name,
    version: pkg.version,
    ...(pkg.description ? { description: pkg.description } : {}),
    modules,
    interfaces: Object.fromEntries(Object.entries(interfaces).sort(([a], [b]) => (a < b ? -1 : 1))),
    connections,
    seed: config.seed ?? null,
    signature: null,
  };
  const files = new Map(bundles);
  files.set("agentorg.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const hash = treeHash(files);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "dist"), { recursive: true });
  for (const [path, data] of files) await writeFile(join(out, path), data);
  const file = join(out, `${hash}.agentorg`);
  await writeFile(file, writeTar(files));
  return { manifest, hash, file, dir: out };
}

/** One ESM file holding the entry and every library it uses: no runtime imports, no CDN. */
async function bundle(
  root: string,
  input: Pick<Parameters<typeof esbuild>[0], "entryPoints" | "stdin">,
): Promise<Uint8Array> {
  try {
    const result = await esbuild({
      ...input,
      absWorkingDir: root,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["import", "module", "default"],
      target: "es2023",
      write: false,
      logLevel: "silent",
    });
    return (result.outputFiles[0] as { contents: Uint8Array }).contents;
  } catch (error) {
    const errors = (
      error as { errors?: { text: string; location?: { file: string; line: number } }[] }
    ).errors;
    throw new BuildError(
      errors?.length
        ? errors
            .map((e) => `${e.location ? `${e.location.file}:${e.location.line}: ` : ""}${e.text}`)
            .join("\n")
        : String(error),
    );
  }
}

/** Globals a module's top level might reach for I/O; the describer's process removes them. */
const PRELOAD = `for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"])
  Object.defineProperty(globalThis, name, { get() { throw new Error(name + " is not available at a module's top level"); } });
`;
const RUNNER = `try {
  const described = (await import(process.argv[2])).default;
  process.stdout.write(JSON.stringify({ described }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error && error.stack ? error.name + ": " + error.message : error) }));
}
process.exit(0);
`;

/**
 * Run a module's describer in a child Node process under the permission model: it reads only the
 * scratch folder, writes nothing, starts no processes or workers, and has no network globals. A
 * top level that does I/O or touches DOM globals fails there, and the build says why.
 */
async function describeInChild(
  scratch: string,
  name: string,
  describer: Uint8Array,
): Promise<ModuleDescription> {
  const files = { preload: join(scratch, "preload.mjs"), runner: join(scratch, "runner.mjs") };
  await writeFile(files.preload, PRELOAD);
  await writeFile(files.runner, RUNNER);
  const target = join(scratch, `${name}.mjs`);
  await writeFile(target, describer);
  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((done, fail) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${scratch}`,
        "--import",
        files.preload,
        files.runner,
        target,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: {} },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
  let result: { described?: ModuleDescription; error?: string };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new BuildError(
      `Module ${name}: its definition couldn't be read (exit ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`,
    );
  }
  if (result.error || !result.described)
    throw new BuildError(
      `Module ${name}: its top level failed while its definition was read: ${result.error}. A module's top level must not do I/O or touch DOM globals; do that work in start().`,
    );
  return result.described;
}

export interface Verified {
  /** The tree hash recomputed from the archive. */
  hash: string;
  manifest?: Manifest;
  /** Everything wrong; empty when the package is intact and its manifest consistent. */
  problems: string[];
}

/**
 * Check a `.agentorg` archive: its tree hash against the expected one (by default the hash in its
 * file name), every interface hash against its recorded schemas, and every module entry present.
 */
export async function verifyPackage(file: string, expected?: string): Promise<Verified> {
  const files = readTar(new Uint8Array(await readFile(file)));
  const hash = treeHash(files);
  const problems: string[] = [];
  const want = expected ?? /(sha256-[0-9a-f]{64})\.agentorg$/.exec(file)?.[1];
  if (!want) problems.push("No expected hash: pass one, or keep the file named by its hash.");
  else if (want !== hash) problems.push(`The package hashes to ${hash}, not ${want}.`);
  const raw = files.get("agentorg.json");
  if (!raw) return { hash, problems: [...problems, "The package has no agentorg.json."] };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
  } catch {
    return { hash, problems: [...problems, "agentorg.json isn't JSON."] };
  }
  if (manifest.format !== FORMAT)
    problems.push(`Unknown format ${JSON.stringify(manifest.format)}.`);
  for (const [id, entry] of Object.entries(manifest.interfaces ?? {})) {
    const { hash: recorded, ...schemas } = entry;
    if (hashInterface({ id, ...schemas } as InterfaceSchemas) !== recorded)
      problems.push(`${id}'s recorded hash doesn't match its schemas.`);
  }
  for (const [name, module] of Object.entries(manifest.modules ?? {})) {
    if (!files.has(module.entry))
      problems.push(`Module ${name}'s entry ${module.entry} is missing.`);
    for (const id of [...Object.values(module.slots), ...Object.values(module.exports)])
      if (!manifest.interfaces?.[id])
        problems.push(`Module ${name} uses ${id}, which isn't recorded.`);
  }
  return { hash, manifest, problems };
}
