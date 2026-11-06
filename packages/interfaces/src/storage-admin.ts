import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "./hub.js";

const Key = z.string().min(1).max(1024);

/**
 * `storage.admin@1`: how a package's `seed` reaches its new Actor's `kv@1` stores. Only the
 * installer is bound to it. It seeds empty stores only, any consumer's, and every seed is
 * audited (the consumer, the slot and how many entries; never the values).
 */
export const storageAdmin = defineInterface({
  name: "storage.admin",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Write `entries` into the store of (`consumer`, `slot`), all or none. The slot must be the
     * consumer's and bound to `storage.kv` (`Refused("invalid")` otherwise). `Refused("not_empty")`
     * unless the store holds nothing, `Refused("quota")` past kv@1's limits or the consumer's
     * quota, `Refused("invalid")` for a key given twice or one that isn't well-formed text. A
     * seed travels in one frame, so it is under 1 MiB.
     */
    seed: method({
      input: z.object({
        consumer: Id,
        slot: Name,
        entries: z.array(z.object({ key: Key, value: z.json() })).max(10_000),
      }),
      output: z.object({}),
    }),
  },
});
