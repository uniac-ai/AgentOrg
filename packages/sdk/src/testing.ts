import type { z } from "zod";
import { Refused } from "./errors.js";
import type { Interface, RpcInterface, StreamInterface } from "./interface.js";
import type { Duplex, Handlers, InterfaceMap, Log, ModuleDefinition } from "./module.js";
import { type Binding, createRuntime, type ModuleRuntime, type SlotProvider } from "./runtime.js";

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
}
export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

/**
 * A module run without a Hub, for tests: bind fakes to its slots, drive its exports, and read what
 * it emitted and logged. It runs on the same runtime as a real module, so every call is validated
 * as the Hub validates it: bad input is `Refused` with code `invalid`, and an unbound slot or a
 * withdrawn export throws `NotConnected`.
 */
export interface TestContext<S extends InterfaceMap, X extends InterfaceMap>
  extends Omit<ModuleRuntime<S, X>, "bind"> {
  bind<K extends keyof S & string>(slot: K, provider: Provider<S[K]>): Binding;
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
  const runtime = createRuntime(definition, {
    self: { actorId: options.actorId ?? "test-actor", module: options.module ?? "main" },
    log,
    onEmit: (exportName, event, payload) =>
      void emitted.push({ export: exportName, event, payload }),
  });
  return {
    ...runtime,
    bind(slot, fake) {
      const iface = definition.slots[slot] as Interface;
      let provider: SlotProvider;
      if (iface.kind === "rpc") {
        const handlers = fake as Record<string, ((input: unknown) => unknown) | undefined>;
        provider = {
          async call(method, input) {
            const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
            if (!handler) throw new Refused("unimplemented", `${slot}.${method} isn't faked.`);
            return handler(input);
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
    emitted,
    logs,
  };
}

export type { Binding, MountedView } from "./runtime.js";
