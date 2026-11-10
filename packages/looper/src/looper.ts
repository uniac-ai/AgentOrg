/**
 * The looper: the loops of whoever hosts it. Messages come in on threads, which are names its host
 * gives; a thread's messages are kept under `thread/<name>/` in the store. What answers them is a
 * piece of work, with a loop of its own.
 *
 * Intake is code. A message in a thread that a piece of work follows is given to that work. One in
 * a thread nothing follows is kept, and the main loop says whose it is: new work, which has the
 * thread's name as its id, or work in a turn now, which then follows that thread too. The main
 * loop makes one decision at a time, and one for a thread on all that waits in it. A piece of
 * work answers in the thread of the newest message it has read.
 *
 * Turns run side by side, each in a place; the main loop takes none. There are `PLACES` of them,
 * and one more that only work already begun (it has done something) may take, so new work never
 * keeps a message from work that is under way. A turn that finds no place waits for one, in the
 * order it came. While begun work keeps five turns running, new work goes on waiting. `WAITING`
 * turns may wait; past that a message that would start a turn is refused `busy`.
 *
 * A piece of work is marked in the store while a turn of it hasn't ended, and a thread while
 * messages wait in it. A looper that closes under either, or goes without closing, leaves the
 * mark, and `resume` on the same store goes on with it, once. A turn that ends, fails or is
 * stopped leaves no mark; messages the main loop couldn't place, or was stopped over, wait for
 * their thread's next message, and all of them are put to the main loop together.
 */
import { createLoop, type Place } from "./loop.js";
import { createMain, titled } from "./main.js";
import {
  createRecord,
  createThread,
  messageOf,
  READS,
  type Thread,
  textOf,
  userEntry,
} from "./record.js";
import {
  codeOf,
  type Json,
  type Log,
  type Model,
  Refusal,
  type Shown,
  type Status,
  type Store,
  type Tool,
} from "./types.js";

/** The turns that run at once, not counting the one more for work already begun. */
export const PLACES = 4;
/** The turns that may wait for a place at once. */
export const WAITING = 16;

/** Where a thread's record is kept in the looper's store. */
const recordOf = (thread: string) => `thread/${encodeURIComponent(thread)}/`;
/** Where a piece of work is marked while a turn of it hasn't ended. */
const UNFINISHED = "unfinished/";
/**
 * Where a thread is marked while messages wait in it for a piece of work to take them: `true`
 * while that is still to happen, so the next start goes on with it, and `false` once it couldn't
 * or was stopped, when the thread's next message does.
 */
const UNROUTED = "unrouted/";
/** Where a piece of work's title and the threads it follows are kept. */
const WORKS = "work/";
const running = (status: Status) => status.state === "thinking" || status.state === "tool";

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

/** Where a looper says what it does. */
export interface LooperOut {
  /** A message, with the thread it is shown in. */
  message(thread: string, message: Shown): void;
  /** Text of the reply `id` as the model writes it. */
  delta(thread: string, id: string, text: string): void;
  /** Whether anything is at work, the main loop included: said when it changes. */
  working(on: boolean): void;
  /** A message in `thread` got no answer, and why. */
  failed(thread: string, problem: { code: string; message: string }): void;
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
  type Work = ReturnType<typeof open>;
  /** The pieces of work that have a loop here, by id. */
  const works = new Map<string, Work>();
  const threads = new Map<string, Thread>();
  /** A thread's messages, read when first asked for. */
  const threadOf = (name: string) => {
    const found = threads.get(name) ?? createThread(under(store, recordOf(name)), log);
    threads.set(name, found);
    return found;
  };
  /** What is kept of each piece of work the main loop placed, and the work each thread has. */
  const kept = new Map<string, { title: string; follows: string[] }>();
  const followed = new Map<string, string>();
  /** The threads that are marked: messages wait in them. */
  const unrouted = new Set<string>();
  const markOf = (thread: string) => UNROUTED + encodeURIComponent(thread);
  /** Keep a thread's mark: `again` is whether the next start goes on with what waits there. */
  const wait = (thread: string, again: boolean) => store.set({ key: markOf(thread), value: again });
  /** Take a thread's mark off: nothing waits there. */
  const settle = async (thread: string) => {
    unrouted.delete(thread);
    await store
      .delete({ key: markOf(thread) })
      .catch((error: unknown) =>
        log.warn("A thread's mark couldn't be taken off.", { thread, error: String(error) }),
      );
  };
  /** The threads being decided or given now; each settles when that has ended. */
  const routes = new Map<string, Promise<void>>();
  /** Set while it is stopped: no turn starts until it is started. */
  let stopped = options.stopped ?? false;
  /** Set when it closes: no turn starts after. */
  let closed = false;
  /** Counts the stops and the close: what was asked before one starts nothing after it. */
  let cuts = 0;
  /** Refuse a turn that can't start now, or was asked for before a stop, whatever its thread. */
  const mayStart = (at = cuts) => {
    if (closed) throw new Refusal("unavailable", "This agent is closing.");
    if (stopped || at !== cuts) throw new Refusal("busy", "It is stopped. Start it to go on.");
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

  /** Whether anything is at work, as it was last said. */
  let working = false;
  const tally = () => {
    const now = routes.size > 0 || [...works.values()].some(({ loop }) => running(loop.state()));
    if (now === working) return;
    working = now;
    out.working(now);
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

  /** What the store holds of the work the main loop placed, and of what waits: read once. */
  let learned: Promise<void> | undefined;
  const keysUnder = async (prefix: string) => {
    const keys: string[] = [];
    let after: string | undefined;
    do {
      const page = await store.list({ prefix, ...(after ? { after } : {}) });
      keys.push(...page.keys);
      after = page.next ?? undefined;
    } while (after);
    return keys;
  };
  const learn = () => {
    if (learned) return learned;
    const attempt = (async () => {
      const keys = await keysUnder(WORKS);
      for (let at = 0; at < keys.length; at += READS) {
        const some = keys.slice(at, at + READS);
        const values = await Promise.all(some.map((key) => store.get({ key })));
        some.forEach((key, i) => {
          const value = values[i]?.value as { title?: Json; follows?: Json } | undefined;
          const follows = Array.isArray(value?.follows)
            ? value.follows.filter((name): name is string => typeof name === "string")
            : [];
          if (follows.length === 0) {
            log.warn("A piece of work's record didn't read back; it is left out.", { key });
            return;
          }
          const id = decodeURIComponent(key.slice(WORKS.length));
          kept.set(id, { title: typeof value?.title === "string" ? value.title : "", follows });
          for (const name of follows) followed.set(name, id);
        });
      }
      for (const key of await keysUnder(UNROUTED))
        unrouted.add(decodeURIComponent(key.slice(UNROUTED.length)));
    })();
    learned = attempt;
    attempt.catch(() => {
      if (learned === attempt) learned = undefined;
    });
    return attempt;
  };
  /**
   * The work a thread is followed by, if any: the one the main loop gave it, or its own when it
   * holds messages and none of them waits.
   */
  const workOf = async (thread: string) => {
    await learn();
    const work = followed.get(thread);
    if (work !== undefined) return work;
    if (unrouted.has(thread)) return undefined;
    return (await threadOf(thread).load()).records.length > 0 ? thread : undefined;
  };

  const open = (id: string) => {
    const record = createRecord({
      id,
      follows: () => kept.get(id)?.follows ?? [id],
      thread: threadOf,
    });
    const key = UNFINISHED + encodeURIComponent(id);
    const held = {
      record,
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
              log.error("A work's mark couldn't be written.", { work: id, error: String(error) }),
          );
      },
      loop: createLoop({
        request: options.request,
        model: options.model,
        enter,
        record,
        out: {
          message: out.message,
          delta: out.delta,
          failed: out.failed,
          status(status) {
            const on = running(status);
            // A turn that starts is marked, but one that goes on from a cut-off has that mark
            // taken off: it goes on once. A turn that ends takes its mark off, but one cut by the
            // looper closing keeps it, for whoever opens the store next.
            if (on && !held.marked) held.mark(!held.loop.resumed());
            else if (!on && held.marked && !closed) held.mark(false);
            held.marked = on;
            tally();
          },
        },
        log,
      }),
    };
    return held;
  };
  const of = (id: string) => {
    const found = works.get(id) ?? open(id);
    works.set(id, found);
    return found;
  };
  /** A work's title: the main loop's, or its opening line for work begun before it had one. */
  const titleOf = async (id: string) =>
    kept.get(id)?.title || titled(await of(id).record.opening());
  /** Ask something of a piece of work's loop. */
  const using = <T>(id: string, ask: (loop: Work["loop"]) => Promise<T>) =>
    started(ask(of(id).loop));
  /** Work given something as the looper closed, its turn cut before it began: marked like one. */
  const leftAtClose = (id: string) => {
    const work = works.get(id);
    if (closed && work && !work.marked) work.mark(true);
  };

  /**
   * What is asked of a thread whose work has to be found, or is being given it, taken one at a
   * time in the order it was asked; and how much is still to be taken.
   */
  const lines = new Map<string, { last: Promise<unknown>; waiting: number }>();
  const inLine = <T>(thread: string, take: () => Promise<T>) => {
    const line = lines.get(thread) ?? { last: Promise.resolve(), waiting: 0 };
    lines.set(thread, line);
    line.waiting++;
    const taken = line.last.then(take).finally(() => void line.waiting--);
    line.last = taken.catch(() => {});
    return taken;
  };

  const main = createMain({
    model: options.model,
    chosen: async () => (await options.request()).model,
    log,
  });
  /**
   * Have the main loop say whose the messages waiting in a thread are, and keep what it says:
   * new work of the thread's own, or work in a turn now, which then follows the thread too.
   * Nothing is decided, and it says so with none, once `cut` says the looper stopped or closed.
   */
  const decide = async (thread: string, cut: () => boolean) => {
    // Read in the thread's line: a message being kept there now is kept first.
    const texts = await inLine(thread, async () => {
      const { records } = await threadOf(thread).load();
      const said = records.flatMap(({ entry }) => (entry.role === "user" ? [textOf(entry)] : []));
      // Marked before a message that was never kept: nothing waits.
      if (said.length === 0) await settle(thread);
      return said;
    });
    if (texts.length === 0) return undefined;
    const underway = await Promise.all(
      [...works]
        .filter(([, { loop }]) => running(loop.state()))
        .map(async ([id]) => ({ id, title: await titleOf(id) })),
    );
    if (cut()) return undefined;
    const routed = await main.route(texts, underway);
    if (!routed || cut()) return undefined;
    const work = "work" in routed ? routed.work : thread;
    const record = {
      title: "work" in routed ? await titleOf(work) : routed.title,
      follows: [...new Set([...(kept.get(work)?.follows ?? [work]), thread])],
    };
    // Kept before the messages are taken, so a start in between finds whose they are.
    await store.set({ key: WORKS + encodeURIComponent(work), value: record });
    kept.set(work, record);
    followed.set(thread, work);
    return work;
  };
  /** Decisions are made one at a time, each to its end, so each knows what the last began. */
  let decided: Promise<unknown> = Promise.resolve();
  /** The threads a message was kept in while they were being decided or given. */
  const again = new Set<string>();
  /**
   * Give the messages waiting in a thread to a piece of work: the one it has, or the one the main
   * loop says. One at a time for a thread, on all that waits in it; what is said there meanwhile
   * goes with them, or is asked about when that has ended without taking it. Once the looper has
   * stopped or closed since this was asked, nothing starts, and what waits goes on waiting.
   */
  const route = (thread: string) => {
    if (stopped || closed) return;
    if (routes.has(thread)) return void again.add(thread);
    const at = cuts;
    const cut = () => at !== cuts;
    const routing = decided
      .then(async () => {
        if (cut()) return;
        const work = followed.get(thread) ?? (await decide(thread, cut));
        if (work === undefined) return;
        // In the thread's line: a message being kept there now is kept first, and goes with them.
        await inLine(thread, async () => {
          if (cut()) return;
          if (!(await using(work, (loop) => loop.adopt(thread)))) {
            // Its work was told to stop first: they wait for the thread's next message.
            if (!cut()) await wait(thread, false);
            return;
          }
          leftAtClose(work);
          await settle(thread);
        });
      })
      .catch(async (error: unknown) => {
        if (closed) return;
        log.error("A message got no answer.", { thread, error: String(error) });
        out.failed(thread, codeOf(error));
        // Still waiting: for the thread's next message, not for the next start.
        if (unrouted.has(thread)) await wait(thread, false).catch(() => {});
      })
      .finally(() => {
        routes.delete(thread);
        // Not once it has stopped or closed since: then what waits goes on waiting.
        if (again.delete(thread) && !cut() && unrouted.has(thread)) route(thread);
        tally();
      });
    decided = routing;
    routes.set(thread, routing);
    tally();
  };
  /** Keep a message in a thread nothing follows, and have it routed, unless a stop came since `at`. */
  const intake = async (thread: string, text: string, at: number) => {
    const waited = unrouted.has(thread);
    unrouted.add(thread);
    const entry = await (async () => {
      await wait(thread, true);
      const into = threadOf(thread);
      const { record, stored } = into.push(await into.load(), userEntry(text));
      await stored;
      return record.entry;
    })().catch(async (error: unknown) => {
      // Not kept: nothing of it waits, unless an earlier message of the thread does.
      if (!waited) await settle(thread);
      throw error;
    });
    out.message(thread, messageOf(entry));
    // Stopped or closed while it was kept, it waits: for the next message, or the next start.
    if (at === cuts) route(thread);
    return { messageId: entry.id };
  };
  /** Give a message to the work its thread is followed by. */
  const give = async (work: string, thread: string, text: string) => {
    const sent = await using(work, (loop) => loop.send(text, thread));
    leftAtClose(work);
    // What waited there, its work decided but not begun, went with it.
    if (unrouted.has(thread) && !routes.has(thread)) await settle(thread);
    return sent;
  };

  /**
   * Go on with what was cut off when this store was last used, by a looper closing under it or
   * going without closing: each turn that hadn't ended, once, waiting for a place like any turn;
   * and each thread whose messages were still to be given to a piece of work, once too. A turn
   * that can't go on now keeps its mark for the next time. A stopped looper goes on with none:
   * its turns' marks go, and its waiting messages wait for their thread's next. Whoever hosts the
   * looper calls this when a request can be made; once the marks have been read, a later call
   * does nothing. `drop` goes on with nothing, as a stopped looper does.
   */
  const goOn = async (drop: boolean) => {
    const at = cuts;
    /** Whether anything may still go on: not once it has stopped or closed since this began. */
    const going = () => !drop && !stopped && at === cuts;
    await learn();
    const keys = await keysUnder(UNFINISHED);
    for (const key of keys) {
      // Closed meanwhile: what is left stays marked, for whoever opens the store next.
      if (closed) return;
      const id = decodeURIComponent(key.slice(UNFINISHED.length));
      const held = of(id);
      try {
        if (going()) await using(id, (loop) => loop.resume());
        // Work in a turn now keeps the mark as that turn's, and a looper that has closed leaves
        // it. Otherwise nothing goes on, and it goes.
        if (!held.marked && !closed) held.mark(false);
      } catch (error) {
        log.warn("A turn that was cut off didn't go on.", { key, error: String(error) });
      }
    }
    for (const thread of [...unrouted]) {
      // Closed meanwhile: what waits keeps its mark, for whoever opens the store next.
      if (closed) return;
      try {
        // In the thread's line, so its mark is read and written apart from a message kept there.
        await inLine(thread, async () => {
          if (routes.has(thread) || !unrouted.has(thread)) return;
          // Only what was still to go on, and once: whatever comes of it, the next start doesn't.
          if ((await store.get({ key: markOf(thread) })).value !== true || closed) return;
          if (going()) route(thread);
          await wait(thread, false);
        });
      } catch (error) {
        log.warn("A message that was waiting wasn't placed.", { thread, error: String(error) });
      }
    }
  };
  /** What was cut off is looked for once; a look that couldn't read the store is made again. */
  let looked: Promise<void> | undefined;
  const resume = (drop = false) => {
    if (closed) return Promise.resolve();
    if (!looked) {
      const look = goOn(drop);
      looked = look;
      look.catch(() => {
        if (looked === look) looked = undefined;
      });
    }
    return looked;
  };

  return {
    /**
     * Say a message in a thread. It is recorded and said at once. In a thread a piece of work
     * follows it is that work's: with no turn of it running it starts one, which waits for a place
     * if none is free, and a turn running or waiting takes it at its next model request. In a
     * thread nothing follows, the main loop says whose it is first. Refused `busy` while `WAITING`
     * turns already wait and it would start one more, or while the looper is stopped; and
     * `unavailable` once it has closed.
     */
    send(thread: string, text: string) {
      try {
        mayStart();
      } catch (error) {
        return Promise.reject(error);
      }
      const at = cuts;
      // Work known here is asked at once, so a stop that comes after this cuts it too.
      const known =
        followed.get(thread) ?? (!unrouted.has(thread) && works.has(thread) ? thread : undefined);
      if (known !== undefined && !lines.get(thread)?.waiting) return give(known, thread, text);
      return started(
        inLine(thread, async () => {
          const work = await workOf(thread);
          // Stopped or closed while its work was found: nothing of it is kept.
          mayStart(at);
          return work === undefined ? intake(thread, text, at) : give(work, thread, text);
        }),
      );
    },
    /** Stop a piece of work's turn now. A call already running finishes, and its result is kept. */
    cancel: async (work: string) => works.get(work)?.loop.cancel(),
    /** What a piece of work's loop is doing. */
    state: (work: string): Status => works.get(work)?.loop.state() ?? { state: "idle" },
    /** A thread's messages before `before`, oldest first, as many as fit `limit`. */
    page: (thread: string, before: string | undefined, limit: number) =>
      threadOf(thread).page(before, limit),
    /**
     * Stop: every turn is cut, running or waiting, the main loop is cut too, and nothing starts
     * until `start`. A call already running finishes first, so this answers when nothing more will
     * be written. The records stay as they are, to be read. What was cut off earlier no longer
     * goes on, and messages waiting for a piece of work wait for their thread's next.
     */
    async stop() {
      stopped = true;
      cuts++;
      const loops = [...works.values()].map(({ loop }) => loop);
      await Promise.all([...loops.map((loop) => loop.cancel()), main.cancel()]);
      // A message being recorded as this was asked is recorded first, and a call still running ends.
      await Promise.all(starting);
      await Promise.all(routes.values());
      await Promise.all(loops.map((loop) => loop.drained()));
      // What was cut off earlier and hasn't gone on doesn't after a stop either: its marks go.
      // Nor does the next start go on with what waits: a thread's next message does.
      await resume(true)
        .then(() => Promise.all([...unrouted].map((thread) => wait(thread, false))))
        .catch((error: unknown) =>
          log.warn("What was cut off couldn't be looked for.", { error: String(error) }),
        );
    },
    /** Take messages again. The turns `stop` cut stay cut. */
    start() {
      stopped = false;
    },
    resume: () => resume(),
    /**
     * Close for good: every turn is cut, and none starts after. Each stays marked, as does each
     * thread where messages wait, for `resume` in whoever opens the store next.
     */
    async close() {
      closed = true;
      cuts++;
      await Promise.all([...[...works.values()].map(({ loop }) => loop.cancel()), main.cancel()]);
    },
    /** Settles when every piece of work's latest turn has written all it will. */
    async settled() {
      await Promise.all(routes.values());
      await Promise.all([...works.values()].map(({ loop }) => loop.settled()));
      await Promise.all([...works.values()].map(({ writes }) => writes));
    },
    /** Text the model writes while it answers `requestId`, for the reply it becomes. */
    delta(requestId: string, text: string) {
      for (const { loop } of works.values()) loop.delta(requestId, text);
    },
  };
}
export type Looper = ReturnType<typeof createLooper>;
