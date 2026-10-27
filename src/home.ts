/**
 * The agentorg home: the directory holding the database and the token. It is `AGENTORG_HOME`, or
 * `~/.local/share/agentorg/`. Backing up means copying it.
 */

import { randomBytes } from "node:crypto";
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
  return join(home(), "agentorg.db");
}

export function tokenPath(): string {
  return join(home(), "token");
}

function readPrivate(path: string): string {
  if (statSync(path).mode & 0o077) {
    throw new Error(`${path} is readable by other users; run chmod 600 ${path}`);
  }
  return readFileSync(path, "utf8").trim();
}

/** The bearer token: `AGENTORG_TOKEN` when set, else the token file, which must be mode 600. */
export function readToken(): string | undefined {
  if (process.env.AGENTORG_TOKEN) return process.env.AGENTORG_TOKEN;
  return existsSync(tokenPath()) ? readPrivate(tokenPath()) : undefined;
}

/** The token in the token file, created with mode 600 when there is none. */
export function ensureToken(): string {
  try {
    writeFileSync(tokenPath(), `${randomBytes(32).toString("base64url")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readPrivate(tokenPath());
}
