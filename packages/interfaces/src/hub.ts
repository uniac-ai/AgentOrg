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
    /** With a package, an Actor that runs it; without, an external one, whose credential is returned once. */
    create: method({
      input: z.object({ name: z.string().min(1).max(128), package: Hash.optional() }),
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
  reason: z.string(),
  requestedBy: Id,
  at: z.string(),
});

/**
 * `hub.bindings@1`: who is wired to whom. A binding is the grant. The caller may bind when it is
 * the provider, already holds that export, or is bound to `hub.bindings@1` (a manager); otherwise
 * it requests, and any Actor that could make the binding makes it or declines.
 */
export const hubBindings = defineInterface({
  name: "hub.bindings",
  major: 1,
  kind: "rpc",
  methods: {
    bind: method({ input: z.object(Wiring), output: Empty }),
    unbind: method({ input: z.object({ consumer: Id, slot: Name }), output: Empty }),
    list: method({
      input: z.object({ actor: Id.optional() }),
      output: z.object({ bindings: z.array(Binding) }),
    }),
    request: method({
      input: z.object({ ...Wiring, reason: z.string().min(1).max(1000) }),
      output: z.object({ requestId: Id }),
    }),
    /** The open requests the caller could approve. */
    requests: method({ input: Empty, output: z.object({ requests: z.array(BindingRequest) }) }),
    decline: method({ input: z.object({ requestId: Id }), output: Empty }),
  },
  events: {
    /** A request the subscriber could approve. */
    requested: event(BindingRequest),
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
