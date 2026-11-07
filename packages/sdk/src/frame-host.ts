import { type ErrorBody, errorBodyOf, errorFromBody, OutcomeUnknown, Refused } from "./errors.js";
import { FRAME_HELLO, type FromFrame, type PortLike, type ToFrame } from "./frame-protocol.js";

/** Where a frame's requests go: its slots, run as the view's Actor, and the shell itself. */
export interface FrameHandlers {
  /** A call on one of the view's slots. */
  call(slot: string, method: string, input: unknown): Promise<unknown>;
  /**
   * Events of one of the view's slots until `end` or the returned stop; `end` is for the shell's
   * side ending it (an unbind, or the provider gone).
   */
  subscribe(
    slot: string,
    event: string,
    send: (payload: unknown) => void,
    end: () => void,
  ): () => void;
  /** `ui.shell@1`, which the shell serves to every view with no binding. */
  shell: {
    /** Open the URL, which the host has checked is https, in a new tab with no opener (`noopener`). */
    openExternal(url: string): void | Promise<void>;
    /** Start the shell's own sign-in, as its first run does. */
    signIn(): void | Promise<void>;
  };
  /** A line for the view's Actor's log. */
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
  /**
   * The view's content height, within 120–2,000 px and at most once per 100 ms (the latest one
   * wins), for a shell that sizes the frame to its content. Without it, sizes are dropped.
   */
  size?(height: number): void;
}

type Size = { width: number; height: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 256;
const LEVELS = new Set(["info", "warn", "error"]);
/** A log line's text from a frame is cut to this. */
const MAX_LOG = 4096;
/** A log line's fields from a frame: this many keys at most, each value cut to this length. */
const MAX_FIELDS = 16;
const MAX_FIELD = 1024;
/** Log lines a frame may send per window; the rest of the window is dropped, and that's said once. */
const LOG_LINES = 50;
const LOG_WINDOW_MS = 10_000;
/** Live subscriptions one frame may hold. */
const MAX_SUBSCRIPTIONS = 64;
/** Calls on its slots one frame may have in flight; past it, `busy`. */
const MAX_CALLS = 64;
/** The heights a view's frame may take from its content, and how often it may change. */
export const FRAME_HEIGHT = { min: 120, max: 2000 };
const SIZE_MS = 100;

/**
 * A frame's log fields, rebuilt: a fresh object of at most `MAX_FIELDS` plain keys (no prototype
 * keys), each value a primitive or JSON text, cut to `MAX_FIELD`.
 */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const fields: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(value)) {
    if (kept >= MAX_FIELDS) break;
    if (key === "__proto__" || key === "constructor" || key === "prototype" || key.length > 64)
      continue;
    const field = value[key];
    let text: unknown;
    if (field === null || typeof field === "number" || typeof field === "boolean") text = field;
    else if (typeof field === "string") text = field.slice(0, MAX_FIELD);
    else
      try {
        text = String(JSON.stringify(field)).slice(0, MAX_FIELD);
      } catch {
        text = "[unreadable]";
      }
    Object.defineProperty(fields, key, {
      value: text,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    kept++;
  }
  return fields;
}

/** A frame's error body, read as no more than it claims: one of the three names, as text. */
function portErrorOf(error: Record<string, unknown>): ErrorBody {
  const name =
    error.name === "NotConnected" || error.name === "OutcomeUnknown" ? error.name : "Refused";
  return {
    name,
    message: String(error.message ?? "").slice(0, MAX_LOG),
    ...(typeof error.code === "string" ? { code: error.code.slice(0, 64) } : {}),
  };
}

/** `ui.shell@1.openExternal`'s URL, if it is one the shell opens: https only. */
function externalUrl(input: unknown): string {
  const url = isRecord(input) ? input.url : undefined;
  if (typeof url !== "string" || url.length > 8192)
    throw new Refused("invalid", "openExternal takes {url}.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refused("invalid", "openExternal: the URL doesn't parse.");
  }
  if (parsed.protocol !== "https:")
    throw new Refused("invalid", "openExternal opens https URLs only.");
  return parsed.href;
}

/**
 * Hand a frame its port: post the hello with the other end to the frame's window, which has an
 * opaque origin, so the target origin is `*`; the frame accepts it only from its parent.
 */
export function openFrame(frameWindow: {
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
}): PortLike {
  const channel = new MessageChannel();
  frameWindow.postMessage(FRAME_HELLO, "*", [channel.port2]);
  return channel.port1 as unknown as PortLike;
}

/**
 * The shell's end of a view's frame. It drives `ui.view@1` (load, mount, resize, unmount), tells
 * the frame which slots are bound, and serves what the frame asks: calls and subscriptions on the
 * view's slots through `handlers`, and `ui.shell@1` itself. The frame isn't trusted: every message
 * is checked, and one that doesn't fit is dropped or refused.
 */
export class FrameHost {
  readonly #port: PortLike;
  readonly #handlers: FrameHandlers;
  #nextId = 0;
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  /** Live subscriptions by id, and the id of each slot and event's one subscription. */
  readonly #subscriptions = new Map<number, { key: string; stop: () => void }>();
  readonly #byEvent = new Map<string, number>();
  /** ui.shell@1 methods with a call in flight: one at a time each. */
  readonly #shellBusy = new Set<string>();
  #logWindow = { start: 0, lines: 0 };
  #calls = 0;
  #closed = false;
  /** The latest height not yet passed on, and the wait before the next may be. */
  #sizing: { height?: number; timer?: ReturnType<typeof setTimeout> } = {};

  constructor(port: PortLike, handlers: FrameHandlers) {
    this.#port = port;
    this.#handlers = handlers;
    port.onmessage = (event) => this.#receive(event.data);
  }

  /** Import the view's bundle in the frame and run its `start`; `slots` says which are bound. */
  load(options: { src: string; actorId: string; module: string; slots: Record<string, boolean> }) {
    return this.#request((id) => ({
      op: "load",
      id,
      src: options.src,
      self: { actorId: options.actorId, module: options.module },
      slots: options.slots,
    }));
  }
  /** A slot became bound or unbound; `bound` again for a bound slot means its provider came back. */
  slot(name: string, bound: boolean) {
    this.#post({ op: "slot", name, bound });
  }
  mount(theme: Record<string, string>, size: Size) {
    return this.#request((id) => ({ op: "mount", id, theme, size }));
  }
  resize(size: Size) {
    return this.#request((id) => ({ op: "resize", id, size }));
  }
  unmount() {
    return this.#request((id) => ({ op: "unmount", id }));
  }
  /** Stop: every subscription ends, and what waits on the frame fails. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#sizing.timer);
    this.#port.onmessage = null;
    for (const { stop } of this.#subscriptions.values()) stop();
    this.#subscriptions.clear();
    this.#byEvent.clear();
    for (const waiting of this.#pending.values())
      waiting.reject(new OutcomeUnknown("The frame closed."));
    this.#pending.clear();
    this.#port.close();
  }

  #flushSize() {
    const { height } = this.#sizing;
    this.#sizing = {};
    if (height === undefined || this.#closed) return;
    this.#handlers.size?.(height);
    this.#sizing.timer = setTimeout(() => this.#flushSize(), SIZE_MS);
  }

  #post(message: ToFrame) {
    if (!this.#closed) this.#port.postMessage(message);
  }
  #request(make: (id: number) => ToFrame): Promise<void> {
    if (this.#closed) return Promise.reject(new OutcomeUnknown("The frame closed."));
    const id = ++this.#nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#post(make(id));
    }).then(() => undefined);
  }
  async #answer(id: number, run: () => unknown) {
    try {
      this.#post({ op: "reply", id, result: (await run()) ?? {} });
    } catch (error) {
      this.#post({ op: "reply", id, error: errorBodyOf(error) });
    }
  }

  #receive(data: unknown) {
    if (!isRecord(data)) return;
    const message = data as FromFrame & Record<string, unknown>;
    switch (message.op) {
      case "call":
        if (!isId(message.id)) return;
        if (!isName(message.slot) || !isName(message.method))
          return void this.#answer(message.id, () => {
            throw new Refused("invalid", "A call names its slot and method.");
          });
        return void this.#answer(message.id, async () => {
          // One view can't flood the gateway and the Hub: past the cap, it waits its turn.
          if (this.#calls >= MAX_CALLS)
            throw new Refused("busy", `A view has ${MAX_CALLS} calls in flight at most.`);
          this.#calls++;
          try {
            return await this.#handlers.call(message.slot, message.method, message.input);
          } finally {
            this.#calls--;
          }
        });
      case "shell": {
        if (!isId(message.id)) return;
        const { method, input } = message;
        return void this.#answer(message.id, async () => {
          if (method !== "openExternal" && method !== "signIn")
            throw new Refused("invalid", "ui.shell@1 has openExternal and signIn.");
          const url = method === "openExternal" ? externalUrl(input) : undefined;
          if (this.#shellBusy.has(method))
            throw new Refused("busy", `ui.shell@1.${method} is already running.`);
          this.#shellBusy.add(method);
          try {
            if (url !== undefined) await this.#handlers.shell.openExternal(url);
            else await this.#handlers.shell.signIn();
          } finally {
            this.#shellBusy.delete(method);
          }
          return {};
        });
      }
      case "subscribe": {
        const { sub, slot, event } = message;
        if (!isId(sub) || !isName(slot) || !isName(event) || this.#subscriptions.has(sub)) return;
        const key = `${slot}\0${event}`;
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          if (this.#subscriptions.get(sub)?.key === key) {
            this.#subscriptions.delete(sub);
            this.#byEvent.delete(key);
          }
          this.#post({ op: "end", sub });
        };
        // One subscription per slot and event, as the frame keeps; past the cap, none.
        if (this.#byEvent.has(key) || this.#subscriptions.size >= MAX_SUBSCRIPTIONS) return end();
        try {
          const stop = this.#handlers.subscribe(
            slot,
            event,
            (payload) => {
              if (!ended) this.#post({ op: "event", sub, payload });
            },
            end,
          );
          if (ended) stop();
          else {
            this.#subscriptions.set(sub, { key, stop });
            this.#byEvent.set(key, sub);
          }
        } catch {
          end();
        }
        return;
      }
      case "size": {
        const { height } = message;
        if (typeof height !== "number" || !Number.isFinite(height) || !this.#handlers.size) return;
        this.#sizing.height = Math.round(
          Math.min(FRAME_HEIGHT.max, Math.max(FRAME_HEIGHT.min, height)),
        );
        // The first at once, then at most one per window: the latest at its end.
        if (!this.#sizing.timer) this.#flushSize();
        return;
      }
      case "unsubscribe": {
        const live = isId(message.sub) ? this.#subscriptions.get(message.sub) : undefined;
        if (!live) return;
        this.#subscriptions.delete(message.sub as number);
        this.#byEvent.delete(live.key);
        live.stop();
        return;
      }
      case "log": {
        if (!LEVELS.has(message.level as string) || typeof message.message !== "string") return;
        const now = Date.now();
        if (now - this.#logWindow.start > LOG_WINDOW_MS) this.#logWindow = { start: now, lines: 0 };
        const lines = ++this.#logWindow.lines;
        if (lines > LOG_LINES + 1) return;
        if (lines === LOG_LINES + 1)
          return this.#handlers.log(
            "warn",
            "The view logged too much; its lines are dropped for a while.",
          );
        this.#handlers.log(
          message.level,
          message.message.slice(0, MAX_LOG),
          fieldsOf(message.fields),
        );
        return;
      }
      case "reply": {
        const waiting = isId(message.id) ? this.#pending.get(message.id) : undefined;
        if (!waiting) return;
        this.#pending.delete(message.id);
        if (isRecord(message.error))
          waiting.reject(errorFromBody(portErrorOf(message.error), "view"));
        else waiting.resolve(message.result);
        return;
      }
    }
  }
}
