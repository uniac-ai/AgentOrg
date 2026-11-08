import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BuildOptions as EsbuildOptions,
  context as esbuildContext,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
  type ResolveResult,
} from "esbuild";
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
  /**
   * What the package's own files may import by name: only these packages (and their subpaths),
   * found from `from`, and nothing outside the package's folder by path. The libraries resolve
   * their own imports as usual. Without it, imports resolve from the package's folder as Node's do.
   */
  packages?: { allowed: string[]; from: string };
  /**
   * At most this many modules and bytes of output; each bundling cancelled past `bundleMs`, and
   * the whole build refused past `totalMs`.
   */
  limits?: { modules: number; bytes: number; bundleMs: number; totalMs: number };
  /**
   * How a module's describer runs. `sandbox` gives the OS sandbox command put before `node …`
   * for a process that may read `paths`: the Hub runs untrusted source there, as it runs host
   * processes. `preload: false` drops the in-process closing of built-ins and network globals;
   * it is only for testing that the sandbox holds without it.
   */
  describer?: { sandbox?: (paths: string[]) => string[]; preload?: boolean };
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

  // A limited build's modules are its own files too.
  if (options.packages)
    for (const [name, entry] of Object.entries(config.modules))
      if (!within(resolve(root, entry), root))
        throw new BuildError(`Module ${name}'s entry ${entry} is outside the package's folder.`);
  const limits = options.limits;
  if (limits && Object.keys(config.modules).length > limits.modules)
    throw new BuildError(`A package has at most ${limits.modules} modules.`);
  let bytes = 0;
  const deadline = limits ? Date.now() + limits.totalMs : Number.POSITIVE_INFINITY;
  /** The time a step may take: its own limit, within what's left of the build's. */
  const inTime = (ms: number) => {
    const left = deadline - Date.now();
    if (left <= 0)
      throw new BuildError(`A build takes at most ${(limits?.totalMs ?? 0) / 1000} s.`);
    return Math.min(ms, left);
  };
  const bundleMs = limits?.bundleMs ?? 30_000;
  const limited = () => options.packages && { ...options.packages, bundleMs: inTime(bundleMs) };
  const files = new Map<string, Uint8Array>();
  const described: Record<string, ModuleDescription> = {};
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "agentorg-build-")));
  try {
    for (const [name, entry] of Object.entries(config.modules)) {
      const code = await bundle(root, { entryPoints: [join(root, entry)] }, limited());
      bytes += code.byteLength;
      if (limits && bytes > limits.bytes)
        throw new BuildError(
          `A package's modules are at most ${limits.bytes / 1024 / 1024} MiB built.`,
        );
      files.set(`dist/${name}.js`, code);
      // The definition is read by running the module's code, so the describer is bundled with it
      // and shares its SDK and zod.
      const describer = await bundle(
        root,
        {
          stdin: {
            contents: [
              `import definition from ${JSON.stringify(join(root, entry))};`,
              `import { describeModule } from "@agentorg/sdk/describe";`,
              "export default describeModule(definition);",
            ].join("\n"),
            resolveDir: root,
            sourcefile: `describe-${name}.js`,
          },
        },
        limited(),
      );
      described[name] = await describeInChild(
        scratch,
        name,
        describer,
        inTime(options.describeTimeoutMs ?? 30_000),
        options.describer ?? {},
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
  input: Pick<EsbuildOptions, "entryPoints" | "stdin">,
  packages?: BuildOptions["packages"] & { bundleMs: number },
): Promise<Uint8Array> {
  const loadable = new Set<string>();
  let ctx: Awaited<ReturnType<typeof esbuildContext>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    ctx = await esbuildContext({
      ...input,
      // A limited build reads no tsconfig or jsconfig (one could name any file to read), and
      // loads only what its plugin resolved.
      ...(packages
        ? { plugins: [limitImports(root, packages, loadable)], tsconfigRaw: "{}", metafile: true }
        : { plugins: [libraryNames(root)] }),
      absWorkingDir: root,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["import", "module", "default"],
      target: "es2023",
      // A view may be written in JSX with React (the kit's components): the automatic runtime,
      // so no file needs React in scope, and React's production build, since a frame has no
      // `process` for React to read its mode from.
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      minifyWhitespace: true,
      legalComments: "none",
      write: false,
      logLevel: "silent",
    });
    const running = ctx.rebuild();
    const result = packages
      ? await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void ctx?.cancel();
              reject(
                new BuildError(`Bundling a module takes at most ${packages.bundleMs / 1000} s.`),
              );
            }, packages.bundleMs);
          }),
        ])
      : await running;
    // Everything in the bundle was resolved by the plugin, or is the describer's stdin.
    const input_ = input;
    if (packages)
      for (const input of Object.keys(result.metafile?.inputs ?? {}))
        if (
          input !== (input_.stdin?.sourcefile ?? "<stdin>") &&
          !loadable.has(input) &&
          !loadable.has(resolve(root, input))
        )
          throw new BuildError("The bundle reached a file the package didn't import.");
    return (
      ((result.outputFiles ?? []) as { contents: Uint8Array }[])[0]?.contents ?? new Uint8Array()
    );
  } catch (error) {
    if (error instanceof BuildError) throw error;
    const errors = (
      error as { errors?: { text: string; location?: { file: string; line: number } }[] }
    ).errors;
    /** A place in the package by its relative path; anywhere else isn't told. */
    const place = (file: string) =>
      !packages || (!file.startsWith("..") && !isAbsolute(file)) ? file : "<outside>";
    throw new BuildError(
      errors?.length
        ? errors
            .map(
              (e) =>
                `${e.location ? `${place(e.location.file)}:${e.location.line}: ` : ""}${packages ? e.text.replaceAll(`${root}/`, "") : e.text}`,
            )
            .join("\n")
        : String(error),
    );
  } finally {
    clearTimeout(timer);
    await ctx?.dispose();
  }
}

/** The package a bare import names: `zod`, `@agentorg/sdk` (from `@agentorg/sdk/describe`). */
const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** Whether `path` is inside the installed package `name`: a folder above it is that package's. */
function inPackage(path: string, name: string): boolean {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === name) return true;
    } catch {
      // No package.json here, or not one to read.
    }
    if (dirname(dir) === dir) return false;
  }
}

/** The namespace a library's files are bundled under, by `libraryName`. */
const LIBRARY = "agentorg-library";

/**
 * A library's file as the bundle names it: its package's name and version and its path in that
 * package, never where it is installed. esbuild names each CommonJS module it wraps by its path
 * from the build's folder, which for an installed library spells out the machine's folders and
 * changes with them: React's, for one, would carry the builder's home into every package built
 * with it. Undefined for a file in no named, versioned package.
 */
function libraryName(path: string): string | undefined {
  for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
    let manifest: { name?: unknown; version?: unknown } | undefined;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      // No package.json here, or not one to read.
    }
    if (typeof manifest?.name === "string" && typeof manifest.version === "string")
      return `${manifest.name}@${manifest.version}/${relative(dir, path).split(sep).join("/")}`;
  }
  return undefined;
}

/** Where a resolved file goes in the bundle: the package's own by its path, a library's by name. */
function placed(found: ResolveResult, root: string): OnResolveResult {
  const result = { path: found.path, namespace: found.namespace, external: found.external };
  if (found.namespace !== "file" || found.external || within(found.path, root)) return result;
  const name = libraryName(found.path);
  if (!name) return result;
  return {
    path: name,
    namespace: LIBRARY,
    pluginData: { file: found.path },
    sideEffects: found.sideEffects,
  };
}

/** Load a library's file named by `placed`, from where it is, its imports resolved from there. */
function loadLibraries(build: PluginBuild) {
  build.onLoad({ filter: /.*/, namespace: LIBRARY }, async (args) => {
    const { file } = args.pluginData as { file: string };
    return { contents: await readFile(file), loader: "default", resolveDir: dirname(file) };
  });
}

/** An unlimited build's resolution, as esbuild's own, with its libraries named by `placed`. */
function libraryNames(root: string): Plugin {
  const SKIP = Symbol("resolving");
  return {
    name: "agentorg-library-names",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as { [SKIP]?: boolean } | undefined)?.[SKIP]) return undefined;
        const found = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          pluginData: { [SKIP]: true },
        });
        if (found.errors.length) return { errors: found.errors };
        return placed(found, root);
      });
      loadLibraries(build);
    },
  };
}

/**
 * Imports from the package's own files (and its module entries): by name, only an allowed
 * package, found from `from`, and only a file inside it; by relative path, only inside the
 * package's folder, checked as text before anything is looked up; never by absolute path. A
 * library's own imports are its business.
 */
function limitImports(
  root: string,
  packages: { allowed: string[]; from: string },
  loadable: Set<string>,
): Plugin {
  const allowed = new Set(packages.allowed);
  const SKIP = Symbol("resolving");
  const refuse = (text: string) => ({ errors: [{ text }] });
  return {
    name: "agentorg-limit-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as { [SKIP]?: boolean } | undefined)?.[SKIP]) return undefined;
        const entry = args.kind === "entry-point";
        // The describer's stdin and the package's own files; not the libraries'.
        const ours =
          entry ||
          args.importer === "" ||
          args.importer.startsWith("<stdin>") ||
          within(args.importer, root);
        const relativePath = args.path.startsWith(".");
        const bare = !entry && !relativePath && !isAbsolute(args.path);
        if (ours) {
          // An absolute path (a module's entry, the describer's import of it) only into the
          // folder, checked as text, so nothing outside is ever looked up.
          if ((entry || isAbsolute(args.path)) && !within(args.path, root))
            return refuse(
              entry
                ? "A module's entry is outside the package's folder."
                : `${args.path}: an import leaves the package's folder.`,
            );
          if (bare && !allowed.has(packageOf(args.path)))
            return refuse(
              `${args.path}: a package built by the Hub imports only ${[...allowed].join(", ")}.`,
            );
          if (relativePath && !within(resolve(args.resolveDir, args.path), root))
            return refuse(`${args.path}: an import leaves the package's folder.`);
        }
        const found = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: ours && bare ? packages.from : args.resolveDir,
          importer: args.importer,
          pluginData: { [SKIP]: true },
        });
        if (found.errors.length) return { errors: found.errors };
        if (
          ours &&
          (bare ? !inPackage(found.path, packageOf(args.path)) : !within(found.path, root))
        )
          return refuse(
            `${args.path}: an import leaves ${bare ? "its package" : "the package's folder"}.`,
          );
        // A library's own import is its business, but only what was resolved here is loaded.
        if (found.namespace === "file") loadable.add(found.path);
        const result = placed(found, root);
        // The bundle's inputs name a library's file by its library name: that is loadable too.
        if (result.namespace === LIBRARY) loadable.add(`${LIBRARY}:${result.path}`);
        return result;
      });
      // A file esbuild found any other way (a pattern in a template-string import or require
      // matches files without resolving them) is never read.
      loadLibraries(build);
      build.onLoad({ filter: /.*/ }, (args) =>
        args.namespace !== "file" || loadable.has(args.path)
          ? undefined
          : refuse(
              "A pattern import (a template string in import() or require()) isn't built: import each file by its own path.",
            ),
      );
    },
  };
}

const MARK = "agentorg-describe:";
/**
 * What a process and the processes it started hold resident, in bytes: under a sandbox, the
 * describer's node is a child of the sandbox's process. 0 where it can't be told (Windows).
 */
async function residentBytes(pid: number): Promise<number> {
  if (process.platform === "linux") {
    let total = 0;
    const visit = (id: number) => {
      try {
        total += Number(readFileSync(`/proc/${id}/statm`, "utf8").split(" ")[1]) * 4096;
        for (const child of readFileSync(`/proc/${id}/task/${id}/children`, "utf8").split(" "))
          if (child.trim()) visit(Number(child));
      } catch {
        // Gone, or not to be read.
      }
    };
    visit(pid);
    return total;
  }
  if (process.platform === "win32") return 0;
  // macOS: sandbox-exec becomes the node it runs, so the process is the describer.
  return new Promise((resolve) =>
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, out) =>
      resolve(error ? 0 : Number(out.trim()) * 1024),
    ),
  );
}
/**
 * What a module's describer may hold resident, all of it. A describer only defines, so it needs
 * little; macOS compresses idle pages, so what it really holds can be about twice this.
 */
const MAX_DESCRIBER_MEMORY = 512 * 1024 * 1024;
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
  // And what describes the host: its paths, its command line, its report.
  [process, ["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "report", "execPath", "argv", "execArgv", "title"]],
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
  result = { described: (await import("./module.mjs")).default };
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
  how: NonNullable<BuildOptions["describer"]>,
): Promise<ModuleDescription> {
  const files = { preload: join(scratch, "preload.mjs"), runner: join(scratch, "runner.mjs") };
  await writeFile(files.preload, PRELOAD);
  await writeFile(files.runner, RUNNER);
  // The module is beside the runner by a fixed name: the runner can't read its own argv.
  const target = join(scratch, "module.mjs");
  await writeFile(target, describer);
  let timedOut = false;
  let tooBig = false;
  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((done, fail) => {
    const node = [
      process.execPath,
      "--permission",
      "--max-old-space-size=256",
      `--allow-fs-read=${scratch}`,
      ...(how.preload === false ? [] : ["--import", pathToFileURL(files.preload).href]),
      files.runner,
    ];
    const [command, ...args] = [...(how.sandbox?.([scratch]) ?? []), ...node] as [
      string,
      ...string[],
    ];
    const child = spawn(command, args, {
      cwd: scratch,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {},
    });
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
    // Its heap is capped by V8, but not what it allocates outside it (ArrayBuffers): its memory
    // is watched, and past the cap it is stopped.
    const watch = setInterval(() => {
      if (child.pid === undefined) return;
      void residentBytes(child.pid).then((bytes) => {
        if (bytes > MAX_DESCRIBER_MEMORY) {
          tooBig = true;
          child.kill("SIGKILL");
        }
      });
    }, 200);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      done({ code, stdout, stderr });
    });
  });
  if (tooBig)
    throw new BuildError(
      `Module ${name}: reading its definition took over ${MAX_DESCRIBER_MEMORY / 1024 / 1024} MiB of memory. A module's top level must only define; do work in start().`,
    );
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
      `Module ${name}: its definition couldn't be read (exit ${code}). ${stderr.trim().split("\n").slice(-3).join(" ").replaceAll(scratch, "<describer>")}`,
    );
  if (result.error || !result.described)
    throw new BuildError(
      `Module ${name}: its top level failed while its definition was read: ${String(result.error).replaceAll(scratch, "<describer>")}. A module's top level must not do I/O or touch DOM globals; do that work in start().`,
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
