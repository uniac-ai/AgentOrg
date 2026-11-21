// The shell's one script, bundled, and the licences of what it and the stylesheet take in from npm.
// The build writes both; the notices' test bundles again, unwritten, to check the notices against it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { build } from "esbuild";

export const at = (path) => new URL(`../${path}`, import.meta.url).pathname;

/** `dist/app.js`, with esbuild's record of every file that went into it. */
export const bundleApp = (options = {}) =>
  build({
    entryPoints: [at("src/main.tsx")],
    outfile: at("dist/app.js"),
    absWorkingDir: at("."),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    // Licence notices (`/*!`, `@license`) are kept, at the end: a file copied in whole under its own
    // licence, as `src/ui/gradual-blur.tsx` is (see NOTICE), ships with its notice.
    legalComments: "eof",
    logLevel: "warning",
    metafile: true,
    ...options,
  });

/** A package's name from a path inside it: the last `node_modules/` the path passes through. */
const PACKAGE = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//;

/** Package `name`'s folder, as Node finds it from `from` up; `by` says what took it in. */
function installed(name, from, by) {
  for (let dir = from; ; dir = dirname(dir)) {
    const folder = join(dir, "node_modules", name);
    if (existsSync(join(folder, "package.json"))) return folder;
    if (dir === dirname(dir)) throw new Error(`${name}, which ${by} takes in, isn't installed.`);
  }
}

/**
 * The npm packages a file of a package was built from, as its source map names them: a package
 * that ships one file made from others, as react-diff-view does, holds them all. None without a map.
 */
function builtFrom(file) {
  const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(file, "utf8").slice(-2000))?.[1];
  if (!url) return [];
  let map;
  if (url.startsWith("data:")) {
    const data = url.slice(url.indexOf(",") + 1);
    map = /;base64,/.test(url)
      ? Buffer.from(data, "base64").toString("utf8")
      : decodeURIComponent(data);
  } else if (existsSync(join(dirname(file), url)))
    map = readFileSync(join(dirname(file), url), "utf8");
  else return [];
  return (JSON.parse(map).sources ?? []).flatMap((source) => PACKAGE.exec(source)?.[2] ?? []);
}

/** The npm packages the script holds, by folder: each file's own, and those that file was built from. */
export function scriptPackages(metafile) {
  const folders = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // A file a package's `browser` field turns off, "(disabled):…", is not in the script.
    const match = input.startsWith("(") ? null : PACKAGE.exec(input);
    if (!match) continue;
    const folder = resolve(at("."), match[1]);
    folders.add(folder);
    for (const name of builtFrom(resolve(at("."), input)))
      folders.add(installed(name, folder, match[2]));
  }
  return folders;
}

/**
 * The npm packages the stylesheet takes in whole: each one `src/styles.css` imports, found as
 * Tailwind finds it, from the shell's folder up. A line that takes in more some other way, a plugin
 * or an import not read here, is refused, so nothing it brings goes unlisted.
 */
export function stylesheetPackages() {
  const folders = new Set();
  for (const [line] of readFileSync(at("src/styles.css"), "utf8").matchAll(
    /^@(import|plugin)\b.*$/gm,
  )) {
    const spec = /^@import\s+(?:url\()?["']([^"']+)["']/.exec(line)?.[1];
    if (!spec) throw new Error(`src/styles.css takes in what this can't list: ${line}`);
    if (spec.startsWith(".")) continue;
    const name = spec
      .split("/")
      .slice(0, spec.startsWith("@") ? 2 : 1)
      .join("/");
    folders.add(installed(name, at("."), "src/styles.css"));
  }
  return folders;
}

export const SEPARATOR = `\n${"=".repeat(72)}\n\n`;
/** A package's licence as its package.json gives it, an SPDX expression; old forms included. */
const spdxOf = ({ license, licenses }) => {
  const named = [license ?? licenses]
    .flat()
    .filter(Boolean)
    .map((one) => one.type ?? one);
  return named.length > 0 ? named.join(" OR ") : "UNKNOWN";
};

/**
 * `THIRD_PARTY_LICENSES.txt`, as AgentComputer writes it: one section per package, sorted, headed
 * "name version (licence)", with its licence text and its NOTICE when it has one. A package whose
 * own files hold no licence takes the text kept for it in `licences/<name>.txt`, with where it came
 * from; one with neither is refused, so none ships without its text. An Apache-2.0 package whose
 * file is only the licence's short header gets the licence in full after it, `licences/Apache-2.0.txt`.
 */
export function thirdPartyLicenses(folders) {
  const sections = new Map();
  for (const folder of folders) {
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    // Every licence file and NOTICE it has, as files: one under two licences may ship both.
    const files = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(folder, entry.name));
    const named = (pattern) => files.filter((file) => pattern.test(basename(file)));
    const kept = at(`licences/${manifest.name}.txt`);
    const licences = named(/^(licen[cs]e|copying)/i);
    if (licences.length === 0 && existsSync(kept)) licences.push(kept);
    if (licences.length === 0)
      throw new Error(
        `${manifest.name} ${manifest.version} has no licence file in ${folder}, and none is kept in licences/.`,
      );
    const spdx = spdxOf(manifest);
    const read = (path) => readFileSync(path, "utf8").trim();
    const header =
      spdx === "Apache-2.0" && !licences.some((file) => /TERMS AND CONDITIONS/.test(read(file)));
    const text = [
      ...licences,
      ...(header ? [at("licences/Apache-2.0.txt")] : []),
      ...named(/^notice/i),
    ]
      .map(read)
      .join("\n\n");
    const head = `${manifest.name} ${manifest.version} (${spdx})`;
    sections.set(head, `${head}\n\n${text}\n`);
  }
  return [...sections]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, section]) => section)
    .join(SEPARATOR);
}
