import { NotConnected, Refused } from "./errors.js";
import type { DescribedInterface, Interface, RpcInterface, StreamInterface } from "./interface.js";
import {
  type CallInfo,
  type Context,
  type Duplex,
  type EmitOptions,
  type ExposedSlot,
  type FrameRoot,
  type InterfaceMap,
  isFrameInterface,
  type Log,
  type ModuleDefinition,
} from "./module.js";

/**
 * What serves a bound slot, as the host side sees it: one function per kind. The runtime validates
 * what goes in and comes out against the interface's schemas, as the Hub does.
 */
export interface SlotProvider {
  call?(method: string, input: unknown): Promise<unknown>;
  open?(params: unknown): Promise<Duplex>;
  fetch?(request: Request): Promise<Response>;
}
/** A bound slot, seen from the host side: it delivers the provider's events to the module. */
export interface Binding {
  emit(event: string, payload: unknown): void;
}
/**
 * A slot made at run time, as the host side gives it: the export's interface as described, whose
 * it is, and how to reach it. Values pass as they are: the Hub checks them.
 */
export interface ExposedProvider {
  described: DescribedInterface;
  provider: { actor: string; export: string };
  call(method: string, input: unknown): Promise<unknown>;
  /** Deliver an event's payloads until it ends (`onEnd`); returns how to stop. */
  subscribe(event: string, onEvent: (payload: unknown) => void, onEnd: () => void): () => void;
}
/** A mounted view, seen from the frame runtime's side. */
export interface MountedView {
  resize(size: unknown): void;
  unmount(): void;
}

/**
 * One module's context and the host side of it: bind providers to its slots and drive its
 * exports. The test context and the real runtimes are both built on this, so a module behaves the
 * same in each. Every call is checked in one order: the target is connected (`NotConnected`), the
 * input fits its schema (`Refused`, code `invalid`), the target is implemented (`Refused`, code
 * `unimplemented`), and the output fits its schema.
 */
export interface ModuleRuntime<S extends InterfaceMap, X extends InterfaceMap> {
  readonly ctx: Context<S, X>;
  start(): Promise<void>;
  bind(slot: string, provider: SlotProvider): Binding;
  unbind(slot: string): void;
  /** A bound slot's provider came back after going away: its `onBind` handlers run again. */
  usable(slot: string): void;
  /**
   * A slot made at run time is bound. Given again for one already here, it is usable again (its
   * provider came back): its events resume.
   */
  expose(slot: string, provider: ExposedProvider): void;
  /** A slot made at run time is gone with its binding. */
  unexpose(slot: string): void;
  /** Call an export's method for `caller`, the calling Actor as the Hub names it. */
  call(exportName: string, method: string, input: unknown, caller: string): Promise<unknown>;
  open(exportName: string, params: unknown, stream: Duplex): Promise<void>;
  /**
   * The two halves of `open`: checks that the export takes the stream (throwing a refusal at
   * once), then returns what runs it. A remote host answers accept or refuse in between.
   */
  accepting(exportName: string, params: unknown): (stream: Duplex) => Promise<void>;
  fetch(exportName: string, request: Request): Promise<Response>;
  /** The checking half of `fetch`: refuses at once, or returns what serves each request. */
  serving(exportName: string): (request: Request) => Promise<Response>;
  mount(exportName: string, el: FrameRoot, options: unknown): MountedView;
  withdrawn(exportName: string): boolean;
}

export interface RuntimeOptions {
  self: { actorId: string; module: string };
  log: Log;
  /** Called with each event an export emits, after validation. */
  onEmit(exportName: string, event: string, payload: unknown, to: string | undefined): void;
  /** Called when the module listens to a slot's event, so a remote host can subscribe. */
  onListen?(slot: string, event: string): void;
  /** Called when the module offers an export at run time with `exports.add`, with its handle. */
  onAdd?(name: string, iface: Interface, handle: { withdraw(): void }): void;
  /** Called when the module withdraws an export. */
  onWithdraw?(name: string): void;
}

type Schema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};

/**
 * A value checked against a schema. A caller's misfit is `Refused` with code `invalid`, and nothing
 * ran. A provider's is code `bad_output`: the provider ran and its reply or event broke the
 * contract, so the call may have had its effect; read state before retrying.
 */
export function check(
  schema: unknown,
  value: unknown,
  where: string,
  code: "invalid" | "bad_output" = "invalid",
): unknown {
  const result = (schema as Schema).safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Refused(
    code,
    `${where}: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "invalid"}`,
  );
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;
const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

interface SlotState {
  iface: Interface;
  /** A new token per bind, so a provider bound before can't reach the module after a rebind. */
  binding?: { provider: SlotProvider };
  binds: Set<() => void>;
  unbinds: Set<() => void>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
}
interface ExposedState {
  source: ExposedProvider;
  handle: ExposedSlot;
  gone: boolean;
  /** Per event: the module's listeners, and the live subscription while there are any. */
  events: Map<string, { fns: Set<(payload: unknown) => void>; stop?: () => void }>;
}
interface ExportState {
  iface: Interface;
  impl?: unknown;
  withdrawn: boolean;
}

export function createRuntime<S extends InterfaceMap, X extends InterfaceMap>(
  definition: ModuleDefinition<S, X>,
  options: RuntimeOptions,
): ModuleRuntime<S, X> {
  const slots = new Map<string, SlotState>();
  const exported = new Map<string, ExportState>();

  const slotHandle = (name: string, iface: Interface) => {
    const state: SlotState = { iface, binds: new Set(), unbinds: new Set(), listeners: new Map() };
    slots.set(name, state);
    const provider = () => {
      if (!state.binding) throw new NotConnected(name);
      return state.binding.provider;
    };
    const base = {
      get bound() {
        return state.binding !== undefined;
      },
      onBind(fn: () => void) {
        state.binds.add(fn);
        return () => void state.binds.delete(fn);
      },
      onUnbind(fn: () => void) {
        state.unbinds.add(fn);
        return () => void state.unbinds.delete(fn);
      },
    };
    switch (iface.kind) {
      case "rpc":
        return Object.assign(base, {
          call: Object.fromEntries(
            Object.entries(iface.methods).map(([method, spec]) => [
              method,
              async (input: unknown) => {
                const target = provider();
                const parsed = check(spec.input, input, `${name}.${method} input`);
                if (!target.call)
                  throw new Refused("unimplemented", `${name} isn't served by an rpc provider.`);
                return check(
                  spec.output,
                  await target.call(method, parsed),
                  `${name}.${method} output`,
                  "bad_output",
                );
              },
            ]),
          ),
          on(event: string, fn: (payload: unknown) => void) {
            if (!own(iface.events, event)) throw new TypeError(`${name} has no event ${event}.`);
            const set = state.listeners.get(event) ?? new Set();
            state.listeners.set(event, set);
            set.add(fn);
            options.onListen?.(name, event);
            return () => void set.delete(fn);
          },
        });
      case "stream":
        return Object.assign(base, {
          async open(params: unknown) {
            const target = provider();
            const parsed = check(iface.open, params, `${name} open`);
            if (!target.open)
              throw new Refused("unimplemented", `${name} isn't served by a stream provider.`);
            return target.open(parsed);
          },
        });
      case "http":
        return Object.assign(base, {
          async fetch(request: Request) {
            const target = provider();
            if (!target.fetch)
              throw new Refused("unimplemented", `${name} isn't served by an http provider.`);
            return target.fetch(request);
          },
        });
    }
  };

  const exportHandle = (name: string, iface: Interface) => {
    const state: ExportState = { iface, withdrawn: false };
    exported.set(name, state);
    const live = () => {
      if (state.withdrawn) throw new NotConnected(name);
    };
    const withdraw = () => {
      if (state.withdrawn) return;
      state.withdrawn = true;
      options.onWithdraw?.(name);
    };
    const store = (impl: unknown) => {
      live();
      state.impl = impl;
    };
    if (isFrameInterface(iface)) return { implement: store, withdraw };
    switch (iface.kind) {
      case "rpc":
        return {
          implement: store,
          emit(event: string, payload: unknown, emitting?: EmitOptions) {
            live();
            const spec = own(iface.events, event);
            if (!spec) throw new TypeError(`${name} has no event ${event}.`);
            options.onEmit(
              name,
              event,
              check(spec.payload, payload, `${name}.${event} payload`),
              emitting?.to,
            );
          },
          withdraw,
        };
      case "stream":
        return { accept: store, withdraw };
      case "http":
        return { serve: store, withdraw };
    }
  };

  /** A connected export of the expected kind; implemented or not is checked after its input. */
  const target = (name: string, kind: "rpc" | "stream" | "http" | "frame") => {
    const state = exported.get(name);
    if (!state || state.withdrawn) throw new NotConnected(name);
    const frame = isFrameInterface(state.iface);
    if (frame !== (kind === "frame") || (!frame && state.iface.kind !== kind))
      throw new TypeError(
        `${name} isn't ${kind === "frame" ? "a ui.view@1" : `an ${kind}`} export.`,
      );
    return state;
  };
  const implemented = <T>(state: ExportState, name: string): T => {
    if (state.impl === undefined)
      throw new Refused("unimplemented", `${name} hasn't been implemented yet.`);
    return state.impl as T;
  };

  const exposed = new Map<string, ExposedState>();
  const exposedWatchers = new Set<() => void>();

  /** Run the `onExposed` handlers; one that throws is logged and the rest still run. */
  const exposedChanged = () => {
    const failed = (error: unknown) =>
      options.log.error("An onExposed handler threw.", { error: String(error) });
    for (const fn of [...exposedWatchers])
      try {
        const done = fn() as unknown;
        if (done instanceof Promise) done.catch(failed);
      } catch (error) {
        failed(error);
      }
  };

  /** Subscribe to an exposed slot's event while the module listens and nothing is live. */
  const listenExposed = (slot: string, state: ExposedState, event: string) => {
    const entry = state.events.get(event);
    if (state.gone || !entry || entry.stop || !entry.fns.size) return;
    // A subscription may end before `subscribe` returns: then nothing is live.
    let ended = false;
    let stop: (() => void) | undefined;
    stop = state.source.subscribe(
      event,
      (payload) => {
        for (const fn of [...entry.fns])
          try {
            fn(payload);
          } catch (error) {
            options.log.error("An event handler threw.", { slot, event, error: String(error) });
          }
      },
      // Ended by the provider going: the interest stays for when it is usable again.
      () => {
        ended = true;
        if (entry.stop === stop) entry.stop = undefined;
      },
    );
    if (!ended) entry.stop = stop;
  };

  const exposedHandle = (slot: string, state: ExposedState): ExposedSlot => {
    const { described, provider } = state.source;
    return Object.freeze({
      slot,
      described,
      provider: Object.freeze({ actor: provider.actor, export: provider.export }),
      call: Object.freeze(
        Object.fromEntries(
          (described.kind === "rpc" ? Object.keys(described.methods) : []).map((method) => [
            method,
            async (input: unknown) => {
              if (state.gone) throw new NotConnected(slot);
              return state.source.call(method, input);
            },
          ]),
        ),
      ),
      on(event: string, fn: (payload: unknown) => void) {
        if (described.kind !== "rpc" || !own(described.events, event))
          throw new TypeError(`${slot} has no event ${event}.`);
        const entry = state.events.get(event) ?? { fns: new Set() };
        state.events.set(event, entry);
        entry.fns.add(fn);
        listenExposed(slot, state, event);
        return () => {
          entry.fns.delete(fn);
          if (entry.fns.size) return;
          entry.stop?.();
          entry.stop = undefined;
        };
      },
    });
  };

  const unexpose = (slot: string) => {
    const state = exposed.get(slot);
    if (!state) return;
    exposed.delete(slot);
    state.gone = true;
    for (const entry of state.events.values()) {
      entry.stop?.();
      entry.stop = undefined;
    }
    exposedChanged();
  };

  const expose = (slot: string, source: ExposedProvider) => {
    const here = exposed.get(slot);
    if (
      here &&
      here.source.described.hash === source.described.hash &&
      here.source.provider.actor === source.provider.actor &&
      here.source.provider.export === source.provider.export
    ) {
      // Usable again: the same export, its provider back. What was listened to resumes.
      here.source = source;
      for (const [event, entry] of here.events) {
        entry.stop?.();
        entry.stop = undefined;
        listenExposed(slot, here, event);
      }
      return;
    }
    if (here) unexpose(slot);
    // The handle reads the state, so it is made after; nothing reads it in between.
    const state = { source, gone: false, events: new Map() } as unknown as ExposedState;
    state.handle = exposedHandle(slot, state);
    exposed.set(slot, state);
    exposedChanged();
  };

  const ctx = {
    slots: Object.fromEntries(
      Object.entries(definition.slots).map(([name, iface]) => [name, slotHandle(name, iface)]),
    ),
    exports: Object.assign(
      Object.fromEntries(
        Object.entries(definition.exports).map(([name, iface]) => [
          name,
          exportHandle(name, iface),
        ]),
      ),
      {
        add(name: string, iface: Interface) {
          if (!NAME.test(name) || name === "add")
            throw new TypeError(`${JSON.stringify(name)} isn't a valid export name.`);
          const existing = exported.get(name);
          if (existing && !existing.withdrawn)
            throw new TypeError(`An export named ${name} is already offered.`);
          const handle = exportHandle(name, iface);
          options.onAdd?.(name, iface, handle);
          return handle;
        },
      },
    ),
    self: options.self,
    log: options.log,
    exposed: () => Object.freeze([...exposed.values()].map((state) => state.handle)),
    onExposed(fn: () => void) {
      exposedWatchers.add(fn);
      return () => void exposedWatchers.delete(fn);
    },
  } as unknown as Context<S, X>;

  const serving = (exportName: string) => {
    const state = target(exportName, "http");
    const handler = implemented<(request: Request) => Response | Promise<Response>>(
      state,
      exportName,
    );
    return async (request: Request) => handler(request);
  };

  const accepting = (exportName: string, params: unknown) => {
    const state = target(exportName, "stream");
    const parsed = check((state.iface as StreamInterface).open, params, `${exportName} open`);
    const handler = implemented<(params: unknown, stream: Duplex) => void | Promise<void>>(
      state,
      exportName,
    );
    return async (stream: Duplex) => {
      await handler(parsed, stream);
    };
  };

  /** Run a slot's bind or unbind handlers; one that throws is logged and the rest still run. */
  const notify = (slot: string, handlers: Set<() => void>) => {
    const failed = (error: unknown) =>
      options.log.error("A slot handler threw.", { slot, error: String(error) });
    for (const fn of [...handlers])
      try {
        // A handler may be async; its rejection is logged the same way.
        const done = fn() as unknown;
        if (done instanceof Promise) done.catch(failed);
      } catch (error) {
        failed(error);
      }
  };

  const unbind = (slot: string) => {
    const state = slots.get(slot);
    if (!state) throw new TypeError(`No slot ${slot}.`);
    if (!state.binding) return;
    state.binding = undefined;
    notify(slot, state.unbinds);
  };

  return {
    ctx,
    async start() {
      await definition.start(ctx);
    },
    bind(slot, provider) {
      const state = slots.get(slot);
      if (!state) throw new TypeError(`No slot ${slot}.`);
      unbind(slot);
      const binding = { provider };
      state.binding = binding;
      notify(slot, state.binds);
      return {
        emit(event, payload) {
          const iface = state.iface;
          const spec = iface.kind === "rpc" ? own(iface.events, event) : undefined;
          if (!spec) throw new TypeError(`${slot} has no event ${event}.`);
          const value = check(spec.payload, payload, `${slot}.${event}`, "bad_output");
          if (state.binding !== binding) return;
          for (const fn of [...(state.listeners.get(event) ?? [])]) fn(value);
        },
      };
    },
    unbind,
    usable(slot) {
      const state = slots.get(slot);
      if (!state) throw new TypeError(`No slot ${slot}.`);
      if (state.binding) notify(slot, state.binds);
    },
    expose,
    unexpose,
    async call(exportName, method, input, caller) {
      const state = target(exportName, "rpc");
      const spec = own((state.iface as RpcInterface).methods, method);
      if (!spec) throw new TypeError(`${exportName} has no method ${method}.`);
      const parsed = check(spec.input, input, `${exportName}.${method} input`);
      const handler = own(
        implemented<Record<string, (input: unknown, call: CallInfo) => unknown>>(state, exportName),
        method,
      );
      if (!handler)
        throw new Refused("unimplemented", `${exportName}.${method} isn't implemented.`);
      return check(
        spec.output,
        await handler(parsed, { caller }),
        `${exportName}.${method} output`,
        "bad_output",
      );
    },
    accepting,
    async open(exportName, params, stream) {
      await accepting(exportName, params)(stream);
    },
    serving,
    async fetch(exportName, request) {
      return serving(exportName)(request);
    },
    mount(exportName, el, options) {
      const state = target(exportName, "frame");
      const methods = (state.iface as RpcInterface).methods;
      const parsed = check(methods.mount?.input, options, `${exportName} mount`);
      const view = implemented<{
        mount(el: FrameRoot, options: unknown): (() => void) | undefined;
        resize?(size: unknown): void;
      }>(state, exportName);
      const cleanup = view.mount(el, parsed);
      return {
        resize(size) {
          const { size: checked } = check(
            methods.resize?.input,
            { size },
            `${exportName} resize`,
          ) as {
            size: unknown;
          };
          view.resize?.(checked);
        },
        unmount() {
          cleanup?.();
        },
      };
    },
    withdrawn(exportName) {
      return exported.get(exportName)?.withdrawn ?? false;
    },
  };
}
