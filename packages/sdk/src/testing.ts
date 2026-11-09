import type { z } from "zod";
import { Refused } from "./errors.js";
import {
  describeInterface,
  type Interface,
  type RpcInterface,
  type StreamInterface,
} from "./interface.js";
import type { CallInfo, Duplex, Handlers, InterfaceMap, Log, ModuleDefinition } from "./module.js";
import {
  type Binding,
  check,
  createRuntime,
  type ModuleRuntime,
  type SlotProvider,
} from "./runtime.js";

/** A fake bound to a slot in a test: handlers for `rpc`, a function for `stream` and `http`. */
export type Provider<I extends Interface> =
  I extends RpcInterface<string, infer M>
    ? Partial<Handlers<M>>
    : I extends StreamInterface<string, infer O>
      ? (params: z.output<O>) => Duplex | Promise<Duplex>
      : (request: Request) => Response | Promise<Response>;

export interface Emitted {
  export: string;
  event: string;
  payload: unknown;
  /** The one Actor it was sent to; absent when it went to every subscriber. */
  to?: string;
}
export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

/**
 * A module run without a Hub, for tests: bind fakes to its slots, drive its exports, and read what
 * it emitted and logged. It runs on the same runtime as a real module, so every call is validated
 * as the Hub validates it: bad input is `Refused` with code `invalid`, and an unbound slot throws
 * `NotConnected`.
 */
export interface TestContext<S extends InterfaceMap, X extends InterfaceMap>
  extends Omit<ModuleRuntime<S, X>, "bind" | "call" | "expose"> {
  bind<K extends keyof S & string>(slot: K, provider: Provider<S[K]>): Binding;
  /**
   * Make a slot at run time, as `hub.grants.expose` does: an `rpc` export faked by `handlers`,
   * whose values are checked against `iface` as the Hub checks them. `provider` names whose
   * export it is (by default a made-up Actor's, `export`). Exposing the same slot again with the
   * same interface and provider makes it usable again; `emit` sends its events.
   */
  expose<I extends RpcInterface>(
    slot: string,
    iface: I,
    handlers: Provider<I>,
    provider?: { actor: string; export: string },
  ): Binding;
  /** The slot made at run time goes, as when its binding is removed. */
  unexpose(slot: string): void;
  /** Call an export as `caller`; by default as the module's own Actor. */
  call(exportName: string, method: string, input: unknown, caller?: string): Promise<unknown>;
  readonly emitted: Emitted[];
  readonly logs: LogLine[];
}

export function createTestContext<S extends InterfaceMap, X extends InterfaceMap>(
  definition: ModuleDefinition<S, X>,
  options: { actorId?: string; module?: string } = {},
): TestContext<S, X> {
  const emitted: Emitted[] = [];
  const logs: LogLine[] = [];
  const line = (level: LogLine["level"]) => (message: string, fields?: Record<string, unknown>) =>
    void logs.push(fields === undefined ? { level, message } : { level, message, fields });
  const log: Log = { info: line("info"), warn: line("warn"), error: line("error") };
  const self = options.actorId ?? "test-actor";
  const runtime = createRuntime(definition, {
    self: { actorId: self, module: options.module ?? "main" },
    log,
    onEmit: (exportName, event, payload, to) =>
      void emitted.push({
        export: exportName,
        event,
        payload,
        ...(to === undefined ? {} : { to }),
      }),
  });
  return {
    ...runtime,
    call: (exportName, method, input, caller = self) =>
      runtime.call(exportName, method, input, caller),
    bind(slot, fake) {
      const iface = definition.slots[slot] as Interface;
      let provider: SlotProvider;
      if (iface.kind === "rpc") {
        const handlers = fake as Record<
          string,
          ((input: unknown, call: CallInfo) => unknown) | undefined
        >;
        // The module itself is the caller of its own slot.
        const call = { caller: self };
        provider = {
          async call(method, input) {
            const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
            if (!handler) throw new Refused("unimplemented", `${slot}.${method} isn't faked.`);
            return handler(input, call);
          },
        };
      } else if (iface.kind === "stream") {
        const open = fake as (params: unknown) => Duplex | Promise<Duplex>;
        provider = { open: async (params) => open(params) };
      } else {
        const fetch = fake as (request: Request) => Response | Promise<Response>;
        provider = { fetch: async (request) => fetch(request) };
      }
      return runtime.bind(slot, provider);
    },
    expose(slot, iface, fake, provider = { actor: "test-provider", export: "export" }) {
      const handlers = fake as Record<
        string,
        ((input: unknown, call: CallInfo) => unknown) | undefined
      >;
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      runtime.expose(slot, {
        described: describeInterface(iface),
        provider,
        async call(method, input) {
          const spec = Object.hasOwn(iface.methods, method) ? iface.methods[method] : undefined;
          if (!spec) throw new Refused("unknown", `${slot} has no method ${method}.`);
          // JSON both ways, as through the Hub, and checked as JSON.
          const parsed = check(
            spec.input,
            JSON.parse(JSON.stringify(input ?? null)),
            `${slot}.${method} input`,
          );
          const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
          if (!handler) throw new Refused("unimplemented", `${slot}.${method} isn't faked.`);
          const output = check(
            spec.output,
            await handler(parsed, { caller: self }),
            `${slot}.${method} output`,
            "bad_output",
          );
          return JSON.parse(JSON.stringify(output ?? null));
        },
        subscribe(event, onEvent) {
          const set = listeners.get(event) ?? new Set();
          listeners.set(event, set);
          set.add(onEvent);
          return () => void set.delete(onEvent);
        },
      });
      return {
        emit(event, payload) {
          const spec = Object.hasOwn(iface.events, event) ? iface.events[event] : undefined;
          if (!spec) throw new TypeError(`${slot} has no event ${event}.`);
          const value = JSON.parse(
            JSON.stringify(check(spec.payload, payload, `${slot}.${event}`, "bad_output")),
          );
          for (const fn of [...(listeners.get(event) ?? [])]) fn(value);
        },
      };
    },
    unexpose: (slot) => runtime.unexpose(slot),
    emitted,
    logs,
  };
}

export type { Binding } from "./runtime.js";
