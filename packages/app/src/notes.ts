// The app's own notes: what the person's pages and the gateway keep, in one private file.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { kv } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";

/** Keys read at once by a `list`. */
const PAGE = 1000;

/** A file of JSON values by key, answering as `kv@1` does. Each write replaces it whole. */
export class Notes {
  readonly #file: string;
  readonly #values: Record<string, unknown>;

  constructor(file: string) {
    this.#file = file;
    let raw: string | undefined;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#values = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }

  get(key: string): { value?: unknown } {
    return Object.hasOwn(this.#values, key) ? { value: this.#values[key] } : {};
  }

  set(key: string, value: unknown): object {
    this.#values[key] = value;
    this.#save();
    return {};
  }

  /** One `kv@1` call, checked as a call through the Hub would be. */
  call(method: string, input: unknown): unknown {
    const spec = Object.hasOwn(kv.methods, method)
      ? kv.methods[method as keyof typeof kv.methods]
      : undefined;
    if (!spec) throw new Refused("invalid", `store has no method ${method}.`);
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) throw new Refused("invalid", `store.${method}: ${parsed.error.message}`);
    const given = parsed.data as {
      key: string;
      value: unknown;
      prefix?: string;
      after?: string;
      limit?: number;
    };
    if (method === "get") return this.get(given.key);
    if (method === "set") return this.set(given.key, given.value);
    if (method === "delete") {
      const deleted = Object.hasOwn(this.#values, given.key);
      delete this.#values[given.key];
      if (deleted) this.#save();
      return { deleted };
    }
    const { prefix = "", after, limit = PAGE } = given;
    const found = Object.keys(this.#values)
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    const keys = found.slice(0, limit);
    return { keys, next: found.length > limit ? (keys.at(-1) ?? null) : null };
  }

  #save() {
    writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#values), { mode: 0o600, flush: true });
    renameSync(`${this.#file}.tmp`, this.#file);
  }
}
