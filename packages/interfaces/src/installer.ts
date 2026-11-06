import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "./hub.js";

const Hash = z.string().regex(/^sha256-[0-9a-f]{64}$/);
/** An export of a running Actor, by its id and the export's name. */
const Target = z.object({ actor: Id, export: Name });
/** An Actor of a composition, by the name it has there. */
const ActorName = z.string().min(1).max(128);

/**
 * `agentorg.system/1`: a system as data, by names, never by ids. Its Actors and the packages
 * they run (`name@version#hash`), its connections, and the person's layout. Built-in Actors
 * (`hub`, `storage`, `net`) are named by their ids. No credentials, tokens, stores or logs.
 */
export const Composition = z.object({
  format: z.literal("agentorg.system/1"),
  actors: z.record(ActorName, z.object({ package: z.string(), running: z.boolean().optional() })),
  connections: z.array(
    z.object({ consumer: ActorName, slot: Name, provider: ActorName, export: Name }),
  ),
  layout: z.object({
    home: z.array(
      z.object({
        actor: ActorName,
        module: z
          .string()
          .regex(/^[a-z][A-Za-z0-9_]*$/)
          .max(64),
        title: z.string().max(200).optional(),
      }),
    ),
  }),
});
/** What a system's export or import couldn't carry over, and why: listed, never guessed. */
const Unresolved = z.array(z.object({ what: z.string(), why: z.string() }));

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
    /**
     * The system as it is, as a composition: every package Actor that isn't closed, the
     * connections among them and to the built-in Actors, and the layout. External Actors (a
     * program that connects itself, the person) and connections to them are listed in
     * `unresolved`, not exported.
     */
    exportSystem: method({
      input: z.object({}),
      output: z.object({ composition: Composition, unresolved: Unresolved }),
    }),
    /**
     * Make a composition's system here, with the caller's authority: every connection's export
     * side must be the caller's, as in `install`, or nothing is made (`forbidden`, listing them).
     * Its packages must already be added (a composition travels with them; whoever holds the
     * files adds them). An Actor whose package isn't here (or is another version) isn't made, and
     * is listed in `unresolved` with what depends on it; so is an Actor that needs a sign-in, a
     * seed that can't land, and the placements, unless the caller holds the person's layout.
     * A connection to the Hub's management (`hub`) or to `storage.admin` is never made by an
     * import, even a manager's: a composition may come from anyone, so those are listed in
     * `ungranted`, for the person to grant one by one. A name already taken gets a suffix. Seeds land as in `install`; what was running is
     * started; the layout is placed. If anything else fails, what this import made is closed.
     */
    importSystem: method({
      input: z.object({ composition: Composition }),
      output: z.object({
        created: z.record(ActorName, Id),
        unresolved: Unresolved,
        ungranted: z.array(
          z.object({ consumer: ActorName, slot: Name, provider: ActorName, export: Name }),
        ),
      }),
    }),
  },
});
