import type { Channel, ChannelExposure, Serve, ServeHandlers } from "./client.js";
import { NotConnected, OutcomeUnknown, Refused } from "./errors.js";
import { describeInterface, type Interface } from "./interface.js";
import type { InterfaceMap, Log } from "./module.js";
import type { Binding, ModuleRuntime, RuntimeOptions } from "./runtime.js";

/** One subscription the Hub holds to an export: who is calling, and how to send them an event. */
interface Sender {
  caller: string;
  send(payload: unknown): void;
}

/**
 * One module's runtime, joined to a channel. Its slots and exports are named on the wire with a
 * prefix: none for a program that connects itself, `<module>.` for a module in a package Actor's
 * process, where several share one channel. It binds slots as the Hub's notices say, subscribes
 * `on` handlers while a slot is usable, serves the Hub's streams to its exports, and offers and
 * withdraws run-time exports.
 */
export class ModuleHost {
  readonly #prefix: string;
  readonly #slots: InterfaceMap;
  readonly #log: Log;
  #runtime?: ModuleRuntime<InterfaceMap, InterfaceMap>;
  #channel?: Channel;
  /** The Hub's subscriptions to this module's exports, by export and event, each with its caller. */
  readonly #senders = new Map<string, Set<Sender>>();
  /** The same subscriptions by export, each ended when its export is withdrawn. */
  readonly #subscribers = new Map<string, Set<() => void>>();
  /** Slot events the module listens to, each with its live subscription, if any. */
  readonly #listened = new Map<string, Map<string, (() => void) | undefined>>();
  readonly #bindings = new Map<string, Binding>();
  /** Run-time exports by name, so a refused offer withdraws the right handle. */
  readonly #added = new Map<string, { handle: { withdraw(): void }; iface: Interface }>();

  constructor(prefix: string, slots: InterfaceMap, log: Log) {
    this.#prefix = prefix;
    this.#slots = slots;
    this.#log = log;
  }

  /** A local name as the Hub knows it. */
  #wire(name: string): string {
    return `${this.#prefix}${name}`;
  }

  get runtime(): ModuleRuntime<InterfaceMap, InterfaceMap> {
    if (!this.#runtime) throw new Error("The module host has no runtime yet.");
    return this.#runtime;
  }

  set runtime(runtime: ModuleRuntime<InterfaceMap, InterfaceMap>) {
    this.#runtime = runtime;
  }

  /** The runtime's hooks for this host: pass them to `createRuntime`. */
  hooks(): Pick<RuntimeOptions, "onEmit" | "onListen" | "onAdd" | "onWithdraw"> {
    return {
      onEmit: (exportName, event, payload, to?: string) => {
        // An event addressed to one caller goes only to that caller's subscriptions; one
        // subscriber's trouble never reaches the emitter or the others.
        for (const sender of [...(this.#senders.get(`${exportName}\0${event}`) ?? [])]) {
          if (to !== undefined && sender.caller !== to) continue;
          try {
            sender.send(payload);
          } catch (error) {
            this.#log.error("Sending an event failed.", {
              export: exportName,
              error: String(error),
            });
          }
        }
      },
      onListen: (slot, event) => this.#subscribeSlot(slot, event),
      onAdd: (name, iface, handle) => {
        this.#added.set(name, { handle, iface });
        // Added during start, before the channel opens: offered once it does.
        if (this.#channel) this.#offer(this.#channel, name, iface, handle);
      },
      onWithdraw: (name) => {
        for (const end of [...(this.#subscribers.get(name) ?? [])]) end();
        // Only exports offered at run time can be withdrawn at the Hub; static ones just stop here.
        if (!this.#added.has(name)) return;
        this.#added.delete(name);
        void this.#channel?.withdraw(this.#wire(name)).catch(() => {});
      },
    };
  }

  /** Offer a run-time export; one the Hub refuses is withdrawn here too. */
  #offer(channel: Channel, name: string, iface: Interface, handle: { withdraw(): void }) {
    void channel.offer(this.#wire(name), describeInterface(iface)).catch((error) => {
      this.#log.error("The Hub refused an export.", { export: name, error: String(error) });
      if (this.#added.get(name)?.handle === handle) handle.withdraw();
    });
  }

  #subscribeSlot(slot: string, event: string) {
    const events = this.#listened.get(slot) ?? new Map<string, (() => void) | undefined>();
    this.#listened.set(slot, events);
    if (!events.has(event)) events.set(event, undefined);
    const binding = this.#bindings.get(slot);
    if (!this.#channel || !binding || events.get(event)) return;
    const stop = this.#channel.subscribe(
      this.#wire(slot),
      event,
      (payload) => {
        try {
          binding.emit(event, payload);
        } catch (error) {
          this.#log.warn("An event didn't fit its schema.", { slot, event, error: String(error) });
        }
      },
      // Ended by an unbind or the provider going: the interest stays for when it is usable again.
      () => {
        if (events.get(event) === stop) events.set(event, undefined);
      },
    );
    events.set(event, stop);
  }

  #resubscribe(slot: string) {
    const events = this.#listened.get(slot);
    for (const [event, stop] of events ?? []) {
      stop?.();
      events?.set(event, undefined);
    }
    for (const event of events?.keys() ?? []) this.#subscribeSlot(slot, event);
  }

  /**
   * A slot notice for one of this module's slots, by its local name: unbound, bound, or (for a
   * slot already bound) usable again because its provider came back.
   */
  onSlot(slot: string, isBound: boolean): void {
    if (!Object.hasOwn(this.#slots, slot) || !this.#channel) return;
    const runtime = this.runtime;
    if (!isBound) {
      this.#bindings.delete(slot);
      const events = this.#listened.get(slot);
      for (const [event, stop] of events ?? []) {
        stop?.();
        events?.set(event, undefined);
      }
      runtime.unbind(slot);
      return;
    }
    if (this.#bindings.has(slot)) {
      // Its provider came back: what was missed is read again in onBind, and events resume.
      this.#resubscribe(slot);
      runtime.usable(slot);
      return;
    }
    const open = this.#channel;
    const name = this.#wire(slot);
    this.#bindings.set(
      slot,
      runtime.bind(slot, {
        call: (method, value) => open.call(name, method, value),
        open: (params) => open.open(name, params),
        fetch: async (request) => {
          // HTTP/1.1 is spoken with node:http, loaded when an http slot is first used (a bundle
          // such as the runner has it inlined).
          const { fetchOver } = await import("./client-http.js");
          const stream = await open.http(name);
          try {
            return await fetchOver(stream, request, name);
          } catch (error) {
            // An abort keeps its own reason, and the provider's own SDK error is that error; a
            // stream lost mid-request may have reached the provider.
            if (
              request.signal.aborted ||
              error instanceof Refused ||
              error instanceof NotConnected ||
              error instanceof OutcomeUnknown
            )
              throw error;
            throw new OutcomeUnknown(
              `The http request on ${name} ended before its response: ${String(error)}`,
            );
          }
        },
      }),
    );
    this.#resubscribe(slot);
  }

  /**
   * A notice for a slot made at run time: bound (or usable again) with its exposure, or gone. Its
   * name is the Actor's, with no module prefix: every module of the Actor has it.
   */
  onExposed(slot: string, exposure: ChannelExposure | undefined): void {
    if (!this.#channel) return;
    if (!exposure) {
      this.runtime.unexpose(slot);
      return;
    }
    const open = this.#channel;
    this.runtime.expose(slot, {
      described: exposure.interface,
      provider: exposure.provider,
      call: (method, value) => open.call(slot, method, value),
      subscribe: (event, onEvent, onEnd) => open.subscribe(slot, event, onEvent, () => onEnd()),
    });
  }

  /** How this module serves the Hub's streams, by its local export names. */
  readonly serve: ServeHandlers = {
    call: (serve, value) =>
      this.runtime.call(serve.export, serve.method ?? "", value, serve.caller),
    subscribe: (serve, sendTo, end) => {
      if (this.runtime.withdrawn(serve.export)) throw new NotConnected(serve.export);
      const key = `${serve.export}\0${serve.event ?? ""}`;
      const set = this.#senders.get(key) ?? new Set();
      this.#senders.set(key, set);
      const sender = { caller: serve.caller, send: sendTo };
      set.add(sender);
      const ends = this.#subscribers.get(serve.export) ?? new Set();
      this.#subscribers.set(serve.export, ends);
      const stop = () => {
        set.delete(sender);
        ends.delete(withdrawn);
      };
      const withdrawn = () => {
        stop();
        end(new NotConnected(serve.export));
      };
      ends.add(withdrawn);
      return stop;
    },
    accept: (serve) => this.runtime.accepting(serve.export, serve.params),
    serveHttp: (serve) => {
      const handle = this.runtime.serving(serve.export);
      return async (stream) => {
        const { serveOver } = await import("./client-http.js");
        await serveOver(stream, handle, this.#log);
      };
    },
  };

  /**
   * Join the opened channel: offer what was added during start, bind the slots the Hub's hello
   * said are bound, and leave nothing usable once the channel goes.
   */
  attach(channel: Channel): void {
    this.#channel = channel;
    for (const [name, { handle, iface }] of this.#added) this.#offer(channel, name, iface, handle);
    for (const name of channel.bound)
      if (name.startsWith(this.#prefix) && !channel.exposed.has(name))
        this.onSlot(name.slice(this.#prefix.length), true);
    for (const [name, exposure] of channel.exposed) this.onExposed(name, exposure);
    void channel.closed.then(() => {
      for (const slot of [...this.#bindings.keys()]) this.onSlot(slot, false);
      for (const { slot } of this.runtime.ctx.exposed()) this.runtime.unexpose(slot);
      for (const ends of this.#subscribers.values()) for (const end of [...ends]) end();
    });
  }
}

/** A `serve` stream renamed to a module's local export name. */
export const localServe = (serve: Serve, local: string): Serve => ({ ...serve, export: local });

/** A refusal for a name that names no module here. */
export const noModule = (name: string) =>
  new Refused("unknown", `${name} names no host module of this Actor.`);
