import { z } from "zod";
import { hashOf } from "./canonical.js";

/** One request and its reply on an `rpc` interface. */
export interface Method<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly input: I;
  readonly output: O;
}
/** One event an `rpc` interface's provider emits: live, delivered at most once. */
export interface Event<P extends z.ZodType = z.ZodType> {
  readonly payload: P;
}
export type Methods = Record<string, Method>;
export type Events = Record<string, Event>;
type NoEvents = Record<never, Event>;

export function method<I extends z.ZodType, O extends z.ZodType>(spec: {
  input: I;
  output: O;
}): Method<I, O> {
  return { input: spec.input, output: spec.output };
}
export function event<P extends z.ZodType>(payload: P): Event<P> {
  return { payload };
}

interface Named<N extends string> {
  readonly name: N;
  readonly major: number;
}
/** Requests, replies and events, each typed by a schema; one stream per call or subscription. */
export interface RpcInterface<
  N extends string = string,
  M extends Methods = Methods,
  E extends Events = Events,
> extends Named<N> {
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
>(spec: { name: N; major: number; kind: "rpc"; methods: M; events?: E }): RpcInterface<N, M, E>;
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
/** An interface as the manifest records it, without its hash. */
export type InterfaceDescription =
  | {
      kind: "rpc";
      methods: Record<string, { input: JsonSchema; output: JsonSchema }>;
      events: Record<string, JsonSchema>;
    }
  | { kind: "stream"; protocol: string; open: JsonSchema }
  | { kind: "http" };
/** An interface as the manifest records it. */
export type DescribedInterface = InterfaceDescription & { hash: string };

/** `name@major`, the identity a slot and an export must share. */
export function interfaceId(iface: Interface): string {
  return `${iface.name}@${iface.major}`;
}

function jsonSchema(id: string, where: string, schema: z.ZodType, io: "input" | "output") {
  try {
    return z.toJSONSchema(schema, { io }) as JsonSchema;
  } catch (error) {
    throw new TypeError(
      `${id} ${where}: the schema has no JSON Schema form (${error instanceof Error ? error.message : error}).`,
    );
  }
}

/** The JSON Schemas of an interface's methods and events, or of its stream's open parameters. */
export function interfaceDescription(iface: Interface): InterfaceDescription {
  const id = interfaceId(iface);
  switch (iface.kind) {
    case "rpc":
      return {
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
        kind: "stream",
        protocol: iface.protocol,
        open: jsonSchema(id, "open", iface.open, "input"),
      };
    case "http":
      return { kind: "http" };
  }
}

/** The hash of an interface's identity and canonical schemas; a reader recomputes it from the manifest. */
export function hashInterface(id: string, description: InterfaceDescription): string {
  return hashOf({ id, ...description });
}

/** The interface's manifest entry: its description and hash. */
export function describeInterface(iface: Interface): DescribedInterface {
  const description = interfaceDescription(iface);
  return { ...description, hash: hashInterface(interfaceId(iface), description) };
}

/**
 * Whether a slot's interface and an export's can be bound: the same `name@major` with the same
 * hash. The same identity with another hash is a mismatch, which the Hub refuses.
 */
export function compareInterfaces(
  a: { id: string; hash: string },
  b: { id: string; hash: string },
): "same" | "different" | "mismatch" {
  if (a.id !== b.id) return "different";
  return a.hash === b.hash ? "same" : "mismatch";
}
