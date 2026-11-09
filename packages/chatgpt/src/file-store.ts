import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Log } from "@agentorg/sdk";
import type { Store } from "./account.js";

type Value = Awaited<ReturnType<Store["get"]>>["value"];

/**
 * The sign-in, in one private file, read each time so nothing is held that the file no longer says.
 * Each change is on disk before it is acknowledged, since a refresh token that rotated can't be had
 * again. A file that can't be read is removed, and the person signs in again; nothing of it is ever
 * logged, a parse error's text included.
 */
export function fileStore(dir: string, log: Log): Store {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "sign-in.json");
  const read = () => {
    const values = new Map<string, Value>();
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return values;
      throw error;
    }
    try {
      for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, Value>))
        values.set(key, value);
    } catch {
      rmSync(path);
      log.error("The sign-in file couldn't be read, so it was removed: sign in again.");
    }
    return values;
  };
  const save = (values: Map<string, Value>) => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(values)), {
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, path);
    const folder = openSync(dir, "r");
    try {
      fsyncSync(folder);
    } finally {
      closeSync(folder);
    }
  };
  return {
    get: async ({ key }) => {
      const values = read();
      return values.has(key) ? { value: values.get(key) } : {};
    },
    set: async ({ key, value }) => {
      const values = read();
      values.set(key, value);
      save(values);
      return {};
    },
    delete: async ({ key }) => {
      const values = read();
      const deleted = values.delete(key);
      if (deleted) save(values);
      return { deleted };
    },
  };
}
