import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

/**
 * The built-in `hub` Actor's exports: management as ordinary interfaces. They are bound and
 * called like any other, so a program bound to them can do anything the person can.
 */

const Hash = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const Id = z.string().min(1).max(128);
/** A slot or export: `name` for an external Actor, `module.name` for a package Actor. */
const Name = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)?$/)
  .max(129);
const Empty = z.object({});

export const Package = z.object({ hash: Hash, name: z.string(), version: z.string() });

/** `hub.packages@1`: the content-addressed package store. */
export const hubPackages = defineInterface({
  name: "hub.packages",
  major: 1,
  kind: "rpc",
  methods: {
    /** Add a `.agentorg` archive from a path on the Hub's machine; it is verified first. */
    add: method({
      input: z.object({ path: z.string().min(1).max(4096) }),
      output: z.object({ hash: Hash, manifest: z.record(z.string(), z.json()) }),
    }),
    list: method({ input: Empty, output: z.object({ packages: z.array(Package) }) }),
    get: method({
      input: z.object({ hash: Hash }),
      output: z.object({ hash: Hash, manifest: z.record(z.string(), z.json()) }),
    }),
    /** Refused while an Actor runs the package. */
    remove: method({ input: z.object({ hash: Hash }), output: Empty }),
  },
});

export const ActorState = z.enum(["created", "running", "stopped", "closed"]);
export const Actor = z.object({
  actorId: Id,
  name: z.string(),
  /**
   * The package it runs, by hash; `external` for a program that connects itself; `builtin` for
   * the `hub` Actor, which is the core itself.
   */
  package: z.union([Hash, z.literal("external"), z.literal("builtin")]),
  state: ActorState,
});

/** `hub.actors@1`: Actors and their lifecycle. */
export const hubActors = defineInterface({
  name: "hub.actors",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * With a package, an Actor that runs it; without, an external one, whose credential is returned
     * once. `bindings` wire the new Actor's slots at once, with the caller's export-side authority
     * (the creation is the slot side's yes), for example to its own `hub.grants@1`.
     */
    create: method({
      input: z.object({
        name: z.string().min(1).max(128),
        package: Hash.optional(),
        bindings: z
          .array(z.object({ slot: Name, provider: Id, export: Name }))
          .max(64)
          .optional(),
      }),
      output: z.object({ actorId: Id, credential: z.string().optional() }),
    }),
    list: method({ input: Empty, output: z.object({ actors: z.array(Actor) }) }),
    get: method({ input: z.object({ actorId: Id }), output: Actor }),
    start: method({ input: z.object({ actorId: Id }), output: Empty }),
    stop: method({ input: z.object({ actorId: Id }), output: Empty }),
    /** Final: its bindings, both ways, are removed. */
    close: method({ input: z.object({ actorId: Id }), output: Empty }),
  },
});

const Wiring = { consumer: Id, slot: Name, provider: Id, export: Name };
export const Binding = z.object({
  ...Wiring,
  interface: z.string(),
  madeBy: Id,
  at: z.string(),
});
export const BindingRequest = z.object({
  requestId: Id,
  ...Wiring,
  /** The end the requester lacks: `export` (provider, holders, managers) or `slot` (consumer, managers). */
  needs: z.enum(["export", "slot"]),
  reason: z.string(),
  requestedBy: Id,
  at: z.string(),
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
