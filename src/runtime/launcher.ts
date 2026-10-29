/** Pinned executable launchers, named by the package's bin map, independent of the starter's PATH. */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, home } from "../home.ts";

export const PACKAGE = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
    version: string;
    bin: Record<string, string>;
  };

const KEPT = ["AGENTORG_PORT", "AGENTORG_WEB_PORT", "AGENTORG_URL"];
export const MINIMUM_NODE_TEXT = "22.13";

export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export const launcherPath = (program: string) => join(home(), "bin", program);

/** Prefer a PATH entry pointing to this Node, which can outlive a version-manager upgrade. */
export function nodePath(): string {
  const running = realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "node");
    try {
      if (realpathSync(candidate) === running) return candidate;
    } catch {}
  }
  return process.execPath;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const unquote = (text: string) => text.replaceAll("'\\''", "'");
const EXEC = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' "\$@"$/m;

export function launcherText(program: string): string {
  const entry = manifest(PACKAGE).bin[program];
  if (entry === undefined) throw new Error(`this package has no executable ${program}`);
  const environment = [
    ["AGENTORG_HOME", home()],
    ...KEPT.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  ] as [string, string][];
  return [
    "#!/bin/sh",
    `# Pinned ${program} executable and environment.`,
    ...environment.map(
      ([name, value]) => `[ -n "$${name}" ] || ${name}=${quote(value)}; export ${name}`,
    ),
    `exec ${quote(nodePath())} ${quote(join(PACKAGE, entry))} "$@"`,
    "",
  ].join("\n");
}

export function writeLauncher(program: string): string {
  if (!nodeSupported(process.versions.node)) {
    throw new Error(
      "AgentOrg needs Node " +
        MINIMUM_NODE_TEXT +
        " or later, and this is " +
        process.versions.node +
        "; run this command with a newer Node",
    );
  }
  const path = launcherPath(program);
  ensureHome();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, launcherText(program), { mode: 0o755 });
  return path;
}

export interface Pinned {
  node: string;
  package: string;
  program: string | undefined;
  version: string | undefined;
}

export function readLauncher(program: string): Pinned | undefined {
  const path = launcherPath(program);
  if (!existsSync(path)) return undefined;
  const found = EXEC.exec(readFileSync(path, "utf8"));
  if (!found?.[1] || !found[2]) return undefined;
  const entry = unquote(found[2]);
  for (let folder = dirname(entry); folder !== dirname(folder); folder = dirname(folder)) {
    if (!existsSync(join(folder, "package.json"))) continue;
    const pkg = manifest(folder);
    return {
      node: unquote(found[1]),
      package: folder,
      program: Object.entries(pkg.bin ?? {}).find(
        ([, path]) => resolve(folder, path) === entry,
      )?.[0],
      version: pkg.version,
    };
  }
  return {
    node: unquote(found[1]),
    package: dirname(entry),
    program: undefined,
    version: undefined,
  };
}

export function launcherCurrent(program: string, pinned: Pinned | undefined): boolean {
  return (
    pinned !== undefined &&
    pinned.package === PACKAGE &&
    pinned.program === program &&
    existsSync(pinned.node)
  );
}
