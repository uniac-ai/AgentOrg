import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "./hub.js";

const Hash = z.string().regex(/^sha256-[0-9a-f]{64}$/);
/** An export of a running Actor, by its id and the export's name. */
const Target = z.object({ actor: Id, export: Name });

/**
 * `installer@1`: how a package becomes a working Actor. The installer is a package Actor the
 * person binds to the Hub's management (packages, Actors, grants, exports) and to
 * `storage.admin@1`; it proposes what each slot could connect to, and installs with the
 * connections it is given. It never picks a connection itself.
 */
export const installer = defineInterface({
  name: "installer",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * For each of the package's slots that it doesn't wire itself (`module.slot`): its interface
     * (`name@major`) and the exports that could serve it now, those of exactly that interface and
     * schema hash on Actors that aren't stopped or closed. And its view modules, which a shell
     * can place.
     */
    plan: method({
      input: z.object({ package: Hash }),
      output: z.object({
        slots: z.array(
          z.object({ slot: Name, interface: z.string(), candidates: z.array(Target) }),
        ),
        views: z.array(z.string()),
      }),
    }),
    /**
     * Create an Actor of the package named `name`, with exactly these connections, all or none.
     * The installer grants nothing its caller couldn't: each connection's export side must be the
     * caller's (it is the provider, is bound to that export, or is a manager), else the whole
     * install is refused (`forbidden`, listing every such connection) and nothing is created. A
     * slot bound to `storage`'s `kv` gets the package's seed for it (an object of key to value);
     * a seed whose slot isn't is listed in `unseeded`. Then it is started if `start`. If a seed or
     * the start fails, the new Actor is closed. Slots left out stay unbound, listed in `unbound`.
     */
    install: method({
      input: z.object({
        package: Hash,
        name: z.string().min(1).max(128),
        connections: z.record(Name, Target),
        start: z.boolean().optional(),
      }),
      output: z.object({ actorId: Id, unbound: z.array(Name), unseeded: z.array(Name) }),
    }),
  },
});
