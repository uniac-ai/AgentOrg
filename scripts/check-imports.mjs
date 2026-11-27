#!/usr/bin/env node
// Fails on an import from one of AgentOrg's modules into another. scripts/modules.json puts each
// source file under packages/ in a module, by the longest path that matches. A file may take its
// own module and core, core takes only core, and all-in-one takes anything. Each crossing there is
// today is listed there by file, so the lists only shrink: a crossing that isn't listed fails, and
// so does a listed one that no longer happens.
// A reference is a string literal in code: the specifier of an import, export, import() or
// require(); an @agentorg/ name, held in a variable or resolved too; or a path that goes up with
// ../ into a workspace's folder, named by its path under packages/ or its own name (a path joined
// from separate pieces isn't seen). A package that is neither a workspace here nor one of the map's
// outside names isn't judged. A crossing goes on the tests-and-scripts list when its file is in its
// workspace's test/ or scripts/, and on the src list otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = posix.join(posix.dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(posix.join(ROOT, path), "utf8");
const WORKSPACES = JSON.parse(read("package.json")).workspaces;
const NAMED = /^@agentorg\/[\w.-]+(\/\S*)?$/;

/**
 * Each name a path up from a sibling may give a workspace's folder, with the folder: its path under
 * packages/ (`coordinator/mcp`) and its own name (`mcp`), by which a neighbour in the same group
 * reaches it (`../../mcp/`). No two workspaces may share their own name.
 */
export function folders(workspaces) {
  const named = new Map();
  for (const dir of workspaces) {
    const name = posix.basename(dir);
    if (named.has(name))
      throw new Error(
        `The workspaces ${named.get(name)} and ${dir} are both named ${name}, so a path up into ` +
          "one can't be told from one into the other: rename one",
      );
    named.set(name, dir);
  }
  return new Map([...workspaces.map((dir) => [posix.relative("packages", dir), dir]), ...named]);
}
const FOLDERS = folders(WORKSPACES);
// A path into a workspace's folder from a sibling's: one or more ../, the folder's name, a /. The
// longest names are tried first.
const NAMES = [...FOLDERS.keys()].sort((a, b) => b.length - a.length);
const SIBLING = new RegExp(`(?:^|[^\\w.])(?:\\.\\./)+(${NAMES.join("|")})/(\\S*)`);
const SOURCE = /^packages\/[^/]+\/(?!(.*\/)?(dist|node_modules)\/).*\.(ts|tsx|mts|js|mjs|cjs)$/;
// The tokens after which a `/` starts a regular expression rather than a division.
const BEFORE_REGEX = new Set([
  "",
  ..."(,=:[!&|?{};+-*%~^>",
  ..."return typeof case do else in of new delete void throw instanceof yield await".split(" "),
]);

/**
 * Each string literal in a source's code, outside its comments, with its line and whether it is the
 * specifier of an import, export, import() or require(). A template literal is one only without
 * `${}`; the code inside a `${}` is read as code.
 */
export function literals(source) {
  const found = [];
  const last = ["", ""]; // the last two tokens of code
  const braces = []; // for each template open around the code, the braces open in its `${}`
  let line = 1;
  let i = 0;
  const token = (text) => last.splice(0, 2, last[1], text);
  // Read from i up to the first of `ends`, past escapes if asked; a quoted string stops at a newline.
  const upTo = (ends, escapes, quoted) => {
    let text = "";
    while (i < source.length && !ends.some((end) => source.startsWith(end, i))) {
      if (source[i] === "\n" && quoted) return undefined;
      if (source[i] === "\\" && escapes) i++;
      if (source[i] === "\n") line++;
      text += source[i++] ?? "";
    }
    return text;
  };
  while (i < source.length) {
    const c = source[i];
    const at = line;
    if (source.startsWith("//", i)) upTo(["\n"], false, false);
    else if (source.startsWith("/*", i)) {
      upTo(["*/"], false, false);
      i += 2;
    } else if (c === '"' || c === "'" || c === "`" || (c === "}" && braces.at(-1) === 0)) {
      const template = c === "`" || c === "}";
      if (c === "}") braces.pop();
      i++;
      const text = template ? upTo(["`", "${"], true, false) : upTo([c], true, true);
      const open = template && source.startsWith("${", i);
      if (open) braces.push(0);
      // A quote cut by its line's end (an apostrophe in JSX text) isn't a string.
      if (text !== undefined && !open && c !== "}") {
        const [before, previous] = last;
        const call = previous === "(" && (before === "import" || before === "require");
        found.push({
          text,
          line: at,
          specifier: previous === "from" || previous === "import" || call,
        });
      }
      if (text !== undefined) i += open ? 2 : 1;
      token(open ? "{" : '"');
    } else if (c === "/" && BEFORE_REGEX.has(last[1])) {
      // A regular expression: it ends on its line, at a `/` outside a character class.
      for (let inClass = false; ++i < source.length && source[i] !== "\n"; ) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[" || source[i] === "]") inClass = source[i] === "[";
        else if (source[i] === "/" && !inClass) break;
      }
      if (source[i] === "/") i++;
      while (/[a-z]/i.test(source[i] ?? "")) i++;
      token("/");
    } else if (/[\w$]/.test(c)) {
      const word = /[\w$]+/y;
      word.lastIndex = i;
      token(word.exec(source)[0]);
      i = word.lastIndex;
    } else {
      if (c === "\n") line++;
      if (braces.length && c === "{") braces[braces.length - 1]++;
      if (braces.length && c === "}") braces[braces.length - 1]--;
      if (!/\s/.test(c)) token(c);
      i++;
    }
  }
  return found;
}

/** Whether a literal is a reference: any import's specifier, an @agentorg/ name, a sibling's path. */
export const isReference = ({ text, specifier }) =>
  specifier || NAMED.test(text) || SIBLING.test(text);

/** The folder of the workspace a sibling's path goes up into, and the path inside it it names. */
export function siblingOf(text) {
  const found = SIBLING.exec(text);
  if (!found) return undefined;
  const dir = FOLDERS.get(found[1]);
  return { dir, path: posix.join(dir, found[2]) };
}

const LISTS = ["crossings in src", "crossings in tests and scripts"];
/**
 * The list a file's crossing goes on: tests and scripts for a file in its workspace's test/ or
 * scripts/, its workspace being the longest of the workspaces' folders that holds it.
 */
export function listOf(file) {
  const [dir] = WORKSPACES.filter((one) => file.startsWith(`${one}/`)).sort(
    (a, b) => b.length - a.length,
  );
  return LISTS[dir !== undefined && /^(test|scripts)\//.test(file.slice(dir.length + 1)) ? 1 : 0];
}

function check() {
  const map = JSON.parse(read("scripts/modules.json"));
  const ls = execFileSync("git", ["ls-files", "-z", "packages"], { cwd: ROOT, encoding: "utf8" });
  const tracked = new Set(ls.split("\0"));
  const files = [...tracked].filter((file) => SOURCE.test(file)).sort();
  const paths = Object.entries(map.modules).flatMap(([module, list]) =>
    list.map((path) => [path, module]),
  );
  const moduleOf = (file) =>
    paths
      .filter(([path]) => file === path || file.startsWith(`${path}/`))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  const workspaces = new Map(
    WORKSPACES.map((dir) => {
      const { name, exports } = JSON.parse(read(`${dir}/package.json`));
      return [name, { dir, exports: typeof exports === "string" ? { ".": exports } : exports }];
    }),
  );
  const firstTracked = (candidates) => candidates.find((path) => tracked.has(path));
  const exported = (entry) =>
    typeof entry === "string" || entry === undefined
      ? entry
      : exported(entry.default ?? entry.import ?? entry.node ?? entry.types);
  // The path a reference names, or { module }, or undefined for a package that isn't judged.
  const target = (file, { text: specifier, specifier: imported }) => {
    const sibling = !imported && !NAMED.test(specifier) && siblingOf(specifier);
    if (sibling) return moduleOf(sibling.path) ? sibling.path : sibling.dir;
    if (specifier.startsWith(".")) {
      const path = posix.join(posix.dirname(file), specifier);
      const bare = path.replace(/\.[mc]?js$/, "");
      const options = [path, `${bare}.ts`, `${bare}.tsx`, `${path}.ts`, `${path}/index.ts`];
      return firstTracked(options) ?? path;
    }
    const parts = specifier.split("/");
    const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (map["outside names"][name]) return { module: map["outside names"][name] };
    const workspace = workspaces.get(name);
    if (!workspace) return undefined;
    const subpath = [".", ...parts.slice(name.split("/").length)].join("/");
    const entry = exported(workspace.exports?.[subpath]);
    if (!entry) return workspace.dir;
    const built = posix.join(workspace.dir, entry);
    const bare = built.replace(/\/dist\//, "/").replace(/\.(d\.ts|[mc]?js)$/, "");
    return firstTracked([`${bare}.ts`, `${bare}.tsx`, built]) ?? workspace.dir;
  };

  const problems = [];
  const taken = new Map(); // file → the modules it wrongly takes
  for (const file of files) {
    const from = moduleOf(file);
    if (!from) problems.push(`${file} is in no module (every file belongs to a module)`);
    for (const reference of from ? literals(read(file)).filter(isReference) : []) {
      const { text, line } = reference;
      const found = target(file, reference);
      if (found === undefined) continue;
      const to = typeof found === "string" ? moduleOf(found) : found.module;
      if (!to) problems.push(`${file}:${line} takes ${text}, which is in no module`);
      if (!to || to === from || to === "core" || from === "all-in-one") continue;
      taken.set(file, new Set([...(taken.get(file) ?? []), to]));
      if (!map[listOf(file)][file]?.[to])
        problems.push(`${file}:${line} takes ${text} (${from} → ${to})`);
    }
  }
  for (const list of LISTS)
    for (const [file, modules] of Object.entries(map[list]))
      for (const module of Object.keys(modules))
        if (!taken.get(file)?.has(module) || listOf(file) !== list)
          problems.push(
            `${file} → ${module} no longer happens: remove it from scripts/modules.json "${list}"`,
          );

  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  const [src, rest] = LISTS.map((list) =>
    Object.values(map[list]).reduce((sum, modules) => sum + Object.keys(modules).length, 0),
  );
  console.log(
    `imports: ${files.length} files; ${src} crossings in src, ${rest} in tests and scripts; none new`,
  );
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === self) check();
