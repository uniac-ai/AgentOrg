import type { z } from "zod";
import type { Events, Interface, Methods, RpcInterface, StreamInterface } from "./interface.js";

/** Where a module runs: `host` in its own process, `view` in a sandboxed frame. */
export type Placement = "host" | "view";

/** A byte stream both ways, the same in a host process and in a view. */
export interface Duplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

interface SlotState {
  /** Whether an export is bound to this slot now; a slot may be unbound at any time. */
  readonly bound: boolean;
  /** Runs when the slot becomes bound; returns a function that removes it. */
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

/** An `rpc` export's handlers: each gets its validated input and returns its output. */
export type Handlers<M extends Methods> = {
  readonly [K in keyof M]: (
    input: z.output<M[K]["input"]>,
  ) => z.input<M[K]["output"]> | Promise<z.input<M[K]["output"]>>;
};
interface Withdrawable {
  /** Stop offering this export; bindings to it end. */
  withdraw(): void;
}
export interface RpcExport<M extends Methods, E extends Events> extends Withdrawable {
  implement(handlers: Handlers<M>): void;
  emit<K extends keyof E & string>(event: K, payload: z.input<E[K]["payload"]>): void;
}
export interface StreamExport<O extends z.ZodType> extends Withdrawable {
  accept(handler: (params: z.output<O>, stream: Duplex) => void | Promise<void>): void;
}
export interface HttpExport extends Withdrawable {
  serve(handler: (request: Request) => Response | Promise<Response>): void;
}

/**
 * The export handle of `ui.view@1`, the one in-frame interface, and so the one interface whose
 * handle isn't derived from its methods. A view renders into its own frame's DOM, which no wire
 * message can carry: the view implements `mount(el, options)` against its frame's root element,
 * and the frame runtime maps the wire methods `mount`, `resize` and `unmount` onto it. No other
 * interface should take this shape; anything else crosses the wire as schemas.
 */
export interface ViewExport<MountOptions, Size> extends Withdrawable {
  implement(view: {
    /** Render into `el`; the function returned, if any, runs at unmount. */
    mount(el: Element, options: MountOptions): (() => void) | undefined;
    resize?(size: Size): void;
  }): void;
}
export type Export<I extends Interface> =
  I extends RpcInterface<"ui.view", infer M, Events>
    ? "mount" extends keyof M
      ? "resize" extends keyof M
        ? ViewExport<
            z.output<M["mount"]["input"]>,
            z.output<M["resize"]["input"]> extends { size: infer Size } ? Size : never
          >
        : never
      : never
    : I extends RpcInterface<string, infer M, infer E>
      ? RpcExport<M, E>
      : I extends StreamInterface<string, infer O>
        ? StreamExport<O>
        : HttpExport;

/** Structured log lines, readable through the Hub by grant. */
export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type Interfaces = Record<string, Interface>;

/** Everything a module gets. There are no files, network, environment or Hub access besides. */
export interface Context<S extends Interfaces, X extends Interfaces> {
  readonly slots: { readonly [K in keyof S]: Slot<S[K]> };
  readonly exports: { readonly [K in keyof X]: Export<X[K]> } & {
    /** Offer another export at run time; consumers still bind it explicitly. */
    add<I extends Interface>(name: string, iface: I): Export<I>;
  };
  readonly self: { readonly actorId: string; readonly module: string };
  readonly log: Log;
}

/** The marker the build looks for on a module's default export. */
export const MODULE = "agentorg.module/1";

export interface ModuleDefinition<
  S extends Interfaces = Interfaces,
  X extends Interfaces = Interfaces,
> {
  readonly agentorg: typeof MODULE;
  readonly placement: Placement;
  readonly slots: S;
  readonly exports: X;
  start(ctx: Context<S, X>): void | Promise<void>;
}

type None = Record<never, Interface>;
export interface ModuleSpec<S extends Interfaces, X extends Interfaces> {
  /** Named, typed dependencies; each may be unbound and may change while the module runs. */
  slots?: S;
  /** What this module offers, each under a name. */
  exports?: X;
  start(ctx: Context<S, X>): void | Promise<void>;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;

function define<S extends Interfaces, X extends Interfaces>(
  placement: Placement,
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
  if ("add" in exports)
    throw new TypeError(`"add" is reserved for exports.add; name the export differently.`);
  return { agentorg: MODULE, placement, slots, exports, start: spec.start };
}

/** A host module: the Actor's logic, in its own process. */
export function defineActor<const S extends Interfaces = None, const X extends Interfaces = None>(
  spec: ModuleSpec<S, X>,
): ModuleDefinition<S, X> {
  return define("host", spec);
}

/** A view module: a widget, in a sandboxed frame. Same shape as an Actor's module. */
export function defineWidget<const S extends Interfaces = None, const X extends Interfaces = None>(
  spec: ModuleSpec<S, X>,
): ModuleDefinition<S, X> {
  return define("view", spec);
}

export function isModuleDefinition(value: unknown): value is ModuleDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { agentorg?: unknown }).agentorg === MODULE
  );
}
