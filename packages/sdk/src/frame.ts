import { type ErrorBody, errorBodyOf, errorFromBody, OutcomeUnknown, Refused } from "./errors.js";
import { type FromFrame, isShellInterface, type PortLike, type ToFrame } from "./frame-protocol.js";
import type { Interface } from "./interface.js";
import {
  type FrameRoot,
  isFrameInterface,
  isModuleDefinition,
  type Log,
  type ModuleDefinition,
} from "./module.js";
import { type Binding, createRuntime, type ModuleRuntime, type MountedView } from "./runtime.js";

export interface FrameOptions {
  /** The port the shell handed this frame. */
  port: PortLike;
  /** The element the view renders into. */
  root: FrameRoot;
  /** Import a view's bundle, as `import(src)` does in a browser. */
  load(src: string): Promise<unknown>;
  /** Set the shell's theme tokens, CSS variables by name, on the frame's document. */
  theme?(tokens: Record<string, string>): void;
}

/** A running frame: report what the view didn't catch, or stop. */
export interface Frame {
  /** An error the view didn't catch, for its Actor's log. */
  failed(error: unknown): void;
  close(): void;
}

/**
 * Run a view module in a frame, on the same runtime as a host module, so a view behaves as it does
 * in tests. Every slot of `ui.shell@1` is served by the shell and always bound; every other slot is
 * served over the port while the shell says it is bound. The shell drives `ui.view@1`: `mount`,
 * `resize` and `unmount` reach the view's handle. Only `ui.view@1` is served among its exports.
 */
export function runFrame(options: FrameOptions): Frame {
  const { port } = options;
  const send = (message: FromFrame) => port.postMessage(message);
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; target: string }
  >();
  /** A request to the shell, a slot call or a ui.shell@1 call, answered by a reply. */
  type Request =
    | { op: "call"; slot: string; method: string; input: unknown }
    | { op: "shell"; method: string; input: unknown };
  const request = (message: Request, target: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, target });
      send({ ...message, id });
    });

  /** The view's runtime, once its start has finished. */
  let runtime: ModuleRuntime<Record<string, Interface>, Record<string, Interface>> | undefined;
  let definition: ModuleDefinition | undefined;
  let loading = false;
  let mounted: MountedView | undefined;
  const bindings = new Map<string, Binding>();
  /**
   * Until the view has started, which slots are bound: from load's snapshot, then from any notice
   * meanwhile, while its bundle imports and while start runs.
   */
  let early: Map<string, boolean> | undefined = new Map();
  /** Slot events the view listens to, each with its live subscription's id, if any. */
  const listened = new Map<string, Map<string, number | undefined>>();
  const subscriptions = new Map<number, { slot: string; event: string }>();

  const log: Log = {
    info: (message, fields) =>
      send({ op: "log", level: "info", message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) =>
      send({ op: "log", level: "warn", message, ...(fields ? { fields } : {}) }),
    error: (message, fields) =>
      send({ op: "log", level: "error", message, ...(fields ? { fields } : {}) }),
  };

  const subscribe = (slot: string, event: string) => {
    const events = listened.get(slot) ?? new Map<string, number | undefined>();
    listened.set(slot, events);
    if (!events.has(event)) events.set(event, undefined);
    if (!bindings.has(slot) || events.get(event) !== undefined) return;
    const sub = ++nextId;
    subscriptions.set(sub, { slot, event });
    events.set(event, sub);
    send({ op: "subscribe", sub, slot, event });
  };
  /** Stop a slot's live subscriptions; the interest stays for when it is usable again. */
  const stopAll = (slot: string, tell: boolean) => {
    const events = listened.get(slot);
    for (const [event, sub] of events ?? []) {
      if (sub === undefined) continue;
      subscriptions.delete(sub);
      events?.set(event, undefined);
      if (tell) send({ op: "unsubscribe", sub });
    }
  };
  const resubscribe = (slot: string) => {
    stopAll(slot, true);
    for (const event of listened.get(slot)?.keys() ?? []) subscribe(slot, event);
  };

  const bind = (slot: string) => {
    if (!runtime) return;
    bindings.set(
      slot,
      runtime.bind(slot, {
        call: (method, input) => request({ op: "call", slot, method, input }, slot),
        open: async () => {
          throw new Refused("unimplemented", `${slot}: a view's stream slots aren't served yet.`);
        },
        fetch: async () => {
          throw new Refused("unimplemented", `${slot}: a view's http slots aren't served yet.`);
        },
      }),
    );
    resubscribe(slot);
  };

  const onSlot = (slot: string, bound: boolean) => {
    if (early) return void early.set(slot, bound);
    const iface =
      definition && Object.hasOwn(definition.slots, slot) ? definition.slots[slot] : undefined;
    // ui.shell@1 is the shell's, always bound; the shell never names it.
    if (!runtime || !iface || isShellInterface(iface)) return;
    if (!bound) {
      bindings.delete(slot);
      stopAll(slot, true);
      return runtime.unbind(slot);
    }
    if (bindings.has(slot)) {
      // Its provider came back: what was missed is read again in onBind, and events resume.
      resubscribe(slot);
      return runtime.usable(slot);
    }
    bind(slot);
  };

  const viewExport = () => {
    for (const [name, iface] of Object.entries(definition?.exports ?? {}))
      if (isFrameInterface(iface)) return name;
    throw new Refused("unimplemented", "This module exports no ui.view@1.");
  };

  const answer = async (id: number, run: () => unknown) => {
    try {
      send({ op: "reply", id, result: (await run()) ?? {} });
    } catch (error) {
      send({ op: "reply", id, error: errorBodyOf(error) });
    }
  };

  const handle = (message: ToFrame) => {
    switch (message.op) {
      case "load":
        return answer(message.id, async () => {
          if (runtime || loading)
            throw new Refused("state", "This frame has loaded a view already.");
          loading = true;
          for (const [slot, isBound] of Object.entries(message.slots)) early?.set(slot, isBound);
          try {
            const loaded = (await options.load(message.src)) as { default?: unknown };
            const found = loaded?.default;
            if (!isModuleDefinition(found) || found.placement !== "view")
              throw new Refused("invalid", `${message.src} isn't a view module.`);
            definition = found;
            const created = createRuntime(found, {
              self: message.self,
              log,
              // A view serves only ui.view@1, which the shell drives directly; nothing reaches its
              // other exports, so their events go nowhere.
              onEmit: () => {},
              onListen: subscribe,
            });
            // As in a host module: start implements and registers handlers, then slots bind, so
            // each bound slot's onBind runs once it is usable.
            await created.start();
            runtime = created;
            for (const [slot, iface] of Object.entries(found.slots))
              if (isShellInterface(iface))
                bindings.set(
                  slot,
                  created.bind(slot, {
                    call: (method, input) => request({ op: "shell", method, input }, slot),
                  }),
                );
            const bound = early;
            early = undefined;
            for (const [slot, isBound] of bound ?? []) if (isBound) onSlot(slot, true);
          } catch (error) {
            // Nothing is half-loaded: the frame can be asked to load again.
            definition = undefined;
            early = new Map();
            throw error;
          } finally {
            loading = false;
          }
        });
      case "slot":
        return onSlot(message.name, message.bound);
      case "mount":
        return answer(message.id, () => {
          if (!runtime) throw new Refused("state", "Nothing is loaded to mount.");
          if (mounted) throw new Refused("state", "The view is mounted already.");
          options.theme?.(message.theme);
          mounted = runtime.mount(viewExport(), options.root, {
            theme: message.theme,
            size: message.size,
          });
        });
      case "resize":
        return answer(message.id, () => {
          if (!mounted) throw new Refused("state", "The view isn't mounted.");
          mounted.resize(message.size);
        });
      case "unmount":
        return answer(message.id, () => {
          const view = mounted;
          mounted = undefined;
          view?.unmount();
        });
      case "event": {
        const subscription = subscriptions.get(message.sub);
        if (!subscription) return;
        try {
          bindings.get(subscription.slot)?.emit(subscription.event, message.payload);
        } catch (error) {
          log.warn("An event didn't fit its schema.", { ...subscription, error: String(error) });
        }
        return;
      }
      case "end": {
        // Ended by an unbind or the provider going: the interest stays for when it is usable again.
        const subscription = subscriptions.get(message.sub);
        if (!subscription) return;
        subscriptions.delete(message.sub);
        const events = listened.get(subscription.slot);
        if (events?.get(subscription.event) === message.sub)
          events.set(subscription.event, undefined);
        return;
      }
      case "reply": {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        if ("error" in message)
          waiting.reject(errorFromBody(message.error as ErrorBody, waiting.target));
        else waiting.resolve(message.result);
        return;
      }
    }
  };

  port.onmessage = (event) => {
    try {
      void handle(event.data as ToFrame);
    } catch (error) {
      log.error("The frame couldn't handle a message from the shell.", { error: String(error) });
    }
  };

  return {
    failed(error) {
      log.error(error instanceof Error ? error.message : String(error), {
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      });
    },
    close() {
      port.onmessage = null;
      for (const [, waiting] of pending) waiting.reject(new OutcomeUnknown("The frame closed."));
      pending.clear();
      port.close();
    },
  };
}
