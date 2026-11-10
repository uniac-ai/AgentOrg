/**
 * The looper: the loops of whoever hosts it, one for each thread a message comes in on. A thread is
 * a name its host gives; its record is kept under `thread/<name>/` in the store, and its loop and
 * record are made when the thread is first used and then stay in memory.
 *
 * Turns run side by side, each in a place. There are `PLACES` of them, and one more that only a
 * thread already begun (its record holds something) may take, so new threads never keep a message
 * from one that is under way. A turn that finds no place waits for one, in the order it came. While
 * begun threads keep five turns running, a new thread goes on waiting. `WAITING` turns may wait;
 * past that a message that would start a turn is refused `busy`, and nothing of it is kept.
 *
 * A thread is marked in the store while a turn of it hasn't ended. A looper that closes under a
 * turn, or goes without closing, leaves the mark, and `resume` on the same store goes on with that
 * turn, once: the turn that goes on is not marked. A turn that ends, fails or is stopped leaves
 * no mark.
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
/** Where a thread is marked while a turn of it hasn't ended. */
const UNFINISHED = "unfinished/";

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
  type Held = ReturnType<typeof open>;
  const threads = new Map<string, Held>();
  /** Set while it is stopped: no turn starts until it is started. */
  let stopped = options.stopped ?? false;
  /** Set when it closes: no turn starts after. */
  let closed = false;
  /** Set once the turns that were cut off have been looked for. */
  let looked = false;
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
    else throw new Refusal("busy", "Too many turns are waiting. Wait for one to start.");
    return place;
  };

  const open = (thread: string) => {
    const record = createRecord(under(store, recordOf(thread)), log);
    const key = UNFINISHED + encodeURIComponent(thread);
    const held = {
      record,
      /** What is being asked of its loop now: messages, going on. */
      uses: 0,
      /** Whether a turn of it is running, as its mark was last asked to say. */
      marked: false,
      /** Its mark's writes, one after another. */
      writes: Promise.resolve(),
      /** Keep its mark, or take it off, after any write before. */
      mark(on: boolean) {
        held.writes = held.writes
          .then(() => (on ? store.set({ key, value: true }) : store.delete({ key })))
          .then(
            () => {},
            (error: unknown) =>
              log.error("A thread's mark couldn't be written.", { thread, error: String(error) }),
          );
      },
      loop: createLoop({
        request: options.request,
        model: options.model,
        enter,
        record,
        out: {
          message: (message) => out.message(thread, message),
          delta: (id, text) => out.delta(thread, id, text),
          status(status) {
            const running = status.state === "thinking" || status.state === "tool";
            // A turn that starts is marked, but one that goes on from a cut-off has that mark
            // taken off: it goes on once. A turn that ends takes its mark off, but one cut by the
            // looper closing keeps it, for whoever opens the store next.
            if (running && !held.marked) held.mark(!held.loop.resumed());
            else if (!running && held.marked && !closed) held.mark(false);
            held.marked = running;
            out.status(thread, status);
          },
        },
        log,
      }),
    };
    return held;
  };
  /**
   * Ask something of a thread's loop. A thread first named by an ask that fails, with nothing else
   * asked of it meanwhile, was never used: nothing is held for it.
   */
  const using = async <T>(thread: string, ask: (loop: Held["loop"]) => Promise<T>) => {
    const known = threads.has(thread);
    const held = of(thread);
    held.uses++;
    try {
      return await started(ask(held.loop));
    } catch (error) {
      if (!known && held.uses === 1) threads.delete(thread);
      throw error;
    } finally {
      held.uses--;
    }
  };
  const of = (thread: string) => {
    const found = threads.get(thread) ?? open(thread);
    threads.set(thread, found);
    return found;
  };

  /**
   * Go on with each turn that was cut off when this store was last used: by a looper closing
   * under it, or going without closing. Each goes on once, and waits for a place like any turn.
   * One that can't go on now keeps its mark for the next time. A stopped looper goes on with
   * none, and its marks go: so does one stopped before it was asked to. Whoever hosts the looper calls this when a request can be made;
   * once the marks have been read, a later call does nothing.
   */
  async function resume() {
    if (looked || closed) return;
    looked = true;
    const keys: string[] = [];
    try {
      let after: string | undefined;
      do {
        const page = await store.list({ prefix: UNFINISHED, ...(after ? { after } : {}) });
        keys.push(...page.keys);
        after = page.next ?? undefined;
      } while (after);
    } catch (error) {
      looked = false;
      throw error;
    }
    for (const key of keys) {
      // Closed meanwhile: what is left stays marked, for whoever opens the store next.
      if (closed) return;
      const thread = decodeURIComponent(key.slice(UNFINISHED.length));
      const held = of(thread);
      try {
        if (!stopped) await using(thread, (loop) => loop.resume());
        // A thread in a turn now keeps the mark as that turn's, and a looper that has closed
        // leaves it. Otherwise nothing goes on, and it goes.
        if (!held.marked && !closed) held.mark(false);
      } catch (error) {
        log.warn("A turn that was cut off didn't go on.", { key, error: String(error) });
      }
    }
  }

  return {
    /**
     * Say a message in a thread. It is recorded and said at once. With no turn in the thread it
     * starts one, which waits for a place if none is free; a turn running or waiting takes it at
     * its next model request. Refused `busy` while `WAITING` turns already wait and it would start
     * one more, or while the looper is stopped; and `unavailable` once it has closed.
     */
    async send(thread: string, text: string) {
      mayStart();
      const sent = await using(thread, (loop) => loop.send(text));
      // Recorded as the looper closed, its turn was cut before it began: it is marked like one.
      const held = threads.get(thread);
      if (closed && held && !held.marked) held.mark(true);
      return sent;
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
     * as they are, to be read. A turn that was cut off earlier no longer goes on.
     */
    async stop() {
      stopped = true;
      const loops = [...threads.values()].map(({ loop }) => loop);
      await Promise.all(loops.map((loop) => loop.cancel()));
      // A message being recorded as this was asked is recorded first, and a call still running ends.
      await Promise.all(starting);
      await Promise.all(loops.map((loop) => loop.drained()));
      // What was cut off earlier and hasn't gone on doesn't after a stop either: its marks go.
      await resume().catch((error: unknown) =>
        log.warn("The turns that were cut off couldn't be looked for.", { error: String(error) }),
      );
    },
    /** Take messages again. The turns `stop` cut stay cut. */
    start() {
      stopped = false;
    },
    resume,
    /**
     * Close for good: every turn is cut, and none starts after. Each stays marked, for `resume`
     * in whoever opens the store next.
     */
    async close() {
      closed = true;
      await Promise.all([...threads.values()].map(({ loop }) => loop.cancel()));
    },
    /** Settles when every thread's latest turn has written all it will. */
    async settled() {
      await Promise.all([...threads.values()].map(({ loop }) => loop.settled()));
      await Promise.all([...threads.values()].map(({ writes }) => writes));
    },
    /** Text the model writes while it answers `requestId`, for the reply it becomes. */
    delta(requestId: string, text: string) {
      for (const { loop } of threads.values()) loop.delta(requestId, text);
    },
  };
}
export type Looper = ReturnType<typeof createLooper>;
