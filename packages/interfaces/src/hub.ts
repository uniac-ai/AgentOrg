import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

/**
 * The built-in `hub` Actor's exports: management as ordinary interfaces. They are bound and
 * called like any other, so a program bound to them can do anything the person can.
 */

const Hash = z.string().regex(/^sha256-[0-9a-f]{64}$/);
export const Id = z.string().min(1).max(128);
/** A slot or export: `name`, or `module.name`. */
export const Name = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)?$/)
  .max(129);
const Empty = z.object({});

export const ActorState = z.enum(["created", "running", "stopped", "closed"]);
export const Actor = z.object({
  actorId: Id,
  name: z.string(),
  /**
   * `external` for a program that connects itself; `builtin` for the `hub` Actor, which is the
   * core itself. An Actor an earlier release ran from a package keeps that package's hash.
   */
  package: z.union([Hash, z.literal("external"), z.literal("builtin")]),
  state: ActorState,
  /**
   * Whether it has a channel to the Hub now: while its program is connected (the person while the
   * app runs: its gateway holds the person's channel). The hub is the core itself and has none.
   */
  connected: z.boolean(),
  /**
   * The Actor it was created for, when a manager created it on another's behalf (the installer
   * names its caller). Provenance only: the Hub grants nothing from it; only a rule the person
   * turned on may act on it.
   */
  installedFor: Id.optional(),
});

/** `hub.actors@1`: Actors: who may join the Hub. */
export const hubActors = defineInterface({
  name: "hub.actors",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * An Actor for a program that connects itself, with a credential returned once. `bindings` wire the new Actor's slots at once, with the caller's export-side authority
     * (the creation is the slot side's yes), for example to its own `hub.grants@1`. `for` names
     * the Actor it is made for, recorded as `installedFor`; only a manager may give it.
     */
    create: method({
      input: z.object({
        name: z.string().min(1).max(128),
        for: Id.optional(),
        bindings: z
          .array(z.object({ slot: Name, provider: Id, export: Name }))
          .max(64)
          .optional(),
      }),
      output: z.object({ actorId: Id, credential: z.string() }),
    }),
    list: method({ input: Empty, output: z.object({ actors: z.array(Actor) }) }),
    get: method({ input: z.object({ actorId: Id }), output: Actor }),
    /** Final: its bindings, both ways, are removed. */
    close: method({ input: z.object({ actorId: Id }), output: Empty }),
  },
  events: {
    /**
     * An Actor's record may differ: it was made or closed, or it connected or went (`connected`).
     * Read it again with `get` or `list`.
     */
    changed: event(z.object({ actor: Id })),
  },
});

const Wiring = { consumer: Id, slot: Name, provider: Id, export: Name };
/** A slot made at run time: one segment, at most 48 characters, so tools named from it fit. */
export const SlotName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(48);
export const Binding = z.object({
  ...Wiring,
  interface: z.string(),
  madeBy: Id,
  at: z.string(),
  /** A slot made at run time by `hub.grants.expose`: it goes with this binding. */
  exposed: z.literal(true).optional(),
});
export const BindingRequest = z.object({
  requestId: Id,
  ...Wiring,
  /** The end the requester lacks: `export` (provider, holders, managers) or `slot` (consumer, managers). */
  needs: z.enum(["export", "slot"]),
  reason: z.string(),
  requestedBy: Id,
  at: z.string(),
  /**
   * A request to expose: `slot` is the name the slot will have on `consumer`, made when it is
   * approved. Approve it with `expose({provider, export, to: consumer, as: slot})`.
   */
  exposed: z.literal(true).optional(),
});

/**
 * `hub.grants@1`: binding with the caller's own authority, so it is safe to give any Actor. A
 * binding needs both ends: the export side (the provider, an Actor already bound to that export,
 * or a manager) and the slot side (the consumer itself, or a manager). With both, `bind` binds.
 * With one, it approves an open request from the other end, or becomes a request to that end's
 * approvers. With neither it is refused.
 */
export const hubGrants = defineInterface({
  name: "hub.grants",
  major: 1,
  kind: "rpc",
  methods: {
    /** A request made by `bind` has an empty reason; `request` gives one. */
    bind: method({
      input: z.object(Wiring),
      output: z.union([
        z.object({ bound: z.literal(true) }),
        z.object({ bound: z.literal(false), requestId: Id }),
      ]),
    }),
    /** The consumer, the provider or a manager may unbind. */
    unbind: method({ input: z.object({ consumer: Id, slot: Name }), output: Empty }),
    /**
     * Expose an `rpc` export to one Actor: a slot made on `to`, typed by the export's interface,
     * named `as` (by default the provider's name camelCased, `_`, and the export's last part, made
     * unique on `to`), and bound to the export, in one step. Its authority is a binding's: with
     * both ends it is made; with one, it is a request to the other end's approvers, who approve it
     * by calling `expose` with the request's fields. The same export already exposed to `to`
     * gives that slot back.
     */
    expose: method({
      input: z.object({ provider: Id, export: Name, to: Id, as: SlotName.optional() }),
      output: z.union([
        z.object({ exposed: z.literal(true), slot: SlotName }),
        z.object({ exposed: z.literal(false), slot: SlotName, requestId: Id }),
      ]),
    }),
    /** Remove a slot made by `expose`, with its binding: as `unbind`, the consumer, the provider or a manager may. */
    unexpose: method({ input: z.object({ to: Id, slot: SlotName }), output: Empty }),
    request: method({
      input: z.object({ ...Wiring, reason: z.string().min(1).max(1000) }),
      output: z.object({ requestId: Id }),
    }),
    /** The open requests the caller could approve. */
    requests: method({ input: Empty, output: z.object({ requests: z.array(BindingRequest) }) }),
    decline: method({ input: z.object({ requestId: Id }), output: Empty }),
    /**
     * The caller's own requests and how each stands, newest first: how a requester that missed
     * `decided` learns the outcome.
     */
    mine: method({
      input: z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      output: z.object({
        requests: z.array(
          BindingRequest.extend({ status: z.enum(["open", "approved", "declined", "closed"]) }),
        ),
      }),
    }),
  },
  events: {
    /** A request the subscriber could approve. */
    requested: event(BindingRequest),
    /**
     * A request the subscriber could approve, or made, was approved (its binding made), declined,
     * or closed (its slot was bound to something else, or one end went away).
     */
    decided: event(
      z.object({ request: BindingRequest, status: z.enum(["approved", "declined", "closed"]) }),
    ),
  },
});

/**
 * `hub.bindings@1`: management scope. An Actor bound to it is a manager: it holds both ends of
 * every binding and is an approver of every request, acting through `hub.grants@1`, which it needs
 * as well. Here, the manager-wide reads.
 */
export const hubBindings = defineInterface({
  name: "hub.bindings",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({
      input: z.object({ actor: Id.optional() }),
      output: z.object({ bindings: z.array(Binding) }),
    }),
  },
});

export const ExportEntry = z.object({
  actor: Id,
  export: Name,
  interface: z.string(),
  hash: Hash,
  dynamic: z.boolean(),
});

/** `hub.exports@1`: what each Actor offers right now. */
export const hubExports = defineInterface({
  name: "hub.exports",
  major: 1,
  kind: "rpc",
  methods: {
    list: method({
      input: z.object({ actor: Id.optional() }),
      output: z.object({ exports: z.array(ExportEntry) }),
    }),
  },
  events: { changed: event(z.object({ actor: Id })) },
});

export const AuditEntry = z.object({
  seq: z.number().int(),
  at: z.string(),
  actor: Id,
  kind: z.string(),
  details: z.record(z.string(), z.json()),
});

/** `hub.audit@1`: the append-only record of binding, lifecycle and call metadata. */
export const hubAudit = defineInterface({
  name: "hub.audit",
  major: 1,
  kind: "rpc",
  methods: {
    /** Entries after `since`, oldest first, a page at a time. */
    list: method({
      input: z.object({
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      output: z.object({ entries: z.array(AuditEntry), next: z.number().int() }),
    }),
  },
  events: { appended: event(AuditEntry) },
});
