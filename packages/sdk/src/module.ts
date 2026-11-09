import type { z } from "zod";
import type {
  DescribedInterface,
  Events,
  Interface,
  Methods,
  RpcInterface,
  StreamInterface,
} from "./interface.js";

/** A byte stream both ways. */
export interface Duplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

interface SlotState {
  /** Whether an export is bound to this slot now; a slot may be unbound at any time. */
  readonly bound: boolean;
  /**
   * Runs when the slot becomes usable: newly bound, or its provider came back after going away.
   * Events sent meanwhile were missed, so this is where to read state again. Returns a function
   * that removes it.
   */
  onBind(fn: () => void): () => void;
  /** Runs when the slot becomes unbound; returns a function that removes it. */
  onUnbind(fn: () => void): () => void;
}
/** A slot of an `rpc` interface. A call on an unbound slot throws `NotConnected`. */
export interface RpcSlot<M extends Methods, E extends Events> extends SlotState {
  readonly call: {
    readonly [K in keyof M]: (input: z.input<M[K]["input"]>) => Promise<z.output<M[K]["output"]>>;
  };
  /** Live events from the bound export, at most once; returns a function that unsubscribes. */
  on<K extends keyof E & string>(
    event: K,
    fn: (payload: z.output<E[K]["payload"]>) => void,
  ): () => void;
}
/** A slot of a `stream` interface: opening it gives a byte stream in the interface's protocol. */
export interface StreamSlot<O extends z.ZodType> extends SlotState {
  open(params: z.input<O>): Promise<Duplex>;
}
/** A slot of an `http` interface. */
export interface HttpSlot extends SlotState {
  fetch(request: Request): Promise<Response>;
}
export type Slot<I extends Interface> =
  I extends RpcInterface<string, infer M, infer E>
    ? RpcSlot<M, E>
    : I extends StreamInterface<string, infer O>
      ? StreamSlot<O>
      : HttpSlot;

/** Who made a call: the calling Actor, as the Hub names it. */
export interface CallInfo {
  readonly caller: string;
}
/**
 * An `rpc` export's handlers: each gets its validated input, and who called, and returns its
 * output.
 */
export type Handlers<M extends Methods> = {
  readonly [K in keyof M]: (
    input: z.output<M[K]["input"]>,
    call: CallInfo,
  ) => z.input<M[K]["output"]> | Promise<z.input<M[K]["output"]>>;
};
/**
 * Where an event goes: `to` one subscribing Actor only (every subscription that Actor holds), or,
 * without it, every subscriber.
 */
export interface EmitOptions {
  readonly to?: string;
}
export interface RpcExport<M extends Methods, E extends Events> {
  implement(handlers: Handlers<M>): void;
  emit<K extends keyof E & string>(
    event: K,
    payload: z.input<E[K]["payload"]>,
    options?: EmitOptions,
  ): void;
}
export interface StreamExport<O extends z.ZodType> {
  accept(handler: (params: z.output<O>, stream: Duplex) => void | Promise<void>): void;
}
export interface HttpExport {
  serve(handler: (request: Request) => Response | Promise<Response>): void;
}

export type Export<I extends Interface> =
  I extends RpcInterface<string, infer M, infer E>
    ? RpcExport<M, E>
    : I extends StreamInterface<string, infer O>
      ? StreamExport<O>
      : HttpExport;

/** Structured log lines. */
export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Slots or exports: names to interfaces. */
export type InterfaceMap = Record<string, Interface>;
export type ExportMap = InterfaceMap;

/**
 * A slot made at run time: another Actor's export, exposed to this Actor with `hub.grants.expose`
 * rather than declared by this Actor. It is here exactly while it is bound. Its values are JSON,
 * checked against `described` by the Hub both ways, not here, so a misfit comes back as
 * `Refused` (code `invalid`). A call on a slot that's gone, or whose provider isn't running, throws
 * `NotConnected`, as a declared slot's does.
 */
export interface ExposedSlot {
  /** Its name on this Actor. */
  readonly slot: string;
  /** The export's interface: its methods' input and output JSON Schemas, and its events'. */
  readonly described: DescribedInterface;
  /** Whose export it is. */
  readonly provider: { readonly actor: string; readonly export: string };
  /** One function per method of an `rpc` interface; none for another kind. */
  readonly call: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
  /** Live events from the export while the slot is here; returns a function that unsubscribes. */
  on(event: string, fn: (payload: unknown) => void): () => void;
}

/** Everything a program gets from the Hub. */
export interface Context<S extends InterfaceMap, X extends InterfaceMap> {
  readonly slots: { readonly [K in keyof S]: Slot<S[K]> };
  readonly exports: { readonly [K in keyof X]: Export<X[K]> };
  readonly self: { readonly actorId: string; readonly module: string };
  readonly log: Log;
  /**
   * The slots made for this Actor at run time and bound now, in the order they came.
   */
  exposed(): readonly ExposedSlot[];
  /** Runs after one is added or removed, so `exposed()` is read again; returns how to stop it. */
  onExposed(fn: () => void): () => void;
}

export interface ModuleDefinition<
  S extends InterfaceMap = InterfaceMap,
  X extends InterfaceMap = InterfaceMap,
> {
  readonly slots: S;
  readonly exports: X;
  start(ctx: Context<S, X>): void | Promise<void>;
}

type None = Record<never, Interface>;
export interface ModuleSpec<S extends InterfaceMap, X extends InterfaceMap> {
  /** Named, typed dependencies; each may be unbound and may change while the module runs. */
  slots?: S;
  /** What this module offers, each under a name. */
  exports?: X;
  start(ctx: Context<S, X>): void | Promise<void>;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;

/** A program's handles, by name: what `connect` runs. */
export function defineActor<const S extends InterfaceMap = None, const X extends ExportMap = None>(
  spec: ModuleSpec<S, X>,
): ModuleDefinition<S, X> {
  const slots = spec.slots ?? ({} as S);
  const exports = spec.exports ?? ({} as X);
  for (const [what, names] of [
    ["slot", Object.keys(slots)],
    ["export", Object.keys(exports)],
  ] as const)
    for (const name of names)
      if (!NAME.test(name))
        throw new TypeError(`${JSON.stringify(name)} isn't a valid ${what} name.`);
  return { slots, exports, start: spec.start };
}
