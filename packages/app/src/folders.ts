// The folders on this machine, for the person choosing one. Names only: what's in a file, or even
// that a file is there, isn't said.
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { FOLDERS_MAX, folders } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";

async function isFolder(at: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return stat(join(at, entry.name)).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

async function list(path: string | undefined) {
  if (path !== undefined && !isAbsolute(path))
    throw new Refused("invalid", "A folder's path starts at the top of the disk.");
  const at = path === undefined ? homedir() : normalize(path);
  const entries = await readdir(at, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        throw new Refused("unknown", "There's no such folder.");
      throw new Refused("invalid", "That folder can't be read.");
    },
  );
  // Dot folders stay out of the list, as in a file picker; a path can still be typed.
  const shown = entries.filter((entry) => !entry.name.startsWith("."));
  const kept = await Promise.all(shown.map((entry) => isFolder(at, entry)));
  const names = shown
    .filter((_, i) => kept[i])
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, FOLDERS_MAX);
  const parent = dirname(at);
  return {
    path: at,
    ...(parent === at ? {} : { parent }),
    folders: names.map((name) => ({ name })),
  };
}

/** One `folders@1` call, checked as a call through the Hub would be. */
export function callFolders(method: string, input: unknown): Promise<unknown> {
  if (method !== "list") throw new Refused("invalid", `folders has no method ${method}.`);
  const parsed = folders.methods.list.input.safeParse(input);
  if (!parsed.success) throw new Refused("invalid", `folders.list: ${parsed.error.message}`);
  return list(parsed.data.path);
}
