import { NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";

/** A view the shell has open: an Actor's `view` module, whose calls run as that Actor. */
export interface View {
  actor: string;
  module: string;
}

/** Where the socket stands: saying hello, open, or with no live session (`agentorg open` again). */
export type Connection = "connecting" | "open" | "signed-out";

/** Where the sign-in page keeps the session, in this origin's own storage. */
const SESSION = "agentorg.session";
/** The gateway's close code for a socket with no live session. */
const SIGN_IN_AGAIN = 4401;
const BACKOFF_MS = [250, 500, 1000, 2000, 5000];

interface ErrorBody {
  name?: string;
  message?: string;
  code?: string;
}
/** A reply's error as the SDK's error, so a view's frame gets the same refusal back. */
function errorOf(body: ErrorBody, target: string): Error {
  if (body.name === "NotConnected") return new NotConnected(target);
  if (body.name === "OutcomeUnknown") return new OutcomeUnknown(body.message);
  return new Refused(body.code ?? "refused", body.message ?? "Refused.");
}

interface Subscription {
  slot: string;
  event: string;
  view?: View;
  send(payload: unknown): void;
  /** For a view's: the gateway ended it, so the frame is told. */
  end?(): void;
  /** Its id on the current socket. */
  sub?: number;
}

/**
 * The tab's one socket to the gateway's `/api`. It says the session first; with none, or closed
 * with 4401, it is signed out. Any other close reconnects with backoff, and every live
 * subscription is made again. Calls made while it isn't open fail at once with `NotConnected`:
 * whoever reads state reads it again on `open`.
 */
export class Api {
  #socket: WebSocket | undefined;
  #connection: Connection = "connecting";
  readonly #watchers = new Set<(connection: Connection) => void>();
  #nextId = 0;
  readonly #pending = new Map<
    number,
    { target: string; resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #subscriptions = new Set<Subscription>();
  readonly #bySub = new Map<number, Subscription>();
  #attempt = 0;

  constructor() {
    this.#connect();
  }

  get connection(): Connection {
    return this.#connection;
  }

  /** Be told each time the connection changes; returns the stop. */
  watch(fn: (connection: Connection) => void): () => void {
    this.#watchers.add(fn);
    return () => void this.#watchers.delete(fn);
  }

  /** A call on one of the person's slots, or with `view`, on that view's. */
  call<T = unknown>(slot: string, method: string, input: unknown = {}, view?: View): Promise<T> {
    const socket = this.#socket;
    if (this.#connection !== "open" || !socket) return Promise.reject(new NotConnected(slot));
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { target: slot, resolve: resolve as (v: unknown) => void, reject });
      socket.send(
        JSON.stringify({ id, op: "call", slot, method, input, ...(view ? { view } : {}) }),
      );
    });
  }

  /** Events of a slot until the returned stop, kept across reconnects; `end` if the gateway ends it. */
  subscribe(
    slot: string,
    event: string,
    send: (payload: unknown) => void,
    options: { view?: View; end?: () => void } = {},
  ): () => void {
    const subscription: Subscription = { slot, event, send, ...options };
    this.#subscriptions.add(subscription);
    if (this.#connection === "open") this.#open(subscription);
    return () => {
      if (!this.#subscriptions.delete(subscription)) return;
      if (subscription.sub === undefined) return;
      this.#bySub.delete(subscription.sub);
      this.#send({ op: "unsubscribe", sub: subscription.sub });
    };
  }

  /** A line for a view's Actor's log; dropped while the socket isn't open. */
  log(view: View, level: "info" | "warn" | "error", message: string, fields?: unknown) {
    if (this.#connection !== "open") return;
    this.#send({ op: "log", view, level, message, ...(fields ? { fields } : {}) });
  }

  #open(subscription: Subscription) {
    const sub = ++this.#nextId;
    subscription.sub = sub;
    this.#bySub.set(sub, subscription);
    const { slot, event, view } = subscription;
    this.#send({ sub, op: "subscribe", slot, event, ...(view ? { view } : {}) });
  }

  #send(message: unknown) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #set(connection: Connection) {
    if (this.#connection === connection) return;
    this.#connection = connection;
    for (const fn of [...this.#watchers]) fn(connection);
  }

  #connect() {
    const session = localStorage.getItem(SESSION);
    if (!session) return this.#set("signed-out");
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api`);
    this.#socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ op: "hello", session }));
    socket.onmessage = (event) => this.#receive(String(event.data));
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      for (const waiting of this.#pending.values())
        waiting.reject(new OutcomeUnknown("The connection to AgentOrg dropped."));
      this.#pending.clear();
      this.#bySub.clear();
      for (const subscription of this.#subscriptions) subscription.sub = undefined;
      if (event.code === SIGN_IN_AGAIN) {
        localStorage.removeItem(SESSION);
        return this.#set("signed-out");
      }
      this.#set("connecting");
      const wait = BACKOFF_MS[Math.min(this.#attempt++, BACKOFF_MS.length - 1)];
      setTimeout(() => this.#connect(), wait);
    };
  }

  #receive(text: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.op === "hello") {
      this.#attempt = 0;
      for (const subscription of this.#subscriptions) this.#open(subscription);
      return this.#set("open");
    }
    if (typeof message.id === "number") {
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(errorOf(message.error as ErrorBody, waiting.target));
      else waiting.resolve(message.result);
      return;
    }
    if (typeof message.sub === "number") {
      const subscription = this.#bySub.get(message.sub);
      if (!subscription) return;
      if (message.end) {
        this.#bySub.delete(message.sub);
        this.#subscriptions.delete(subscription);
        subscription.end?.();
      } else subscription.send(message.payload);
    }
  }
}
