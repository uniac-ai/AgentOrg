/**
 * The engine's record when it runs as an ordinary program: one small JSON file per key, in the
 * agent's own folder. A new message writes one file, however long the record is, and each write
 * lands whole. It answers as `kv@1` does, so the engine reads it as it reads any store.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { kv } from "@agentorg/interfaces";
import type { Slot } from "@agentorg/sdk";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function createLocalStore(dir: string): Slot<typeof kv>["call"] {
  const keys = join(dir, "kv");
  const scratch = join(dir, "tmp");
  const pathOf = (key: string) => join(keys, encodeURIComponent(key));
  return {
    async get({ key }) {
      try {
        return { value: JSON.parse(await readFile(pathOf(key), "utf8")) };
      } catch (error) {
        if (missing(error)) return {};
        throw error;
      }
    },
    async set({ key, value }) {
      await mkdir(keys, { recursive: true, mode: 0o700 });
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const temporary = join(scratch, randomUUID());
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
      await rename(temporary, pathOf(key));
      return {};
    },
    async delete({ key }) {
      try {
        await rm(pathOf(key));
        return { deleted: true };
      } catch (error) {
        if (missing(error)) return { deleted: false };
        throw error;
      }
    },
    async list({ prefix = "", after, limit = 1000 }) {
      const names = await readdir(keys).catch((error: unknown) => {
        if (missing(error)) return [];
        throw error;
      });
      const found = names
        .map(decodeURIComponent)
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort();
      const page = found.slice(0, limit);
      return { keys: page, next: found.length > limit ? (page.at(-1) ?? null) : null };
    },
  };
}
