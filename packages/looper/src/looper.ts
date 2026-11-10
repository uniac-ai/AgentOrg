/**
 * The looper: the loops of whoever hosts it, one for each thread a message comes in on. A thread is
 * a name its host gives; its record is kept under `thread/<name>/` in the store, and its loop and
 * record are made when the thread is first used and then stay in memory.
 *
 * Turns run side by side, each in a place. There are `PLACES` of them, and one more that only a
 * thread already begun (its record holds something) may take, so new threads never keep a message
 * from one that is under way. A turn that finds no place waits for one, in the order it came. While
 * begun threads keep five turns running, a new thread goes on waiting. `WAITING` turns may wait;
 * past that a message is refused `busy`, and nothing of it is kept.
 */
import { createLoop, type Place } from "./loop.js";
import { createRecord } from "./record.js";
import {
  type Log,
  type Model,
  Refusal,
  type Shown,
  type Status,
  type Store,
  type Tool,
} from "./types.js";

/** The turns that run at once, not counting the one more for a thread already begun. */
export const PLACES = 4;
/** The turns that may wait for a place at once. */
export const WAITING = 16;

/** Where a thread's record is kept in the looper's store. */
const recordOf = (thread: string) => `thread/${encodeURIComponent(thread)}/`;

/** The store's keys under `prefix`, as a store of its own. */
function under(store: Store, prefix: string): Store {
  return {
    get: ({ key }) => store.get({ key: prefix + key }),
    set: ({ key, value }) => store.set({ key: prefix + key, value }),
    delete: ({ key }) => store.delete({ key: prefix + key }),
    async list({ prefix: inner = "", after, limit }) {
      const page = await store.list({
        prefix: prefix + inner,
        ...(after === undefined ? {} : { after: prefix + after }),
        ...(limit === undefined ? {} : { limit }),
      });
      return {
        keys: page.keys.map((key) => key.slice(prefix.length)),
        next: page.next === null ? null : page.next.slice(prefix.length),
      };
    },
  };
}

/** Where a looper's loops say what they do, each with the thread it is said in. */
export interface LooperOut {
  message(thread: string, message: Shown): void;
  /** Text of the reply `id` as the model writes it. */
  delta(thread: string, id: string, text: string): void;
  status(thread: string, status: Status): void;
}

/**
 * Make a looper. Nothing is read or run until a thread is named: a message sent in it, or its
 * messages asked for.
 */
export function createLooper(options: {
  store: Store;
  model: Model;
  /**
   * Read for each model request, since any of it may change between two: what the model is told,
   * what it can call, and which model to ask, none meaning the model's own default.
   */
  request(): Promise<{ instructions: string; tools: Tool[]; model?: string | undefined }>;
  out: LooperOut;
  /** Whether it starts stopped: no turn starts until `start`. */
  stopped?: boolean;
  log: Log;
}) {
  const { store, out, log } = options;
  const threads = new Map<string, ReturnType<typeof open>>();
  /** Set while it is stopped: no turn starts until it is started. */
  let stopped = options.stopped ?? false;
  /** Set when it closes: no turn starts after. */
  let closed = false;
  /** Refuse a turn that can't start now, whatever thread it is for. */
  const mayStart = () => {
    if (closed) throw new Refusal("unavailable", "This agent is closing.");
    if (stopped) throw new Refusal("busy", "It is stopped. Start it to go on.");
  };

  /** Messages being recorded now, each about to start a turn: stopping waits for them. */
  const starting = new Set<Promise<void>>();
  const started = <T>(call: Promise<T>) => {
    const done: Promise<void> = call.then(
      () => void starting.delete(done),
      () => void starting.delete(done),
    );
    starting.add(done);
    return call;
  };

  /** The turns that have a place, and those waiting for one, first come first. */
  const placed = new Set<Place>();
  const waiting: { place: Place; begun: boolean; take(): void }[] = [];
  const fits = (begun: boolean) => placed.size < PLACES + (begun ? 1 : 0);
  const enter = (begun: boolean): Place => {
    let take: () => void = () => {};
    const place: Place = {
      entered: new Promise<void>((resolve) => {
        take = resolve;
      }),
      leave() {
        take();
        const queued = waiting.findIndex((one) => one.place === place);
        if (queued !== -1) waiting.splice(queued, 1);
        if (!placed.delete(place)) return;
        // Its place goes to whoever has waited longest for one they may take.
        const next = waiting.find((one) => fits(one.begun));
        if (!next) return;
        waiting.splice(waiting.indexOf(next), 1);
        placed.add(next.place);
        next.take();
      },
    };
    if (fits(begun)) {
      placed.add(place);
      take();
    } else if (waiting.length < WAITING) waiting.push({ place, begun, take });
    else
      throw new Refusal(
        "busy",
        "Too many turns are waiting. Wait for one to start, or cancel one.",
      );
    return place;
  };

  const open = (thread: string) => {
    const record = createRecord(under(store, recordOf(thread)), log);
    const loop = createLoop({
      request: options.request,
      model: options.model,
      enter,
      record,
      out: {
        message: (message) => out.message(thread, message),
        delta: (id, text) => out.delta(thread, id, text),
        status: (status) => out.status(thread, status),
      },
      log,
    });
    return { record, loop };
  };
  const of = (thread: string) => {
    const found = threads.get(thread) ?? open(thread);
    threads.set(thread, found);
    return found;
  };

  return {
    /**
     * Start a turn in a thread with a message. The message is recorded and said at once; the turn
     * waits for a place if none is free. Refused `busy` while the thread is in a turn or waiting
     * for a place, while `WAITING` turns already wait, or while the looper is stopped; and
     * `unavailable` once it has closed.
     */
    async send(thread: string, text: string) {
      mayStart();
      const known = threads.has(thread);
      return started(of(thread).loop.send(text)).catch((error: unknown) => {
        // A thread whose first message wasn't taken was never used: nothing is held for it.
        if (!known) threads.delete(thread);
        throw error;
      });
    },
    /**
     * Run a thread's last turn again; what followed its message goes from the record. Refused as
     * `send` is.
     */
    async retry(thread: string) {
      mayStart();
      return started(of(thread).loop.retry());
    },
    /** Stop a thread's turn now. A call already running finishes, and its result is kept. */
    cancel: async (thread: string) => threads.get(thread)?.loop.cancel(),
    /** What a thread's loop is doing. */
    state: (thread: string): Status => threads.get(thread)?.loop.state() ?? { state: "idle" },
    /** A thread's messages before `before`, oldest first, as many as fit `limit`. */
    page: (thread: string, before: string | undefined, limit: number) =>
      of(thread).record.page(before, limit),
    /**
     * Stop: every turn is cut, running or waiting, and none starts until `start`. A call already
     * running finishes first, so this answers when nothing more will be written. The records stay
     * as they are, to be read.
     */
    async stop() {
      stopped = true;
      const loops = [...threads.values()].map(({ loop }) => loop);
      await Promise.all(loops.map((loop) => loop.cancel()));
      // A message being recorded as this was asked is recorded first, and a call still running ends.
      await Promise.all(starting);
      await Promise.all(loops.map((loop) => loop.drained()));
    },
    /** Take messages again. The turns `stop` cut stay cut. */
    start() {
      stopped = false;
    },
    /** Close for good: every turn is cut, and none starts after. */
    async close() {
      closed = true;
      await Promise.all([...threads.values()].map(({ loop }) => loop.cancel()));
    },
    /** Settles when every thread's latest turn has written all it will. */
    async settled() {
      await Promise.all([...threads.values()].map(({ loop }) => loop.settled()));
    },
    /** Text the model writes while it answers `requestId`, for the reply it becomes. */
    delta(requestId: string, text: string) {
      for (const { loop } of threads.values()) loop.delta(requestId, text);
    },
  };
}
export type Looper = ReturnType<typeof createLooper>;
