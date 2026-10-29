/**
 * The launcher, `<home>/bin/agentorg`: a shell script that runs this package's command on the Node
 * that wrote it, with the home and the addresses it was set up with. The services and every
 * connected project start AgentOrg through it, so none depends on the `PATH` its starter gives it,
 * such as a desktop app's, and writing it again re-pins all of them after an upgrade.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, home } from "../home.ts";

/** This package's folder, three levels above the compiled `dist/src/setup`. */
export const PACKAGE = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

const BIN = join(PACKAGE, "dist", "src", "cli", "bin.js");

/** The variables a launcher keeps from the environment it is written in, besides the home. */
const KEPT = ["AGENTORG_PORT", "AGENTORG_HUMAN_PORT", "AGENTORG_URL"];

const MINIMUM_NODE = [22, 13];

/** Whether a Node version is one AgentOrg runs on, 22.13 or later. */
export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = MINIMUM_NODE;
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

export const MINIMUM_NODE_TEXT = MINIMUM_NODE.join(".");

export function launcherPath(): string {
  return join(home(), "bin", "agentorg");
}

/**
 * The running Node, named by a `PATH` entry that resolves to it where there is one, such as
 * Homebrew's `/opt/homebrew/bin/node`, which outlives an upgrade that moves the file it links to;
 * else by its own path.
 */
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

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const unquote = (text: string) => text.replaceAll(`'\\''`, "'");
const EXEC = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' "\$@"$/m;

export function launcherText(): string {
  const kept = KEPT.filter((name) => process.env[name]).map((name) => [name, process.env[name]]);
  const environment = [["AGENTORG_HOME", home()], ...kept] as [string, string][];
  return [
    "#!/bin/sh",
    "# AgentOrg's launcher. Its services and connected projects start AgentOrg through this file,",
    "# which `agentorg service install` writes again for the Node and package that run it.",
    ...environment.map(
      ([name, value]) => `[ -n "$${name}" ] || ${name}=${quote(value)}; export ${name}`,
    ),
    `exec ${quote(nodePath())} ${quote(BIN)} "$@"`,
    "",
  ].join("\n");
}

/** Write the launcher for the running Node, replacing the one there, and return its path. */
export function writeLauncher(): string {
  if (!nodeSupported(process.versions.node)) {
    throw new Error(
      `AgentOrg needs Node ${MINIMUM_NODE_TEXT} or later, and this is ${process.versions.node}; run this command with a newer Node`,
    );
  }
  const path = launcherPath();
  ensureHome();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, launcherText(), { mode: 0o755 });
  return path;
}

export interface Pinned {
  node: string;
  /** The package the launcher runs, and its version, undefined when it is gone. */
  package: string;
  version: string | undefined;
}

/** What the launcher runs, read from it; undefined when there is none, or none written here. */
export function readLauncher(path = launcherPath()): Pinned | undefined {
  if (!existsSync(path)) return undefined;
  const found = EXEC.exec(readFileSync(path, "utf8"));
  if (!found?.[1] || !found[2]) return undefined;
  const pkg = resolve(unquote(found[2]), "../../../..");
  let version: string | undefined;
  try {
    version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  } catch {}
  return { node: unquote(found[1]), package: pkg, version };
}

/** Whether the launcher runs this package, on a Node that is there. */
export function launcherCurrent(pinned: Pinned | undefined): boolean {
  return pinned !== undefined && pinned.package === PACKAGE && existsSync(pinned.node);
}
