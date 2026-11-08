import { readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Refused } from "@agentorg/sdk";
import { BuildError, buildPackage } from "@agentorg/sdk/build";

/** What a package's source may total, paths and text: it fits in one frame. */
export const MAX_SOURCE = 768 * 1024;
/** Files one package's source may have. */
const MAX_FILES = 256;
/**
 * What a package built by the Hub may import by name: the SDK, the interfaces, zod, and React and
 * the kit for views (`react/jsx-runtime`, which JSX compiles to, is React's).
 */
const ALLOWED = [
  "@agentorg/sdk",
  "@agentorg/interfaces",
  "zod",
  "react",
  "react-dom",
  "@agentorg/kit",
];
/** Where those are found: this package's own folder (dist/src/build.js → the package). */
const FROM = fileURLToPath(new URL("../..", import.meta.url));
/** A source path: `package.json`, or a source file under `src/` named plainly. */
const PATH =
  /^(package\.json|src(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(ts|tsx|mts|js|mjs|jsx|json))$/;
/** Files under `src/` that tools read as configuration: a tsconfig can name any file to read. */
const CONFIG = /(^|\/)(tsconfig|jsconfig|package)\.json$/;
/** At most 16 modules and 16 MiB built; 30 s to bundle each module, 60 s for the whole build. */
const LIMITS = { modules: 16, bytes: 16 * 1024 * 1024, bundleMs: 30_000, totalMs: 60_000 };
/** How long reading one module's definition may take, in a Hub build. */
const DESCRIBE_MS = 5_000;

/**
 * The source as given, checked before anything is written or queued: its paths (no two the same
 * but for case, none both a file and a folder), its size.
 */
export function checkSource(files: unknown): [string, string][] {
  if (typeof files !== "object" || files === null || Array.isArray(files))
    throw new Refused("invalid", "files is an object of path to text.");
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES)
    throw new Refused("invalid", `A package's source is at most ${MAX_FILES} files.`);
  let size = 0;
  const seen = new Set<string>();
  for (const [path, text] of entries) {
    if (path.length > 256 || !PATH.test(path) || (path !== "package.json" && CONFIG.test(path)))
      throw new Refused(
        "invalid",
        `${JSON.stringify(path)}: a package's source is package.json and source files under src/ (.ts, .tsx, .mts, .js, .mjs, .jsx, .json; no tsconfig, jsconfig or package.json there), by plain relative paths.`,
      );
    const lower = path.toLowerCase();
    if (seen.has(lower))
      throw new Refused("invalid", `${path}: another path differs from it only by case.`);
    seen.add(lower);
    if (typeof text !== "string") throw new Refused("invalid", `${path} isn't text.`);
    size += Buffer.byteLength(path) + Buffer.byteLength(text);
  }
  if (size > MAX_SOURCE)
    throw new Refused("invalid", `A package's source is at most ${MAX_SOURCE / 1024} KiB.`);
  if (!entries.some(([path]) => path === "package.json"))
    throw new Refused("invalid", "A package's source has a package.json.");
  for (const lower of seen)
    for (let at = lower.indexOf("/"); at > 0; at = lower.indexOf("/", at + 1))
      if (seen.has(lower.slice(0, at)))
        throw new Refused("invalid", `${lower.slice(0, at)} is both a file and a folder.`);
  return entries;
}

/**
 * A build's message as the caller may see it: the package's own paths relative to it, and the
 * places the Hub knows (its home, its installation) never named. The SDK already tells a place
 * outside the package as <outside>; only known prefixes are replaced here, so what the caller
 * wrote comes back as written.
 */
function told(message: string, source: string, home: string): string {
  return message
    .replaceAll(`${source}/`, "")
    .replaceAll(source, ".")
    .replaceAll(home, "<home>")
    .replaceAll(FROM.replace(/\/$/, ""), "<hub>");
}

/**
 * Build a package from its source, given as data, and add it with `add`: the files are written to
 * a fresh folder in the home, built as `agentorg build` builds (importing by name only the SDK,
 * the interfaces, zod, React, react-dom and the kit, and nothing outside the folder; reading no tsconfig; at most 16
 * modules and 16 MiB built), and the folder is gone after, whatever happened. A build that fails
 * is `Refused("build")` with the build's message, which names no path outside the package.
 */
export async function buildSource<T>(
  home: string,
  entries: [string, string][],
  sandbox: (paths: string[]) => string[],
  add: (file: string) => T,
): Promise<T> {
  const dir = await realpath(await mkdtemp(join(home, "build-")));
  const source = join(dir, "source");
  try {
    let built: Awaited<ReturnType<typeof buildPackage>>;
    try {
      for (const [path, text] of entries) {
        await mkdir(dirname(join(source, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(source, path), text, { mode: 0o600, flag: "wx" });
      }
      built = await buildPackage(source, {
        out: join(dir, "out"),
        packages: { allowed: ALLOWED, from: FROM },
        limits: LIMITS,
        describeTimeoutMs: DESCRIBE_MS,
        // The describer runs the source's code: in the OS sandbox host processes run in.
        describer: { sandbox },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Refused(
        "build",
        told(
          error instanceof BuildError ? message : `The build failed: ${message}`,
          source,
          await realpath(home),
        ),
      );
    }
    return add(built.file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Folders of builds a crash interrupted: removed when the Hub opens. */
export function sweepBuilds(home: string): void {
  for (const name of readdirSync(home))
    if (name.startsWith("build-")) rmSync(join(home, name), { recursive: true, force: true });
}
