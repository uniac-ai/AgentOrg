import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Refused } from "@agentorg/sdk";

/** How much a store may hold. */
export interface StorageLimits {
  /** Bytes of one value, as JSON. */
  maxValue: number;
  /** Bytes of keys and values across all of one consumer's stores. */
  maxPerConsumer: number;
}
export const STORAGE_LIMITS: StorageLimits = {
  maxValue: 256 * 1024,
  maxPerConsumer: 64 * 1024 * 1024,
};

type Input = Record<string, unknown>;
/** Bytes of a key, as UTF-8. */
const MAX_KEY = 1024;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** A key is well-formed text: half a surrogate pair would be stored as U+FFFD, merging keys. */
function checkKey(key: string) {
  if (LONE_SURROGATE.test(key)) throw new Refused("invalid", "A key is well-formed text.");
}

/**
 * The built-in `storage` Actor's `kv@1`: one store per consumer slot, kept in `<home>/storage.db`
 * (0600), apart from the Hub's own database. The store is chosen by the consumer and slot the
 * router names, never by the caller. Stores outlive unbinding; a closed Actor's go with it.
 */
export class Storage {
  readonly #db: DatabaseSync;
  readonly #limits: StorageLimits;

  constructor(home: string, limits: StorageLimits = STORAGE_LIMITS) {
    this.#limits = limits;
    const file = join(home, "storage.db");
    // A lock held elsewhere is waited for a while rather than failing at once.
    this.#db = new DatabaseSync(file, { timeout: 5000 });
    chmodSync(file, 0o600);
    this.#db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store (
        consumer TEXT NOT NULL, slot TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY (consumer, slot, key));
      CREATE TABLE IF NOT EXISTS usage (consumer TEXT PRIMARY KEY, used INTEGER NOT NULL);`);
    for (const suffix of ["-wal", "-shm"])
      try {
        chmodSync(file + suffix, 0o600);
      } catch {
        // Not created yet.
      }
  }

  /** One `kv@1` call on the store of (consumer, slot). Inputs were already checked. */
  call(consumer: string, slot: string, method: string, input: Input): unknown {
    const key = String(input.key ?? "");
    switch (method) {
      case "get": {
        const row = this.#db
          .prepare("SELECT value FROM store WHERE consumer = ? AND slot = ? AND key = ?")
          .get(consumer, slot, key) as { value: string } | undefined;
        return row ? { value: JSON.parse(row.value) } : {};
      }
      case "set":
        return this.#set(consumer, slot, key, input.value);
      case "delete":
        return this.#delete(consumer, slot, key);
      case "list":
        return this.#list(consumer, slot, input);
      default:
        throw new Refused("unimplemented", `kv@1 has no method ${method}.`);
    }
  }

  /** Run work in one write transaction. */
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      this.#db.exec("COMMIT");
      return out;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Add `delta` bytes to what a consumer's stores hold; the total is kept, never summed. */
  #use(consumer: string, delta: number) {
    this.#db
      .prepare(
        "INSERT INTO usage (consumer, used) VALUES (?, ?) ON CONFLICT (consumer) DO UPDATE SET used = used + excluded.used",
      )
      .run(consumer, delta);
  }

  #sizeOf(consumer: string, slot: string, key: string): number | undefined {
    const row = this.#db
      .prepare("SELECT size FROM store WHERE consumer = ? AND slot = ? AND key = ?")
      .get(consumer, slot, key) as { size: number } | undefined;
    return row && Number(row.size);
  }

  #set(consumer: string, slot: string, key: string, value: unknown) {
    checkKey(key);
    if (Buffer.byteLength(key) > MAX_KEY)
      throw new Refused("quota", `A key is at most ${MAX_KEY} bytes.`);
    const json = JSON.stringify(value);
    const valueBytes = Buffer.byteLength(json);
    if (valueBytes > this.#limits.maxValue)
      throw new Refused("quota", `A value is at most ${this.#limits.maxValue} bytes.`);
    const size = valueBytes + Buffer.byteLength(key);
    this.#transaction(() => {
      const used = this.#db.prepare("SELECT used FROM usage WHERE consumer = ?").get(consumer) as
        | { used: number }
        | undefined;
      const replaced = this.#sizeOf(consumer, slot, key) ?? 0;
      if (Number(used?.used ?? 0) - replaced + size > this.#limits.maxPerConsumer)
        throw new Refused(
          "quota",
          `An Actor's stores hold at most ${this.#limits.maxPerConsumer} bytes.`,
        );
      this.#db
        .prepare(
          "INSERT INTO store (consumer, slot, key, value, size) VALUES (?, ?, ?, ?, ?) ON CONFLICT (consumer, slot, key) DO UPDATE SET value = excluded.value, size = excluded.size",
        )
        .run(consumer, slot, key, json, size);
      this.#use(consumer, size - replaced);
    });
    return {};
  }

  #delete(consumer: string, slot: string, key: string) {
    return this.#transaction(() => {
      const size = this.#sizeOf(consumer, slot, key);
      if (size === undefined) return { deleted: false };
      this.#db
        .prepare("DELETE FROM store WHERE consumer = ? AND slot = ? AND key = ?")
        .run(consumer, slot, key);
      this.#use(consumer, -size);
      return { deleted: true };
    });
  }

  /** Keys with the prefix, in order, after `after`, a page at a time. */
  #list(consumer: string, slot: string, input: Input) {
    const prefix = typeof input.prefix === "string" ? input.prefix : "";
    const after = typeof input.after === "string" ? input.after : "";
    const limit = typeof input.limit === "number" ? input.limit : 100;
    const rows = this.#db
      .prepare(
        // The scan starts at the prefix (or after `after`) and stops past the prefix's range; instr
        // keeps exactly the keys that start with it.
        `SELECT key FROM store WHERE consumer = ? AND slot = ? AND key > ? AND key >= ? AND key < ?
         AND instr(key, ?) = 1 ORDER BY key LIMIT ?`,
      )
      .all(consumer, slot, after, prefix, `${prefix}\u{10FFFF}`, prefix, limit + 1) as {
      key: string;
    }[];
    const keys = rows.slice(0, limit).map((row) => row.key);
    return { keys, next: rows.length > limit ? (keys.at(-1) ?? null) : null };
  }

  /**
   * Seed the store of (consumer, slot), all or none, if it holds nothing: `storage.admin@1`'s
   * `seed`. Each entry has kv@1's limits, and together they count toward the consumer's quota.
   */
  seed(consumer: string, slot: string, entries: { key: string; value: unknown }[]): void {
    const keys = new Set<string>();
    const rows = entries.map(({ key, value }) => {
      checkKey(key);
      if (keys.has(key))
        throw new Refused("invalid", `The key ${JSON.stringify(key)} is given twice.`);
      keys.add(key);
      if (Buffer.byteLength(key) > MAX_KEY)
        throw new Refused("quota", `A key is at most ${MAX_KEY} bytes.`);
      const json = JSON.stringify(value);
      const valueBytes = Buffer.byteLength(json);
      if (valueBytes > this.#limits.maxValue)
        throw new Refused("quota", `A value is at most ${this.#limits.maxValue} bytes.`);
      return { key, json, size: valueBytes + Buffer.byteLength(key) };
    });
    const total = rows.reduce((sum, row) => sum + row.size, 0);
    this.#transaction(() => {
      if (
        this.#db
          .prepare("SELECT 1 FROM store WHERE consumer = ? AND slot = ? LIMIT 1")
          .get(consumer, slot)
      )
        throw new Refused("not_empty", `The store of ${consumer}.${slot} isn't empty.`);
      const used = this.#db.prepare("SELECT used FROM usage WHERE consumer = ?").get(consumer) as
        | { used: number }
        | undefined;
      if (Number(used?.used ?? 0) + total > this.#limits.maxPerConsumer)
        throw new Refused(
          "quota",
          `An Actor's stores hold at most ${this.#limits.maxPerConsumer} bytes.`,
        );
      const insert = this.#db.prepare(
        "INSERT INTO store (consumer, slot, key, value, size) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of rows) insert.run(consumer, slot, row.key, row.json, row.size);
      this.#use(consumer, total);
    });
  }

  /** Every store of an Actor, gone: it was closed for good. */
  deleteConsumer(consumer: string): void {
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM store WHERE consumer = ?").run(consumer);
      this.#db.prepare("DELETE FROM usage WHERE consumer = ?").run(consumer);
    });
  }

  /**
   * Keep only the stores of these Actors. Run when the Hub opens, it catches up on deletes a crash
   * or a lock kept from happening when an Actor was closed.
   */
  keepOnly(live: ReadonlySet<string>): void {
    const consumers = this.#db.prepare("SELECT consumer FROM usage").all() as {
      consumer: string;
    }[];
    for (const { consumer } of consumers) if (!live.has(consumer)) this.deleteConsumer(consumer);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
