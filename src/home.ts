/**
 * The agentorg home: the directory holding the database and the token. It is `AGENTORG_HOME`, or
 * `~/.local/share/agentorg/`. Backing up means copying it.
 */

import { mkdirSync } from "node:fs";
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
  return join(home(), "agentorg.db");
}
