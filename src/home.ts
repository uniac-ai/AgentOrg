/**
 * The agentorg home: the directory holding the core's database, the root's credential, the
 * credential store of the positions sessions fill, and which session fills which. It is
 * `AGENTORG_HOME`, or `~/.local/share/agentorg/`. Backing up means copying it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** A name safe as a file name in the home, such as an actor id, or an error. */
function fileName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`not a name for a file: ${name}`);
  return name;
}

/** A directory in the home, created readable by its owner only. */
export function privateDirectory(name: string): string {
  const path = join(ensureHome(), name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * The credential store: each position's credential, kept for whatever fills it, in `actors/<id>`,
 * readable by its owner only. Whoever creates a position writes it, and whatever attaches reads it.
 */
export const credentials = {
  path: (actor: string) => join(home(), "actors", fileName(actor)),
  write(actor: string, credential: string): void {
    writePrivate(join(privateDirectory("actors"), fileName(actor)), credential);
  },
  read(actor: string): string | undefined {
    const path = credentials.path(actor);
    return existsSync(path) ? readPrivate(path) : undefined;
  },
  remove(actor: string): void {
    rmSync(credentials.path(actor), { force: true });
  },
};

/** An actor's credential: `AGENTORG_CREDENTIAL` when set, else the root's, from its file. */
export function readCredential(): string | undefined {
  if (process.env.AGENTORG_CREDENTIAL) return process.env.AGENTORG_CREDENTIAL;
  return existsSync(rootCredentialPath()) ? readPrivate(rootCredentialPath()) : undefined;
}
