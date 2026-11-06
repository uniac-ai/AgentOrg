import { NotConnected, Refused } from "./errors.js";
import type { Interface, RpcInterface, StreamInterface } from "./interface.js";
import {
  type Context,
  type Duplex,
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
  call(exportName: string, method: string, input: unknown): Promise<unknown>;
  open(exportName: string, params: unknown, stream: Duplex): Promise<void>;
  fetch(exportName: string, request: Request): Promise<Response>;
  mount(exportName: string, el: FrameRoot, options: unknown): MountedView;
  withdrawn(exportName: string): boolean;
}

export interface RuntimeOptions {
  self: { actorId: string; module: string };
  log: Log;
  /** Called with each event an export emits, after validation. */
  onEmit(exportName: string, event: string, payload: unknown): void;
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
      state.withdrawn = true;
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
          emit(event: string, payload: unknown) {
            live();
            const spec = own(iface.events, event);
            if (!spec) throw new TypeError(`${name} has no event ${event}.`);
            options.onEmit(name, event, check(spec.payload, payload, `${name}.${event} payload`));
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
          return exportHandle(name, iface);
        },
      },
    ),
    self: options.self,
    log: options.log,
  } as unknown as Context<S, X>;

  const unbind = (slot: string) => {
    const state = slots.get(slot);
    if (!state) throw new TypeError(`No slot ${slot}.`);
    if (!state.binding) return;
    state.binding = undefined;
    for (const fn of [...state.unbinds]) fn();
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
      for (const fn of [...state.binds]) fn();
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
    async call(exportName, method, input) {
      const state = target(exportName, "rpc");
      const spec = own((state.iface as RpcInterface).methods, method);
      if (!spec) throw new TypeError(`${exportName} has no method ${method}.`);
      const parsed = check(spec.input, input, `${exportName}.${method} input`);
      const handler = own(
        implemented<Record<string, (input: unknown) => unknown>>(state, exportName),
        method,
      );
      if (!handler)
        throw new Refused("unimplemented", `${exportName}.${method} isn't implemented.`);
      return check(
        spec.output,
        await handler(parsed),
        `${exportName}.${method} output`,
        "bad_output",
      );
    },
    async open(exportName, params, stream) {
      const state = target(exportName, "stream");
      const parsed = check((state.iface as StreamInterface).open, params, `${exportName} open`);
      await implemented<(params: unknown, stream: Duplex) => void | Promise<void>>(
        state,
        exportName,
      )(parsed, stream);
    },
    async fetch(exportName, request) {
      const state = target(exportName, "http");
      return implemented<(request: Request) => Response | Promise<Response>>(
        state,
        exportName,
      )(request);
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
