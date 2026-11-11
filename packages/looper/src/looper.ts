/**
 * The looper: the loops of whoever hosts it. Messages come in on threads, which are names its host
 * gives; a thread's messages are kept under `thread/<name>/` in the store. What answers them is a
 * piece of work, with a loop of its own, or, when a message needs no work, the main loop.
 *
 * Intake is code. A message in a thread that a piece of work follows is given to that work. One in
 * a thread nothing follows is kept, and the main loop decides on the thread: it answers itself, and
 * the thread stays no work's; or it says whose the message is, new work, which has the thread's
 * name as its id, or work there is, in a turn or at rest, which then follows that thread too. The
 * main loop makes one decision at a time, and one for a thread on all that waits in it. A piece
 * of work answers in the thread of the newest message it has read.
 *
 * Turns run side by side, each in a place; the main loop takes none. There are `PLACES` of them,
 * and one more that only work already begun (it has done something) may take, so new work never
 * keeps a message from work that is under way. A turn that finds no place waits for one, in the
 * order it came. While begun work keeps five turns running, new work goes on waiting. `WAITING`
 * turns may wait; past that a message that would start a turn is refused `busy`.
 *
 * A piece of work is marked in the store while a turn of it hasn't ended, and a thread while no
 * work follows it and it holds messages. A looper that closes under a turn or a decision, or goes
 * without closing, leaves the mark, and `resume` on the same store goes on with it, once. A turn
 * that ends, fails or is stopped leaves no mark; a thread the main loop answered, couldn't place,
 * or was stopped over, waits for its next message, and the main loop is put what it holds.
 */

import { z } from "zod";
import { createLoop, type Place } from "./loop.js";
import { createMain, type Listed, TOLD, titled } from "./main.js";
import {
  createRecord,
  createThread,
  head,
  messageOf,
  READS,
  type Thread,
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
/**
 * What is kept of a piece of work: its title, the threads it follows, and once a turn of it has
 * ended, when that was, the head of what it last said, and whether that turn failed.
 */
const Work = z.object({
  title: z.string(),
  follows: z.array(z.string()).min(1),
  at: z.string().optional(),
  last: z.string().optional(),
  failed: z.literal(true).optional(),
});

/** Where a thread's record is kept in the looper's store. */
const recordOf = (thread: string) => `thread/${encodeURIComponent(thread)}/`;
/** Where a piece of work is marked while a turn of it hasn't ended. */
const UNFINISHED = "unfinished/";
/**
 * Where a thread is marked while it holds messages and no piece of work has taken them: `true`
 * while the main loop is still to decide on it, or work to take them, so the next start goes on
 * with it, and `false` once the main loop has answered it, couldn't, or was stopped, when the
 * thread's next message asks.
 */
const UNROUTED = "unrouted/";
/** Where what is kept of a piece of work is kept. */
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
   * what it can call, and which model to ask, none meaning the model's own default. `voice` is
   * who the main loop speaks as when it answers a message itself: what the host's own model is
   * told of itself, with nothing of what it can call.
   */
  request(): Promise<{
    instructions: string;
    tools: Tool[];
    model?: string | undefined;
    voice?: string | undefined;
  }>;
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
  /** What is kept of each piece of work, and the work each thread has. */
  const kept = new Map<string, z.output<typeof Work>>();
  const followed = new Map<string, string>();
  /**
   * The threads that are marked, since no work has taken what they hold, each with what its mark
   * says: whether the next start goes on with it.
   */
  const marks = new Map<string, boolean>();
  /** The marked threads in which a message was kept since the main loop last read them. */
  const unread = new Set<string>();
  const markOf = (thread: string) => UNROUTED + encodeURIComponent(thread);
  /** Mark a thread: `again` is whether the next start goes on with it. */
  const wait = (thread: string, again: boolean) => {
    marks.set(thread, again);
    return store.set({ key: markOf(thread), value: again });
  };
  /** Take a thread's mark off: a piece of work has what it holds, or it holds nothing. */
  const settle = async (thread: string) => {
    marks.delete(thread);
    unread.delete(thread);
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
    /** What the store holds under `prefix`, a few at a time, each given with its key's last part. */
    const read = async (prefix: string, each: (name: string, value: Json | undefined) => void) => {
      const keys = await keysUnder(prefix);
      for (let at = 0; at < keys.length; at += READS) {
        const some = keys.slice(at, at + READS);
        const values = await Promise.all(some.map((key) => store.get({ key })));
        for (const [i, key] of some.entries())
          each(decodeURIComponent(key.slice(prefix.length)), values[i]?.value);
      }
    };
    const attempt = (async () => {
      await read(WORKS, (id, value) => {
        const work = Work.safeParse(value);
        if (!work.success) {
          log.warn("A piece of work's record didn't read back; it is left out.", { id });
          return;
        }
        kept.set(id, work.data);
        for (const name of work.data.follows) followed.set(name, id);
      });
      await read(UNROUTED, (thread, value) => void marks.set(thread, value === true));
    })();
    learned = attempt;
    attempt.catch(() => {
      if (learned === attempt) learned = undefined;
    });
    return attempt;
  };
  /**
   * The work a thread is followed by, if any: the one the main loop gave it, or its own when it
   * holds messages and isn't marked.
   */
  const workOf = async (thread: string) => {
    await learn();
    const work = followed.get(thread);
    if (work !== undefined) return work;
    if (marks.has(thread)) return undefined;
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
      /** The writes of its mark and of its record, one after another. */
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
            else if (!on && held.marked && !closed) {
              held.mark(false);
              ended(id, status.state === "error");
            }
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
  /** Keep a work's record as it stands when its turn to be written comes. */
  const save = (id: string) => {
    const work = of(id);
    const written = work.writes.then(async () => {
      const record = kept.get(id);
      if (record) await store.set({ key: WORKS + encodeURIComponent(id), value: record });
    });
    work.writes = written.then(
      () => {},
      () => {},
    );
    return written;
  };
  /**
   * A turn of a piece of work has ended: keep when, the head of what it last said, and whether it
   * failed, for the main loop to tell of it.
   */
  const ended = (id: string, failed: boolean) => {
    const work = of(id);
    work.writes = work.writes
      .then(async () => {
        const last = await work.record.last();
        const title = await titleOf(id);
        // Read after the waits above: a decision may have kept that it follows a thread too.
        const { failed: _, ...was } = kept.get(id) ?? { title, follows: [id] };
        kept.set(id, {
          ...was,
          at: new Date().toISOString(),
          ...(last ? { last: head(last.replace(/\s+/g, " ").trim(), TOLD.last) } : {}),
          ...(failed ? { failed: true as const } : {}),
        });
        await store.set({ key: WORKS + encodeURIComponent(id), value: kept.get(id) as Json });
      })
      .catch((error: unknown) =>
        log.error("A work's record couldn't be written.", { work: id, error: String(error) }),
      );
  };
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

  const main = createMain({ model: options.model, request: options.request, log });
  /** The work there is, as the main loop is told of it: in a turn first, then the latest at rest. */
  const listed = async (): Promise<Listed[]> => {
    const inTurn = (id: string) => running(works.get(id)?.loop.state() ?? { state: "idle" });
    // Work that has a record, and work in a turn that has none yet.
    const ids = new Set([...kept.keys(), ...[...works.keys()].filter(inTurn)]);
    const all = await Promise.all(
      [...ids].map(async (id) => ({
        id,
        title: await titleOf(id),
        running: inTurn(id),
        last: kept.get(id)?.last,
        failed: kept.get(id)?.failed,
        at: kept.get(id)?.at ?? "",
      })),
    );
    return all
      .filter(({ title }) => title !== "")
      .sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          b.at.localeCompare(a.at) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, TOLD.works)
      .map(({ at: _, ...work }) => work);
  };
  /**
   * Keep that a piece of work follows a thread too, under `title` if it is new: kept before the
   * thread's messages are taken, so a start in between finds whose they are.
   */
  const follow = async (thread: string, work: string, title?: string) => {
    const named = title ?? (await titleOf(work));
    const was = kept.get(work);
    kept.set(work, {
      ...was,
      title: named,
      follows: [...new Set([...(was?.follows ?? [work]), thread])],
    });
    try {
      await save(work);
    } catch (error) {
      // Not kept: it follows what it did, with whatever a turn's end has written since.
      const now = kept.get(work);
      if (was && now) kept.set(work, { ...now, title: was.title, follows: was.follows });
      else kept.delete(work);
      throw error;
    }
    return work;
  };
  /**
   * Have the main loop decide on a thread nothing follows, and keep what it says: an answer of
   * its own, which is the thread's next message, and whose what was said there is, which is new
   * work of the thread's own or work there is, which then follows the thread too. It gives the
   * work, or none when the main loop only answered, when nothing waits for an answer, or once
   * `cut` says the looper stopped or closed.
   */
  const decide = async (thread: string, cut: () => boolean) => {
    // Read in the thread's line: a message being kept there now is kept first.
    const read = await inLine(thread, async () => {
      unread.delete(thread);
      const read = await threadOf(thread).said();
      // Marked before a message that was never kept: nothing waits.
      if (read.said.length === 0) await settle(thread);
      return read;
    });
    // Nothing waits for an answer: nothing was said, or the main loop has answered the newest.
    if (read.said.at(-1)?.role !== "user") return undefined;
    const there = await listed();
    if (cut()) return undefined;
    const replyId = crypto.randomUUID();
    const decided = await main.decide(read.said, there, (text) => out.delta(thread, replyId, text));
    if (!decided || cut()) return undefined;
    const { answer, placed } = decided;
    // Whose it is is kept first: an answer beside it is never all that is left of a decision.
    const work =
      placed &&
      ("work" in placed
        ? await follow(thread, placed.work)
        : await follow(thread, thread, placed.title));
    try {
      if (answer !== undefined)
        // What it said itself is the thread's, kept before any work takes the thread. With
        // nothing placed and nothing said meanwhile, the thread waits for its next message, not
        // for the next start; a message said meanwhile is still to be decided on.
        await inLine(thread, async () => {
          const { entry, late } = await threadOf(thread).answer(answer, read.upTo, replyId);
          out.message(thread, messageOf(entry));
          if (work === undefined && !late)
            await wait(thread, false).catch((error: unknown) =>
              log.warn("A thread's mark couldn't be written.", { thread, error: String(error) }),
            );
        });
    } finally {
      // Only now is the thread its work's to be sent in: after what the main loop said there,
      // or couldn't keep. Whose it is stands either way, as it is kept.
      if (work !== undefined) followed.set(thread, work);
    }
    return work;
  };
  /** Decisions are made one at a time, each to its end, so each knows what the last began. */
  let decided: Promise<unknown> = Promise.resolve();
  /**
   * Give the messages waiting in a thread to a piece of work: the one it has, or the one the main
   * loop says. One at a time for a thread, on all that waits in it; what is said there meanwhile
   * goes with them, or is decided on when that has ended without taking it. Once the looper has
   * stopped or closed since this was asked, nothing starts, and what waits goes on waiting.
   */
  const route = (thread: string) => {
    if (stopped || closed) return;
    if (routes.has(thread)) return;
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
          // All that is kept there by now is given: none of it is still to be decided on.
          unread.delete(thread);
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
        // Still waiting: for the thread's next message, not for the next start; unless one was
        // kept meanwhile, which is decided on next. In the thread's line, after one being kept.
        await inLine(thread, async () => {
          if (marks.has(thread) && !unread.has(thread)) await wait(thread, false);
        }).catch(() => {});
      })
      .finally(() => {
        routes.delete(thread);
        // Not once it has stopped or closed since: then what waits goes on waiting.
        if (unread.has(thread) && !cut() && marks.has(thread)) route(thread);
        tally();
      });
    decided = routing;
    routes.set(thread, routing);
    tally();
  };
  /** Keep a message in a thread nothing follows, and have it routed, unless a stop came since `at`. */
  const intake = async (thread: string, text: string, at: number) => {
    const was = marks.get(thread);
    const entry = await (async () => {
      await wait(thread, true);
      const into = threadOf(thread);
      const { record, stored } = into.push(await into.load(), userEntry(text));
      await stored;
      unread.add(thread);
      return record.entry;
    })().catch(async (error: unknown) => {
      // Not kept: the thread's mark is as it was before it.
      if (was === undefined) await settle(thread);
      else await wait(thread, was).catch(() => {});
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
    if (marks.has(thread) && !routes.has(thread)) await settle(thread);
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
    for (const [thread, again] of [...marks]) {
      // Closed meanwhile: what waits keeps its mark, for whoever opens the store next.
      if (closed) return;
      // Only what was still to go on, and once: whatever comes of it, the next start doesn't.
      if (!again) continue;
      try {
        // In the thread's line, so its mark is written apart from a message kept there.
        await inLine(thread, async () => {
          if (routes.has(thread) || marks.get(thread) !== true || closed) return;
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
     * thread nothing follows, the main loop answers it or says whose it is first. Refused `busy` while `WAITING`
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
        followed.get(thread) ?? (!marks.has(thread) && works.has(thread) ? thread : undefined);
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
      await Promise.all([...works.values()].map(({ writes }) => writes));
      // What was cut off earlier and hasn't gone on doesn't after a stop either: its marks go.
      // Nor does the next start go on with what waits: a thread's next message does.
      await resume(true)
        .then(() =>
          Promise.all(
            [...marks].flatMap(([thread, again]) => (again ? [wait(thread, false)] : [])),
          ),
        )
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
      main.delta(requestId, text);
      for (const { loop } of works.values()) loop.delta(requestId, text);
    },
  };
}
export type Looper = ReturnType<typeof createLooper>;
