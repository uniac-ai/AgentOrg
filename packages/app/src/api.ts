import { NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";

/** The person's own side: the slots the gateway serves `/api` from. */
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

/** The socket a tab or the CLI holds: text messages in, text messages out. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** The most one message carries, as the frontend contract says. */
export const MAX_MESSAGE = 1024 * 1024;
/** What a call in a message over it is answered: nothing of it is done. */
const TOO_LARGE = "That's too large to send: one message to AgentOrg can be at most 1 MB.";

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
 * - `{id, op: "call", slot, method, input}`: answered `{id, result}` or `{id, error}`.
 * - `{sub, op: "subscribe", slot, event}`: then `{sub, payload}` per event, and `{sub, end: true}`
 *   once it can't go on. `{sub, op: "unsubscribe"}` stops it.
 *
 * Everything runs as the person, through their slots.
 */
export function serveSocket(
  socket: Socket,
  deps: { person: PersonSide },
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
  const receive = (text: string) => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    // Over the most a message carries: a call is told so in words, and nothing of it is done.
    if (Buffer.byteLength(text) > MAX_MESSAGE) {
      if (message.op === "call" && isId(message.id))
        send({ id: message.id, error: errorBody(new Refused("invalid", TOO_LARGE)) });
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
          // A live ticket is for the gateway's own pipe at `/live`, never for a page to hold, under
          // whatever slot a page might expose it at.
          if (method === "live") throw new Refused("forbidden", "Open a live surface at /live.");
          return deps.person.call(slot, method, input);
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
          const forward = (payload: unknown) => {
            if (!ended) send({ sub, payload });
          };
          const stop = deps.person.subscribe(slot, event, forward, end);
          if (ended) stop();
          else subscriptions.set(sub, stop);
        } catch (error) {
          ended = true;
          send({ sub, end: true, error: errorBody(error) });
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
