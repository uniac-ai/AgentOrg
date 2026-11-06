import { NotConnected, Refused } from "./errors.js";
import type { Interface, RpcInterface, StreamInterface } from "./interface.js";
import type { Context, Duplex, Handlers, Interfaces, Log, ModuleDefinition } from "./module.js";

/** What a test binds to a slot in place of a real export. */
export type Provider<I extends Interface> =
  I extends RpcInterface<string, infer M>
    ? Partial<Handlers<M>>
    : I extends StreamInterface<string, infer O>
      ? (params: import("zod").output<O>) => Duplex | Promise<Duplex>
      : (request: Request) => Response | Promise<Response>;

/** A bound fake: it can push events to the module's subscribers on that slot. */
export interface BoundProvider {
  emit(event: string, payload: unknown): void;
}

export interface Emitted {
  export: string;
  event: string;
  payload: unknown;
}
export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

/**
 * A module's context without a Hub, for tests: bind fakes to its slots, call its exports, and read
 * what it emitted and logged. Every call is validated against the interface's schemas as the Hub
 * would: bad input is `Refused` with code `invalid`, and an unbound slot throws `NotConnected`.
 */
export interface TestContext<S extends Interfaces, X extends Interfaces> {
  readonly ctx: Context<S, X>;
  /** Run the module's `start`. */
  start(): Promise<void>;
  bind<K extends keyof S & string>(slot: K, provider: Provider<S[K]>): BoundProvider;
  unbind(slot: keyof S & string): void;
  /** Call an `rpc` export's method, as a consumer bound to it would. */
  call(exportName: string, method: string, input: unknown): Promise<unknown>;
  /** Hand a stream to a `stream` export, as a consumer opening it would. */
  open(exportName: string, params: unknown, stream: Duplex): Promise<void>;
  /** Send a request to an `http` export. */
  fetch(exportName: string, request: Request): Promise<Response>;
  /** Mount a `ui.view@1` export into an element, as a frame runtime would. */
  mount(exportName: string, el: Element, options: unknown): (() => void) | undefined;
  readonly emitted: Emitted[];
  readonly logs: LogLine[];
  withdrawn(exportName: string): boolean;
}

type Schema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};

function parse(schema: unknown, value: unknown, code: string, where: string): unknown {
  const result = (schema as Schema).safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Refused(
    code,
    `${where}: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "invalid"}`,
  );
}

const isView = (iface: Interface) => iface.kind === "rpc" && iface.name === "ui.view";

interface SlotRecord {
  iface: Interface;
  provider?: unknown;
  binds: Set<() => void>;
  unbinds: Set<() => void>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
}
interface ExportRecord {
  iface: Interface;
  impl?: unknown;
  withdrawn: boolean;
}

export function createTestContext<S extends Interfaces, X extends Interfaces>(
  definition: ModuleDefinition<S, X>,
  options: { actorId?: string; module?: string } = {},
): TestContext<S, X> {
  const emitted: Emitted[] = [];
  const logs: LogLine[] = [];
  const slots = new Map<string, SlotRecord>();
  const exported = new Map<string, ExportRecord>();

  const slotHandle = (name: string, iface: Interface) => {
    const record: SlotRecord = {
      iface,
      binds: new Set(),
      unbinds: new Set(),
      listeners: new Map(),
    };
    slots.set(name, record);
    const provider = () => {
      if (record.provider === undefined) throw new NotConnected(name);
      return record.provider;
    };
    const state = {
      get bound() {
        return record.provider !== undefined;
      },
      onBind(fn: () => void) {
        record.binds.add(fn);
        return () => record.binds.delete(fn);
      },
      onUnbind(fn: () => void) {
        record.unbinds.add(fn);
        return () => record.unbinds.delete(fn);
      },
    };
    switch (iface.kind) {
      case "rpc":
        return Object.assign(state, {
          call: Object.fromEntries(
            Object.entries(iface.methods).map(([method, spec]) => [
              method,
              async (input: unknown) => {
                const handlers = provider() as Record<string, (input: unknown) => unknown>;
                const parsed = parse(spec.input, input, "invalid", `${name}.${method} input`);
                const handler = handlers[method];
                if (!handler)
                  throw new Refused("unimplemented", `${name}.${method} isn't implemented.`);
                return parse(
                  spec.output,
                  await handler(parsed),
                  "invalid",
                  `${name}.${method} output`,
                );
              },
            ]),
          ),
          on(event: string, fn: (payload: unknown) => void) {
            if (!(event in iface.events)) throw new TypeError(`${name} has no event ${event}.`);
            const set = record.listeners.get(event) ?? new Set();
            record.listeners.set(event, set);
            set.add(fn);
            return () => set.delete(fn);
          },
        });
      case "stream":
        return Object.assign(state, {
          async open(params: unknown) {
            const open = provider() as (params: unknown) => Duplex | Promise<Duplex>;
            return open(parse(iface.open, params, "invalid", `${name} open`));
          },
        });
      case "http":
        return Object.assign(state, {
          async fetch(request: Request) {
            return (provider() as (request: Request) => Response | Promise<Response>)(request);
          },
        });
    }
  };

  const exportHandle = (name: string, iface: Interface) => {
    const record: ExportRecord = { iface, withdrawn: false };
    exported.set(name, record);
    const withdraw = () => {
      record.withdrawn = true;
    };
    const store = (impl: unknown) => {
      record.impl = impl;
    };
    if (isView(iface)) return { implement: store, withdraw };
    switch (iface.kind) {
      case "rpc":
        return {
          implement: store,
          emit(event: string, payload: unknown) {
            const spec = iface.events[event];
            if (!spec) throw new TypeError(`${name} has no event ${event}.`);
            emitted.push({
              export: name,
              event,
              payload: parse(spec.payload, payload, "invalid", `${name}.${event} payload`),
            });
          },
          withdraw,
        };
      case "stream":
        return { accept: store, withdraw };
      case "http":
        return { serve: store, withdraw };
    }
  };

  const exportRecord = (name: string, kind: "rpc" | "stream" | "http" | "view") => {
    const record = exported.get(name);
    if (!record || record.withdrawn) throw new NotConnected(name);
    if (
      (kind === "view") !== isView(record.iface) ||
      (kind !== "view" && record.iface.kind !== kind)
    )
      throw new TypeError(`${name} isn't a ${kind} export.`);
    if (record.impl === undefined)
      throw new Refused("unimplemented", `${name} hasn't been implemented yet.`);
    return record;
  };

  const line = (level: LogLine["level"]) => (message: string, fields?: Record<string, unknown>) =>
    void logs.push(fields === undefined ? { level, message } : { level, message, fields });
  const log: Log = { info: line("info"), warn: line("warn"), error: line("error") };

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
          if (name === "add" || exported.has(name))
            throw new TypeError(`An export named ${name} already exists.`);
          return exportHandle(name, iface);
        },
      },
    ),
    self: { actorId: options.actorId ?? "test-actor", module: options.module ?? "main" },
    log,
  } as unknown as Context<S, X>;

  const unbind = (slot: string) => {
    const record = slots.get(slot);
    if (!record) throw new TypeError(`No slot ${slot}.`);
    if (record.provider === undefined) return;
    record.provider = undefined;
    for (const fn of record.unbinds) fn();
  };

  return {
    ctx,
    async start() {
      await definition.start(ctx);
    },
    bind(slot, provider) {
      const record = slots.get(slot);
      if (!record) throw new TypeError(`No slot ${slot}.`);
      unbind(slot);
      record.provider = provider;
      for (const fn of record.binds) fn();
      return {
        emit(event, payload) {
          const iface = record.iface;
          if (iface.kind !== "rpc" || !iface.events[event])
            throw new TypeError(`${slot} has no event ${event}.`);
          const value = parse(iface.events[event].payload, payload, "invalid", `${slot}.${event}`);
          if (record.provider !== provider) return;
          for (const fn of record.listeners.get(event) ?? []) fn(value);
        },
      };
    },
    unbind,
    async call(exportName, method, input) {
      const record = exportRecord(exportName, "rpc");
      const iface = record.iface as RpcInterface;
      const spec = iface.methods[method];
      if (!spec) throw new TypeError(`${exportName} has no method ${method}.`);
      const handler = (record.impl as Record<string, (input: unknown) => unknown>)[method];
      if (!handler)
        throw new Refused("unimplemented", `${exportName}.${method} isn't implemented.`);
      const parsed = parse(spec.input, input, "invalid", `${exportName}.${method} input`);
      return parse(spec.output, await handler(parsed), "invalid", `${exportName}.${method} output`);
    },
    async open(exportName, params, stream) {
      const record = exportRecord(exportName, "stream");
      const iface = record.iface as StreamInterface;
      await (record.impl as (params: unknown, stream: Duplex) => void | Promise<void>)(
        parse(iface.open, params, "invalid", `${exportName} open`),
        stream,
      );
    },
    async fetch(exportName, request) {
      const record = exportRecord(exportName, "http");
      return (record.impl as (request: Request) => Response | Promise<Response>)(request);
    },
    mount(exportName, el, options) {
      const record = exportRecord(exportName, "view");
      const iface = record.iface as RpcInterface;
      const mountSpec = iface.methods.mount;
      const parsed = mountSpec
        ? parse(mountSpec.input, options, "invalid", `${exportName} mount`)
        : options;
      return (
        record.impl as { mount(el: Element, options: unknown): (() => void) | undefined }
      ).mount(el, parsed);
    },
    emitted,
    logs,
    withdrawn(exportName) {
      return exported.get(exportName)?.withdrawn ?? false;
    },
  };
}
