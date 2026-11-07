import { NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";

/** A view the person has open: an Actor's `view` module. */
export interface View {
  actor: string;
  module: string;
}

/** The person's own side: its slots, and `layout`, its own export, which the gateway serves. */
export interface PersonSide {
  call(slot: string, method: string, input: unknown): Promise<unknown>;
  /** Events until the returned stop; `end` when the subscription can't go on. */
  subscribe(
    slot: string,
    event: string,
    send: (payload: unknown) => void,
    end: () => void,
  ): () => void;
}

/**
 * Calls run as a view's Actor through its `module.slot` bindings: the Hub's in-process view path
 * (`hub.viewCall` and `hub.viewSubscribe`), validated and audited like any call. The Hub refuses a
 * module that isn't one of the Actor's views, so any view of the Actor's package is open to the
 * person, and nothing else is.
 */
export interface ViewCalls {
  call(view: View, slot: string, method: string, input: unknown): Promise<unknown>;
  subscribe(
    view: View,
    slot: string,
    event: string,
    send: (payload: unknown) => void,
    end: () => void,
  ): () => void;
  /**
   * The view's slots: `onSlot` hears each bound one at once, then every change (bound again when
   * it's usable again). Returns how to stop. Refused for a module that isn't a view.
   */
  slots(view: View, onSlot: (slot: string, bound: boolean) => void): () => void;
  /** A line for the view's Actor's log, which the Hub bounds as it does a frame's. */
  log(
    view: View,
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void;
}

/** The socket a tab or the CLI holds: text messages in, text messages out. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Subscriptions one socket may hold. */
const MAX_SUBSCRIPTIONS = 256;
/** Calls one socket may have in flight; past it, `busy`. */
const MAX_CALLS = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

function errorBody(error: unknown) {
  if (error instanceof Refused)
    return { name: "Refused", message: error.message, code: error.code };
  if (error instanceof NotConnected) return { name: "NotConnected", message: error.message };
  if (error instanceof OutcomeUnknown) return { name: "OutcomeUnknown", message: error.message };
  return { name: "Refused", message: "The gateway couldn't handle this.", code: "internal" };
}

/**
 * One `/api` socket: the same calls a channel carries, as JSON.
 *
 * - `{id, op: "call", slot, method, input}`, or with `view: {actor, module}` for a view's slot;
 *   answered `{id, result}` or `{id, error}`.
 * - `{sub, op: "subscribe", slot, event}` (or with `view`): then `{sub, payload}` per event, and
 *   `{sub, end: true}` once it can't go on. `{sub, op: "unsubscribe"}` stops it.
 * - `{sub, op: "slots", view}`: the view's slots. First `{sub, payload: {bound: [slot]}}`, every
 *   one bound now, then `{sub, payload: {slot, bound}}` per change, `bound` again for a slot that's
 *   usable again. `{sub, op: "unsubscribe"}` stops it, as a subscription.
 * - `{op: "log", view, level, message, fields?}`: a line for the view's Actor's log, unanswered.
 *
 * A view's calls run as its Actor, for one of its views only, which the Hub checks. Everything else
 * runs as the person: through its own slots, and `layout`, its own export.
 */
export function serveSocket(
  socket: Socket,
  deps: { person: PersonSide; views: ViewCalls },
): { receive(text: string): void; closed(): void } {
  const subscriptions = new Map<number, () => void>();
  let calls = 0;
  const send = (message: unknown) => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket is gone; its close stops the rest.
    }
  };
  const viewOf = (value: unknown): View | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !isName(value.actor) || !isName(value.module))
      throw new Refused("invalid", "A view is {actor, module}.");
    return { actor: value.actor, module: value.module };
  };

  const receive = (text: string) => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    switch (message.op) {
      case "call": {
        const { id, slot, method, input } = message;
        if (!isId(id)) return;
        if (calls >= MAX_CALLS) {
          const busy = new Refused("busy", `A socket has ${MAX_CALLS} calls in flight at most.`);
          return send({ id, error: errorBody(busy) });
        }
        calls++;
        void (async () => {
          if (!isName(slot) || !isName(method))
            throw new Refused("invalid", "A call names its slot and method.");
          const view = viewOf(message.view);
          return view
            ? deps.views.call(view, slot, method, input)
            : deps.person.call(slot, method, input);
        })()
          .then(
            (result) => send({ id, result }),
            (error) => send({ id, error: errorBody(error) }),
          )
          .finally(() => calls--);
        return;
      }
      case "subscribe": {
        const { sub, slot, event } = message;
        if (!isId(sub) || subscriptions.has(sub)) return;
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          subscriptions.get(sub)?.();
          subscriptions.delete(sub);
          send({ sub, end: true });
        };
        try {
          if (!isName(slot) || !isName(event))
            throw new Refused("invalid", "A subscription names its slot and event.");
          if (subscriptions.size >= MAX_SUBSCRIPTIONS)
            throw new Refused(
              "quota",
              `A socket holds ${MAX_SUBSCRIPTIONS} subscriptions at most.`,
            );
          const view = viewOf(message.view);
          const forward = (payload: unknown) => {
            if (!ended) send({ sub, payload });
          };
          const stop = view
            ? deps.views.subscribe(view, slot, event, forward, end)
            : deps.person.subscribe(slot, event, forward, end);
          if (ended) stop();
          else subscriptions.set(sub, stop);
        } catch (error) {
          ended = true;
          send({ sub, end: true, error: errorBody(error) });
        }
        return;
      }
      case "slots": {
        const { sub } = message;
        if (!isId(sub) || subscriptions.has(sub)) return;
        try {
          if (subscriptions.size >= MAX_SUBSCRIPTIONS)
            throw new Refused(
              "quota",
              `A socket holds ${MAX_SUBSCRIPTIONS} subscriptions at most.`,
            );
          const view = viewOf(message.view);
          if (!view) throw new Refused("invalid", "A slots watch names its view.");
          // The Hub tells the bound slots at once, within the call: gathered, they're one snapshot.
          let snapshot: string[] | undefined = [];
          const stop = deps.views.slots(view, (slot, bound) => {
            if (snapshot && bound) snapshot.push(slot);
            else if (!snapshot) send({ sub, payload: { slot, bound } });
          });
          send({ sub, payload: { bound: snapshot } });
          snapshot = undefined;
          subscriptions.set(sub, stop);
        } catch (error) {
          send({ sub, end: true, error: errorBody(error) });
        }
        return;
      }
      case "log": {
        const { level, message: text, fields } = message;
        if (level !== "info" && level !== "warn" && level !== "error") return;
        if (typeof text !== "string") return;
        try {
          const view = viewOf(message.view);
          if (view) deps.views.log(view, level, text, isRecord(fields) ? fields : undefined);
        } catch {
          // Not one of an Actor's views: nothing is logged, and nothing answers.
        }
        return;
      }
      case "unsubscribe": {
        const stop = isId(message.sub) ? subscriptions.get(message.sub) : undefined;
        if (!stop) return;
        subscriptions.delete(message.sub as number);
        stop();
        return;
      }
    }
  };

  return {
    receive,
    closed() {
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
    },
  };
}
