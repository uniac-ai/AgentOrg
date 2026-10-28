/**
 * The agentorg home: the directory holding the core's database and the root's credential. It is
 * `AGENTORG_HOME`, or `~/.local/share/agentorg/`. Backing up means copying it.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function home(): string {
  return process.env.AGENTORG_HOME || join(homedir(), ".local", "share", "agentorg");
}

/** The home directory, created readable by its owner only when it does not exist. */
export function ensureHome(): string {
  const path = home();
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function databasePath(): string {
  return join(home(), "core.db");
}

/** The root's credential, which `agentorg core` writes on first start, mode 600. */
export function rootCredentialPath(): string {
  return join(home(), "root-credential");
}

/** A file's trimmed contents, refused when other users can read it. */
export function readPrivate(path: string): string {
  if (statSync(path).mode & 0o077) {
    throw new Error(`${path} is readable by other users; run chmod 600 ${path}`);
  }
  return readFileSync(path, "utf8").trim();
}

export function writePrivate(path: string, contents: string): void {
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
}

/** An actor's credential: `AGENTORG_CREDENTIAL` when set, else the root's, from its file. */
export function readCredential(): string | undefined {
  if (process.env.AGENTORG_CREDENTIAL) return process.env.AGENTORG_CREDENTIAL;
  return existsSync(rootCredentialPath()) ? readPrivate(rootCredentialPath()) : undefined;
}
