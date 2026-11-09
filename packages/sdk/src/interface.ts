import { z } from "zod";
import { hashOf } from "./canonical.js";

/** One request and its reply on an `rpc` interface. */
export interface MethodSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly input: I;
  readonly output: O;
}
/** One event an `rpc` interface's provider emits: live, delivered at most once. */
export interface EventSpec<P extends z.ZodType = z.ZodType> {
  readonly payload: P;
}
export type Methods = Record<string, MethodSpec>;
export type Events = Record<string, EventSpec>;
type NoEvents = Record<never, EventSpec>;

export function method<I extends z.ZodType, O extends z.ZodType>(spec: {
  input: I;
  output: O;
}): MethodSpec<I, O> {
  return { input: spec.input, output: spec.output };
}
export function event<P extends z.ZodType>(payload: P): EventSpec<P> {
  return { payload };
}

interface Named<N extends string, V extends number = number> {
  readonly name: N;
  readonly major: V;
}
/** Requests, replies and events, each typed by a schema; one stream per call or subscription. */
export interface RpcInterface<
  N extends string = string,
  M extends Methods = Methods,
  E extends Events = Events,
  V extends number = number,
> extends Named<N, V> {
  readonly kind: "rpc";
  readonly methods: M;
  readonly events: E;
}
/** Raw bytes in a named protocol, the L4 shape; opening a stream takes parameters. */
export interface StreamInterface<N extends string = string, O extends z.ZodType = z.ZodType>
  extends Named<N> {
  readonly kind: "stream";
  readonly protocol: string;
  readonly open: O;
}
/** HTTP/1.1 requests and responses on streams, the L7 shape. */
export interface HttpInterface<N extends string = string> extends Named<N> {
  readonly kind: "http";
}
export type Interface = RpcInterface | StreamInterface | HttpInterface;

const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const MEMBER = /^[a-z][A-Za-z0-9_]*$/;

/**
 * A named, versioned contract, identified by `name@major`. A slot binds only to an export of the
 * same `name@major` whose schemas hash the same.
 */
export function defineInterface<
  const N extends string,
  M extends Methods,
  E extends Events = NoEvents,
  const V extends number = number,
>(spec: { name: N; major: V; kind: "rpc"; methods: M; events?: E }): RpcInterface<N, M, E, V>;
export function defineInterface<const N extends string, O extends z.ZodType>(spec: {
  name: N;
  major: number;
  kind: "stream";
  protocol: string;
  open: O;
}): StreamInterface<N, O>;
export function defineInterface<const N extends string>(spec: {
  name: N;
  major: number;
  kind: "http";
}): HttpInterface<N>;
export function defineInterface(spec: {
  name: string;
  major: number;
  kind: Interface["kind"];
  methods?: Methods;
  events?: Events;
  protocol?: string;
  open?: z.ZodType;
}): Interface {
  if (!NAME.test(spec.name))
    throw new TypeError(
      `Interface name ${JSON.stringify(spec.name)} must be dotted lowercase words.`,
    );
  if (!Number.isInteger(spec.major) || spec.major < 1)
    throw new TypeError(`Interface ${spec.name} needs a whole major version of 1 or more.`);
  const id = `${spec.name}@${spec.major}`;
  switch (spec.kind) {
    case "rpc": {
      const methods = spec.methods ?? {};
      const events = spec.events ?? {};
      for (const member of [...Object.keys(methods), ...Object.keys(events)])
        if (!MEMBER.test(member))
          throw new TypeError(
            `${id}: ${JSON.stringify(member)} isn't a valid method or event name.`,
          );
      for (const name of Object.keys(events))
        if (name in methods) throw new TypeError(`${id}: ${name} is both a method and an event.`);
      return { name: spec.name, major: spec.major, kind: "rpc", methods, events };
    }
    case "stream":
      if (!spec.protocol || !spec.open)
        throw new TypeError(`${id}: a stream interface names its protocol and its open schema.`);
      return {
        name: spec.name,
        major: spec.major,
        kind: "stream",
        protocol: spec.protocol,
        open: spec.open,
      };
    case "http":
      return { name: spec.name, major: spec.major, kind: "http" };
    default:
      throw new TypeError(`${id}: kind must be rpc, stream or http.`);
  }
}

export type JsonSchema = Record<string, unknown>;
/** An interface's identity and JSON Schemas. */
export type InterfaceSchemas = { id: string } & (
  | {
      kind: "rpc";
      methods: Record<string, { input: JsonSchema; output: JsonSchema }>;
      events: Record<string, JsonSchema>;
    }
  | { kind: "stream"; protocol: string; open: JsonSchema }
  | { kind: "http" }
);
/** An interface's identity, JSON Schemas and hash. */
export type DescribedInterface = InterfaceSchemas & { hash: string };

/** `name@major`, the identity a slot and an export must share. */
export function interfaceId(iface: Interface): string {
  return `${iface.name}@${iface.major}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON Schema as hashed, with nothing an equal contract could vary: no `$schema` (it names
 * zod's dialect, not the contract), `required` sorted (field order isn't part of the contract) and
 * `$defs` renamed `d0`, `d1`, … in the order a key-sorted walk first reaches them (zod numbers them
 * in declaration order). Union options and enum values keep their order.
 */
export function normalizeSchema(schema: JsonSchema): JsonSchema {
  const defs = isObject(schema.$defs) ? schema.$defs : {};
  const names = new Map<string, string>();
  const queue: string[] = [];
  const reach = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) reach(item);
      return;
    }
    if (!isObject(value)) return;
    for (const key of Object.keys(value).sort()) {
      if (key === "$defs") continue;
      const item = value[key];
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")) {
        const old = item.slice("#/$defs/".length);
        if (!names.has(old)) {
          names.set(old, `d${names.size}`);
          queue.push(old);
        }
      } else reach(item);
    }
  };
  reach(schema);
  for (let i = 0; i < queue.length; i++) reach(defs[queue[i] as string]);
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$defs") continue;
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/"))
        out[key] = `#/$defs/${names.get(item.slice("#/$defs/".length)) ?? item}`;
      else if (
        key === "required" &&
        Array.isArray(item) &&
        item.every((r) => typeof r === "string")
      )
        out[key] = [...item].sort();
      else out[key] = rewrite(item);
    }
    return out;
  };
  const { $schema: _, ...rest } = rewrite(schema) as JsonSchema;
  if (names.size)
    rest.$defs = Object.fromEntries(
      queue.map((old) => [names.get(old) as string, rewrite(defs[old])]),
    );
  return rest;
}

function jsonSchema(id: string, where: string, schema: z.ZodType, io: "input" | "output") {
  try {
    return normalizeSchema(z.toJSONSchema(schema, { io }) as JsonSchema);
  } catch (error) {
    throw new TypeError(
      `${id} ${where}: the schema has no JSON Schema form (${error instanceof Error ? error.message : error}).`,
    );
  }
}

function interfaceSchemas(iface: Interface): InterfaceSchemas {
  const id = interfaceId(iface);
  switch (iface.kind) {
    case "rpc":
      return {
        id,
        kind: "rpc",
        methods: Object.fromEntries(
          Object.entries(iface.methods).map(([name, m]) => [
            name,
            {
              input: jsonSchema(id, `${name} input`, m.input, "input"),
              output: jsonSchema(id, `${name} output`, m.output, "output"),
            },
          ]),
        ),
        events: Object.fromEntries(
          Object.entries(iface.events).map(([name, e]) => [
            name,
            jsonSchema(id, `event ${name}`, e.payload, "output"),
          ]),
        ),
      };
    case "stream":
      return {
        id,
        kind: "stream",
        protocol: iface.protocol,
        open: jsonSchema(id, "open", iface.open, "input"),
      };
    case "http":
      return { id, kind: "http" };
  }
}

/**
 * The hash of an interface: SHA-256 over the canonical JSON of its identity and normalized JSON
 * Schemas. Everything in those schemas is contract, `.describe()` text included, so a reader can
 * recompute the hash from them alone.
 */
export function hashInterface(schemas: InterfaceSchemas): string {
  return hashOf(schemas);
}

/** The interface as it crosses the wire: identity, JSON Schemas and hash. */
export function describeInterface(iface: Interface): DescribedInterface {
  const schemas = interfaceSchemas(iface);
  return { ...schemas, hash: hashInterface(schemas) };
}

/**
 * Whether a slot's interface and an export's can be bound: `same` is the same `name@major` with
 * the same hash; `conflict` is the same `name@major` with another hash, which the Hub refuses;
 * `unrelated` is another interface.
 */
export function compareInterfaces(
  a: { id: string; hash: string },
  b: { id: string; hash: string },
): "same" | "unrelated" | "conflict" {
  if (a.id !== b.id) return "unrelated";
  return a.hash === b.hash ? "same" : "conflict";
}
