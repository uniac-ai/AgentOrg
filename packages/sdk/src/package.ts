import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import type { ModuleDescription } from "./describe.js";
import { compareInterfaces, type DescribedInterface } from "./interface.js";
import {
  checkManifest,
  FORMAT,
  type Manifest,
  type ManifestInterface,
  type ManifestModule,
  treeHash,
  type Verified,
  verifyArchive,
} from "./manifest.js";
import { writeTar } from "./tar.js";

/** What a package's `package.json` says under `agentorg`. */
interface Config {
  modules: Record<string, string>;
  connections?: [string, string][];
  /** Initial state for state slots, keyed by `"module.slot"`. */
  seed?: Record<string, unknown>;
}

export interface Built {
  manifest: Manifest;
  /** SHA-256 over the canonical file tree: what a composition pins and grants follow. */
  hash: string;
  /** The tree, exactly what is hashed: `agentorg.json` and `dist/`. */
  dir: string;
  /** The `.agentorg` archive of the tree, named by the hash, beside it. */
  file: string;
}

export interface BuildOptions {
  /** Where the build goes, replaced each time: `package/` holds the tree, beside its archive. */
  out?: string;
  /** How long reading one module's definition may take. */
  describeTimeoutMs?: number;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;

/** A build that can't go on: the message says what to fix. */
export class BuildError extends Error {
  override readonly name = "BuildError";
}

/** Whether `inner` is `outer` or inside it. */
const within = (inner: string, outer: string) => {
  const path = relative(outer, inner);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/**
 * Build a package: bundle each module with every library into one ESM file, read each module's
 * definition from its code, write `agentorg.json`, hash the tree, and archive it as
 * `<hash>.agentorg`. The output folder (default `<dir>/agentorg-build`) is replaced.
 */
export async function buildPackage(dir: string, options: BuildOptions = {}): Promise<Built> {
  const root = resolve(dir);
  const out = resolve(options.out ?? join(root, "agentorg-build"));
  if (within(root, out))
    throw new BuildError(`The output folder ${out} holds the package itself; choose another.`);
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

  const files = new Map<string, Uint8Array>();
  const described: Record<string, ModuleDescription> = {};
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "agentorg-build-")));
  try {
    for (const [name, entry] of Object.entries(config.modules)) {
      files.set(`dist/${name}.js`, await bundle(root, { entryPoints: [join(root, entry)] }));
      // The definition is read by running the module's code, so the describer is bundled with it
      // and shares its SDK and zod.
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
      described[name] = await describeInChild(
        scratch,
        name,
        describer,
        options.describeTimeoutMs ?? 30_000,
      );
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
  const manifest: Manifest = {
    format: FORMAT,
    name: pkg.name,
    version: pkg.version,
    ...(pkg.description ? { description: pkg.description } : {}),
    modules,
    interfaces: Object.fromEntries(Object.entries(interfaces).sort(([a], [b]) => (a < b ? -1 : 1))),
    connections: config.connections ?? [],
    seed: config.seed ?? null,
  };
  const problems = checkManifest(manifest);
  if (problems.length) throw new BuildError(problems.join("\n"));

  files.set("agentorg.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const hash = treeHash(files);
  const tree = join(out, "package");
  await rm(out, { recursive: true, force: true });
  await mkdir(join(tree, "dist"), { recursive: true });
  for (const [path, data] of files) await writeFile(join(tree, path), data);
  const file = join(out, `${hash}.agentorg`);
  await writeFile(file, writeTar(files));
  return { manifest, hash, dir: tree, file };
}

/**
 * One ESM file holding the entry and every library it uses: no runtime imports and no Node
 * built-ins. Whitespace and comments are dropped, since esbuild's comments name each file's path
 * and would make the hash depend on where the package sits.
 */
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
      minifyWhitespace: true,
      legalComments: "none",
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

const MARK = "agentorg-describe:";
/**
 * Run before the module in the describer's process. No Node built-in can be imported, the ways
 * around that are gone, and so are the network globals. Node's permission model already stops
 * reads outside the scratch folder, writes, processes and workers, but it has no network control.
 */
const PRELOAD = `import { isBuiltin, registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (isBuiltin(specifier)) throw new Error(specifier + " is not available at a module's top level");
    return next(specifier, context);
  },
});
for (const [owner, names] of [
  [globalThis, ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]],
  [process, ["getBuiltinModule", "binding", "_linkedBinding", "dlopen"]],
])
  for (const name of names)
    Object.defineProperty(owner, name, {
      configurable: false,
      get() {
        throw new Error(name + " is not available at a module's top level");
      },
    });
`;
const RUNNER = `let result;
try {
  result = { described: (await import(process.argv[2])).default };
} catch (error) {
  result = { error: String(error && error.stack ? error.name + ": " + error.message : error) };
}
process.stdout.write("\\n${MARK}" + JSON.stringify(result) + "\\n", () => process.exit(0));
`;

/**
 * Run a module's describer in a child Node process under the permission model: it reads only the
 * scratch folder, writes nothing, starts no processes or workers, and can reach no network. A top
 * level that does I/O or touches DOM globals fails there, and the build says why.
 */
async function describeInChild(
  scratch: string,
  name: string,
  describer: Uint8Array,
  timeoutMs: number,
): Promise<ModuleDescription> {
  const files = { preload: join(scratch, "preload.mjs"), runner: join(scratch, "runner.mjs") };
  await writeFile(files.preload, PRELOAD);
  await writeFile(files.runner, RUNNER);
  const target = join(scratch, `${name}.mjs`);
  await writeFile(target, describer);
  let timedOut = false;
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
        pathToFileURL(files.preload).href,
        files.runner,
        pathToFileURL(target).href,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {},
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // SIGKILL, since a module's top level can ignore SIGTERM.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
  if (timedOut)
    throw new BuildError(
      `Module ${name}: reading its definition took over ${timeoutMs} ms. A module's top level must only define; do work in start().`,
    );
  // A module's own output may come first. JSON holds no raw newline, so the result is the text
  // after the last newline-led marker.
  const at = stdout.lastIndexOf(`\n${MARK}`);
  let result: { described?: ModuleDescription; error?: string } | undefined;
  try {
    result = at < 0 ? undefined : JSON.parse(stdout.slice(at + MARK.length + 1));
  } catch {
    result = undefined;
  }
  if (!result)
    throw new BuildError(
      `Module ${name}: its definition couldn't be read (exit ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`,
    );
  if (result.error || !result.described)
    throw new BuildError(
      `Module ${name}: its top level failed while its definition was read: ${result.error}. A module's top level must not do I/O or touch DOM globals; do that work in start().`,
    );
  return result.described;
}

/**
 * Check a `.agentorg` file against its expected hash, by default the one in its file name. See
 * `verifyArchive` (`@agentorg/sdk/manifest`) for the same check on bytes.
 */
export async function verifyPackage(file: string, expected?: string): Promise<Verified> {
  const want = expected ?? /(sha256-[0-9a-f]{64})\.agentorg$/.exec(file)?.[1];
  if (!want)
    return {
      ok: false,
      problems: ["No expected hash: pass one, or keep the file named by its hash."],
    };
  return verifyArchive(new Uint8Array(await readFile(file)), want);
}
