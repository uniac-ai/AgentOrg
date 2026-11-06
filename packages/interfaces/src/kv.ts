import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

const Key = z.string().min(1).max(1024);

/**
 * `kv@1`: a key-value store of JSON values, the state slot a host module uses. A storage provider
 * keeps one store per consumer slot, so the store is the slot's own; `list` pages through its keys.
 */
export const kv = defineInterface({
  name: "kv",
  major: 1,
  kind: "rpc",
  methods: {
    /** The value under `key`; `value` is absent when there is none, and a stored `null` is `null`. */
    get: method({
      input: z.object({ key: Key }),
      output: z.object({ value: z.json().optional() }),
    }),
    set: method({ input: z.object({ key: Key, value: z.json() }), output: z.object({}) }),
    delete: method({ input: z.object({ key: Key }), output: z.object({ deleted: z.boolean() }) }),
    /** Keys in order, a page at a time: pass the last page's `next` as `after`. */
    list: method({
      input: z.object({
        prefix: z.string().optional(),
        after: Key.optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      output: z.object({ keys: z.array(Key), next: Key.nullable() }),
    }),
  },
});
