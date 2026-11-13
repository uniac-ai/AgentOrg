/**
 * The looper: the loops of whoever hosts it. Messages come in on threads, which are names its host
 * gives; a thread's messages are kept under `thread/<name>/` in the store. What answers them is a
 * piece of work, with a loop of its own, or, when a message needs no work, the main loop.
 *
 * Intake is code. A thread may be followed by several pieces of work, and a message in it is
 * given to each of them in a turn, or with none, to the one last active. One in a thread nothing
 * follows is kept, and the main loop decides on the thread: it answers itself, and the thread
 * stays no work's; or it says whose the message is, new work, or work there is, in a turn or at
 * rest, which then follows that thread too. The main loop makes one decision at a time, and one
 * for a thread on all that waits in it. A piece of work answers in the thread of the newest
 * message it has read.
 *
 * A worker decides each message it is given: it does it and answers, or hands it back, saying
 * it is not this work's. A message every piece of work it was given to has handed back is the
 * main loop's to decide, like one in a thread nothing follows; it is never given again to the
 * work that returned it.
 *
 * One piece of work is stopped by saying so. The main loop may answer a message in a thread
 * nothing follows by stopping the turn of work it was told of; and it is told of each message that
 * joins a turn of work that follows its thread, beside that work getting it, to stop one of
 * those turns if the message asks. The turn is cut and the work is at rest. What the main loop
 * says of it is said where the message was: in the stopped work's own record when it joined the
 * turn, for that work to read next, and otherwise in the asking thread alone.
 *
 * Turns run side by side, each in a place; the main loop takes none. There are `PLACES` of them,
 * and one more that only work already begun (it has done something) may take, so new work never
 * keeps a message from work that is under way. A turn that finds no place waits for one, in the
 * order it came. While begun work keeps five turns running, new work goes on waiting. `WAITING`
 * turns may wait; past that a message that would start a turn is refused `busy`.
 *
 * A piece of work is marked in the store from before a turn of it keeps anything until that turn
 * has ended, with the place the turn starts after, and a thread while it holds messages that
 * wait: for the main loop to decide on, or for work to take. A looper that closes under a turn
 * or a decision, or goes without closing, leaves the mark, and `resume` on the same store goes
 * on with it, once: with a turn, if anything of it was kept. A turn
 * that ends, fails or is stopped leaves no mark; a thread the main loop answered, couldn't place,
 * or was stopped over, waits for its next message, and the main loop is put what it holds.
 */

import { z } from "zod";
import type { FilesOf } from "./compaction.js";
import { createLoop, type Place } from "./loop.js";
import { createMain, type Listed, stopWord, TOLD, titled } from "./main.js";
import { createRecord, createThread, messageOf, READS, type Thread, userEntry } from "./record.js";
import {
  type Call,
  codeOf,
  head,
  type Json,
  type Log,
  type Model,
  type Picture,
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
 * What is kept of a piece of work: its title, the threads it follows, those of them it has left,
 * which it still reads and is given nothing more from, and once a turn of it has ended, when
 * that was, the head of what it last said, and whether that turn failed.
 */
const Work = z.object({
  title: z.string(),
  follows: z.array(z.string()).min(1),
  left: z.array(z.string()).optional(),
  at: z.string().optional(),
  last: z.string().optional(),
  failed: z.literal(true).optional(),
  stopped: z.literal(true).optional(),
});

/** Where a thread's record is kept in the looper's store. */
const recordOf = (thread: string) => `thread/${encodeURIComponent(thread)}/`;
/**
 * Where a piece of work is marked while a turn of it hasn't ended: with the place the turn
 * starts after, or `true` for a turn on what its work held before.
 */
const UNFINISHED = "unfinished/";
/**
 * Where a thread is marked while it holds messages that wait: in a thread nothing follows, what
 * was said there; in one that work follows, what came back from all it was given to, or what a
 * piece of work has still to take. `true` while the main loop is still to decide on it, or work
 * to take them, so the next start goes on with it, and `false` once the main loop has answered
 * it, couldn't, or was stopped, when the thread's next message asks.
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
  /** What the piece of work `work` did, or whether it is at work, changed: ask `entries` again. */
  worked(work: string): void;
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
  /**
   * A turn was stopped, not closed: end what its calls left running, by the group they were made
   * under (see `Tool.run`). Not asked when a turn ends by itself, or when the looper closes.
   */
  stopGroup?(group: string): Promise<unknown>;
  /**
   * Who a message said in `thread` is from, as its worker and the main loop are told: none for
   * the person, whom they are told of by default. In a thread of anyone else, the main loop is
   * told only of the work that follows it, and so routes into and stops only that.
   */
  speaker?(thread: string): string | undefined;
  /**
   * The files a call of its tools read and changed, by the call's name and arguments: a summary of
   * a work's earlier steps lists them, carried from one summary to the next.
   */
  files?: FilesOf;
  log: Log;
}) {
  /** A message said in `thread`, as a worker or the main loop is told it: who it is from. */
  const told = (thread: string, text: string) => {
    const who = options.speaker?.(thread);
    return who ? `(from ${who}) ${text}` : text;
  };
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
  /** What is kept of each piece of work, and the pieces of work each thread is followed by. */
  const kept = new Map<string, z.output<typeof Work>>();
  const followed = new Map<string, string[]>();
  /**
   * Each thread's piece of work last active there: the last to answer there, or to be given a
   * message there, in code or by the main loop.
   */
  const lastIn = new Map<string, string>();
  /**
   * Have a thread be followed by a piece of work too, beside what follows it: its own work, if
   * it has one, is there first.
   */
  /** Whether a thread has work of its own name. */
  const hasOwn = (thread: string) => kept.has(thread) || works.has(thread);
  const link = (thread: string, work: string) => {
    const now = followed.get(thread) ?? (hasOwn(thread) ? [thread] : []);
    followed.set(thread, now.includes(work) ? now : [...now, work]);
  };
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
  /**
   * How many are at a thread that work follows, having marked it: a message being given to
   * several pieces of work, a message being handed back. Its mark stands while any is.
   */
  const flows = new Map<string, number>();
  /** Mark a thread that work follows, before something that will wait there is kept. */
  const hold = async (thread: string) => {
    flows.set(thread, (flows.get(thread) ?? 0) + 1);
    await wait(thread, true).catch(async (error: unknown) => {
      release(thread);
      await unheld(thread);
      throw error;
    });
  };
  const release = (thread: string) => {
    const left = (flows.get(thread) ?? 1) - 1;
    if (left > 0) flows.set(thread, left);
    else flows.delete(thread);
  };
  /** What was to wait at a thread was not kept: its mark goes again, unless something waits. */
  const unheld = (thread: string) =>
    tidy(thread).catch((error: unknown) =>
      log.warn("A thread's mark couldn't be looked at.", { thread, error: String(error) }),
    );
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

  /**
   * The pieces of work the store had marked when it was read, each with what its mark says: a
   * turn of an earlier looper that hadn't ended.
   */
  const cutOff = new Map<string, number | true>();
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
      // Read whole before any of it is known here: a thread never has part of its followers.
      const found: [string, z.output<typeof Work>][] = [];
      const marked: [string, boolean][] = [];
      const cut: [string, number | true][] = [];
      await read(WORKS, (id, value) => {
        const work = Work.safeParse(value);
        if (work.success) found.push([id, work.data]);
        else log.warn("A piece of work's record didn't read back; it is left out.", { id });
      });
      await read(UNROUTED, (thread, value) => void marked.push([thread, value === true]));
      await read(
        UNFINISHED,
        (id, value) => void cut.push([id, typeof value === "number" ? value : true]),
      );
      for (const [id, work] of found) {
        kept.set(id, work);
        for (const name of work.follows) if (!work.left?.includes(name)) link(name, id);
      }
      for (const [thread, again] of marked) marks.set(thread, again);
      for (const [id, after] of cut) cutOff.set(id, after);
    })();
    learned = attempt;
    attempt.catch(() => {
      if (learned === attempt) learned = undefined;
    });
    return attempt;
  };
  /**
   * The pieces of work a thread is followed by: those the main loop gave it, or its own when it
   * holds messages and isn't marked.
   */
  const followersOf = async (thread: string) => {
    await learn();
    const named = followed.get(thread);
    if (named) return named;
    if (marks.has(thread)) return [];
    return (await threadOf(thread).load()).records.length > 0 ? [thread] : [];
  };

  const open = (id: string) => {
    const record = createRecord({
      id,
      follows: () => kept.get(id)?.follows ?? [id],
      thread: threadOf,
      waits: (thread) => !hasOwn(thread),
      left: (thread) => kept.get(id)?.left?.includes(thread) === true,
      told,
    });
    const key = UNFINISHED + encodeURIComponent(id);
    const held = {
      record,
      /** Whether a turn of it is running, as its mark was last asked to say. */
      marked: false,
      /** Whether it was at work when its loop last said what it is doing. */
      active: false,
      /** What its mark in the store says, as it was read or last asked to say. */
      stands: cutOff.get(id) as number | true | undefined,
      /** Whether the turn now starting wrote that mark, and didn't find one standing. */
      wrote: false,
      /** The writes of its mark and of its record, one after another. */
      writes: Promise.resolve(),
      /**
       * Keep its mark, or take it off with `false`, after any write before. A number is the
       * place its turn starts after: whoever goes on with it does so only if something of the
       * turn was kept. `true` is a turn on what its work held before.
       */
      mark(on: number | boolean) {
        held.stands = on === false ? undefined : on;
        held.writes = held.writes
          .then(() => (on === false ? store.delete({ key }) : store.set({ key, value: on })))
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
        title: () => titleOf(id),
        others: () => othersOf(id),
        back: (handed) => returned(id, handed),
        ...(options.stopGroup ? { stopGroup: options.stopGroup } : {}),
        ...(options.files ? { files: options.files } : {}),
        // Marked before anything of the turn is kept, so a looper that goes in between leaves
        // it for the next to go on with.
        async starting(after) {
          held.marked = true;
          // A mark that stands is a turn cut off before, which nothing has gone on with: it is
          // kept, since what it says to go on with holds this turn's messages too.
          if (after === undefined) held.mark(true);
          else {
            held.wrote = held.stands === undefined;
            if (held.wrote) held.mark(after);
          }
          await held.writes;
        },
        unstarted(stopped) {
          if (!held.marked) return;
          held.marked = false;
          // Stopped, its work is not gone on with. With no turn begun, only its own mark goes.
          if (stopped || held.wrote) held.mark(false);
        },
        out: {
          message: out.message,
          // A work that answers in a thread is the one last active there.
          replied: (thread) => lastIn.set(thread, id),
          delta: out.delta,
          failed: out.failed,
          worked: () => out.worked(id),
          status(status) {
            const on = running(status);
            // A turn that starts is marked, but one that goes on from a cut-off has that mark
            // taken off: it goes on once. A turn that ends takes its mark off, but one cut by the
            // looper closing keeps it, for whoever opens the store next.
            // A turn that begins is said at once; one that ends, once its end is kept.
            if (on && !held.active) out.worked(id);
            held.active = on;
            if (on && !held.marked) held.mark(!held.loop.resumed());
            else if (!on && held.marked && !closed) {
              held.mark(false);
              ended(id, status.state === "error", held.loop.stopped());
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
  const titleOf = async (id: string): Promise<string> =>
    kept.get(id)?.title || titled(await of(id).record.opening());
  /**
   * The titles of the other work in the threads a piece of work follows and hasn't left, in the
   * order they began, the newest `TOLD.works`: kept with their messages, an order that changes
   * only as work begins, so the request its worker makes begins alike. A title once, and none it
   * has itself.
   */
  const othersOf = async (id: string): Promise<string[]> => {
    const work = kept.get(id);
    const ids = new Set<string>();
    for (const thread of work?.follows ?? [id])
      if (!work?.left?.includes(thread))
        for (const other of await followersOf(thread)) if (other !== id) ids.add(other);
    const others = await Promise.all(
      [...ids].map(async (other) => ({
        began: await of(other).record.began(),
        title: await titleOf(other),
      })),
    );
    others.sort((a, b) => a.began.localeCompare(b.began));
    const titles = new Set(others.map(({ title }) => title).filter((title) => title !== ""));
    titles.delete(await titleOf(id));
    return [...titles].slice(-TOLD.works);
  };
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
  const ended = (id: string, failed: boolean, stopped: boolean) => {
    const work = of(id);
    work.writes = work.writes
      .then(async () => {
        const last = await work.record.last();
        const title = await titleOf(id);
        // Read after the waits above: a decision may have kept that it follows a thread too.
        const { failed: _, stopped: __, ...was } = kept.get(id) ?? { title, follows: [id] };
        kept.set(id, {
          ...was,
          at: new Date().toISOString(),
          ...(last ? { last: head(last.replace(/\s+/g, " ").trim(), TOLD.last) } : {}),
          ...(failed ? { failed: true as const } : {}),
          ...(stopped ? { stopped: true as const } : {}),
        });
        await store.set({ key: WORKS + encodeURIComponent(id), value: kept.get(id) as Json });
        out.worked(id);
      })
      .catch((error: unknown) =>
        log.error("A work's record couldn't be written.", { work: id, error: String(error) }),
      );
  };
  /** Whether a turn of a piece of work is at work. */
  const workingNow = (id: string) => running(works.get(id)?.loop.state() ?? { state: "idle" });
  /**
   * A piece of work's entries, oldest first, the call it is running now last, until its record
   * keeps that call; paging back from that call starts where the record ends.
   */
  const entriesOf = async (id: string, before: string | undefined, limit: number) => {
    const now = works.get(id)?.loop.running();
    const fromRunning = now !== undefined && before === now.id;
    const kept = await of(id).record.entries(fromRunning ? undefined : before, limit);
    if (!now || before !== undefined || kept.entries.some((one) => one.id === now.id)) return kept;
    const entries = [...kept.entries, now];
    return { entries: entries.slice(-limit), more: kept.more || entries.length > limit };
  };
  /** Ask something of a piece of work's loop. */
  const using = <T>(id: string, ask: (loop: Work["loop"]) => Promise<T>) =>
    started(ask(of(id).loop));
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
  /**
   * The work there is, as the main loop is told of it for a message in `thread`: in a turn first,
   * then the latest at rest. In a thread of anyone but the person, only the work that follows it:
   * the person may reach all of it.
   */
  const listed = async (thread: string): Promise<Listed[]> => {
    const turnOf = (id: string) => works.get(id)?.loop.turn();
    // Work that has a record, and work in a turn that has none yet.
    const ids = new Set([
      ...kept.keys(),
      ...[...works.keys()].filter((id) => turnOf(id) !== undefined),
    ]);
    const reaches = (id: string) =>
      options.speaker?.(thread) === undefined || (kept.get(id)?.follows ?? [id]).includes(thread);
    const all = await Promise.all(
      [...ids].filter(reaches).map(async (id) => {
        const title = await titleOf(id);
        return {
          id,
          title,
          turn: turnOf(id),
          last: kept.get(id)?.last,
          failed: kept.get(id)?.failed,
          at: kept.get(id)?.at ?? "",
        };
      }),
    );
    return all
      .filter(({ title }) => title !== "")
      .sort(
        (a, b) =>
          Number(b.turn !== undefined) - Number(a.turn !== undefined) ||
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
    const open = works.has(work);
    // Work there was before works had records began in the thread of its own name.
    const before = was?.follows ?? (title === undefined ? [work] : []);
    const { left: gone, ...rest } = was ?? {};
    const left = gone?.filter((one) => one !== thread) ?? [];
    kept.set(work, {
      ...rest,
      title: named,
      follows: [...new Set([...before, thread])],
      ...(left.length > 0 ? { left } : {}),
    });
    try {
      await save(work);
    } catch (error) {
      // Not kept: it follows what it did, with whatever a turn's end has written since.
      const now = kept.get(work);
      if (was && now) {
        const { left: _, ...rest } = now;
        kept.set(work, {
          ...rest,
          title: was.title,
          follows: was.follows,
          ...(was.left ? { left: was.left } : {}),
        });
      } else {
        // New work that was opened only to be kept is not there.
        kept.delete(work);
        if (!open) works.delete(work);
      }
      throw error;
    }
    return work;
  };
  /**
   * Have the main loop decide on what waits for it in a thread, and keep what it says. In a
   * thread nothing follows that is what was said there; in one that work follows, the messages
   * that every piece of work they were given to handed back. It answers itself, which is the
   * thread's next message; or says whose what waits is, which is new work or work there is,
   * which then follows the thread too; or it cuts the turn it says to stop. It gives the work,
   * or none when the main loop only answered or stopped, when nothing waits, or once `cut` says
   * the looper stopped or closed.
   */
  const decide = async (thread: string, cut: () => boolean) => {
    const into = threadOf(thread);
    const follows = followed.get(thread) ?? [];
    // Read in the thread's line: a message being kept there now is kept first.
    const read = await inLine(thread, async () => {
      unread.delete(thread);
      const back = await into.returned();
      const read = await into.said(back.at(-1)?.seq);
      // Marked before a message that was never kept: nothing waits.
      if (read.said.length === 0) await settle(thread);
      return { ...read, back };
    });
    // Nothing waits: no message came back from all it was given to; or, where nothing follows,
    // nothing was said, or the main loop has answered the newest.
    if (read.back.length === 0 && (follows.length > 0 || read.said.at(-1)?.role !== "user"))
      return undefined;
    // Work that handed a message back is not told of: it is never given it again.
    const why = new Map(read.back.flatMap(({ by }) => by.map((one) => [one.work, one.why])));
    const there = (await listed(thread)).filter(({ id }) => !why.has(id));
    const returners = await Promise.all(
      [...why].map(async ([id, reason]) => ({ id, title: await titleOf(id), why: reason })),
    );
    if (cut()) return undefined;
    const replyId = crypto.randomUUID();
    const decided = await main.decide(
      read.said.map((one) =>
        one.role === "user" ? { ...one, text: told(thread, one.text) } : one,
      ),
      there,
      (text) => out.delta(thread, replyId, text),
      returners,
    );
    if (!decided || cut()) return undefined;
    const { placed, stop } = decided;
    // Stopping is cutting the turn it was told of, if that is still the work's turn. This thread
    // is answered either way, as the work is not its own: with what the main loop wrote, or with
    // whether a turn was cut.
    const cutTurn =
      stop?.turn !== undefined && (await works.get(stop.work)?.loop.cancel(stop.turn)) === true;
    const answer = decided.answer ?? (stop ? stopWord(cutTurn) : undefined);
    // New work has the thread's name as its id, unless the thread has work already or holds a
    // message that came back: then what is there is not all its own, and it takes what waits.
    const title = placed && "title" in placed ? placed.title : undefined;
    const to =
      placed &&
      ("work" in placed
        ? placed.work
        : follows.length > 0 || hasOwn(thread) || read.back.length > 0
          ? crypto.randomUUID()
          : thread);
    // What came back names the work it is given to, new work with its title. That one write is
    // the decision: whatever of the rest is not done now, the thread's next routing does.
    if (to !== undefined)
      await into.offer(
        read.back.map(({ id }) => id),
        to,
        title,
      );
    // Whose it is is kept before what the main loop said: an answer beside it is never all that
    // is left of a decision.
    const work = to === undefined ? undefined : await follow(thread, to, title);
    try {
      if (answer !== undefined)
        // What it said itself is the thread's, kept before any work takes what waits. With
        // nothing placed and nothing said meanwhile, a thread nothing follows waits for its next
        // message, not for the next start; a message said meanwhile is still to be decided on.
        await inLine(thread, async () => {
          // With nothing placed, the answer is what decides what came back: it names it.
          const { entry, late } = await into.answer(
            answer,
            read.back.at(-1)?.seq ?? read.upTo,
            replyId,
            {
              followed: follows.length > 0,
              answers: work === undefined ? read.back.map(({ id }) => id) : [],
            },
          );
          out.message(thread, messageOf(entry));
          // A message said after what came back, where nothing follows, is decided on next.
          if (follows.length === 0 && late && read.back.length > 0) unread.add(thread);
          if (follows.length === 0 && work === undefined && !late)
            await wait(thread, false).catch((error: unknown) =>
              log.warn("A thread's mark couldn't be written.", { thread, error: String(error) }),
            );
        });
    } finally {
      // Only now is the thread its work's to be sent in: after what the main loop said there,
      // or couldn't keep. Whose it is stands either way, as it is kept.
      if (work !== undefined) {
        link(thread, work);
        lastIn.set(thread, work);
      }
    }
    return work;
  };
  /**
   * Decisions are made one at a time, each to its end, so each knows what the last began. What
   * the main loop hears of a message that joined a turn takes its place in the same line.
   */
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
        // What waits there by now is looked at here: only what is kept after this is routed
        // again when this has ended.
        unread.delete(thread);
        const into = threadOf(thread);
        // Work a message here waits for was given it by a decision or by code: it follows the
        // thread, new work under the title the decision gave it, and takes what waits.
        const offered = async () => {
          const offers = await into.offers();
          for (const { work, title } of offers)
            if (!(followed.get(thread) ?? []).includes(work)) {
              await follow(thread, work, kept.has(work) ? undefined : title);
              link(thread, work);
            }
          for (const { work } of offers) lastIn.set(thread, work);
          return offers.map(({ work }) => work);
        };
        await offered();
        // What waits is the main loop's to decide, unless work follows the thread and nothing
        // came back from all of it: then it is for that work to take.
        const follows = followed.get(thread) ?? [];
        const theirs = follows.length > 0 && (await into.returned()).length === 0;
        const decidedOn = theirs ? undefined : await decide(thread, cut);
        const takers = [
          ...new Set([
            ...(theirs ? follows : []),
            ...(decidedOn === undefined ? [] : [decidedOn]),
            ...(await offered()),
          ]),
        ];
        // In the thread's line: a message being kept there now is kept first, and goes with them.
        await inLine(thread, async () => {
          if (cut()) return;
          // A message that came back meanwhile is still the main loop's: decided on next. The
          // mark goes when nothing waits, as the store has it, and nobody else is at the thread.
          const done = async () => {
            const { returned, offers } = await threadOf(thread).waiting();
            if (returned.length > 0) unread.add(thread);
            else if (offers.length === 0 && !flows.has(thread)) await settle(thread);
          };
          if (takers.length === 0) {
            // Where work follows, what the main loop answered waits no more.
            if (follows.length > 0 && !unread.has(thread)) await done();
            return;
          }
          // All that is kept there by now is given: none of it is still to be decided on.
          unread.delete(thread);
          let taken = true;
          for (const work of takers) {
            // Stopped or closed between two of them: the rest take it when they next keep.
            if (cut()) return;
            const took = await using(work, (loop) => loop.adopt(thread));
            taken &&= took !== false;
          }
          // Its work was told to stop first: they wait for the thread's next message, unless
          // one came back from all meanwhile, which is decided on next.
          if (!taken) {
            if (!cut() && !unread.has(thread)) await wait(thread, false);
            return;
          }
          await done();
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
  /**
   * Of `followers`, the pieces of work that follow `thread`, those a message said there is given
   * to: each in a turn, running or waiting for a place; with none, the one last active there.
   * Until one has been since the looper started, it is the one whose last turn ended latest, and
   * on a tie the one that followed later. What that one hands back is the main loop's to decide.
   * So a message costs a request for each in a turn, or at most two, however much work a thread
   * gathers.
   */
  const takersOf = (thread: string, followers: string[]) => {
    const inTurn = followers.filter((id) => works.get(id)?.loop.turn() !== undefined);
    if (inTurn.length > 0 || followers.length === 0) return inTurn;
    const there = lastIn.get(thread);
    if (there !== undefined && followers.includes(there)) return [there];
    const last = (id: string) => kept.get(id)?.at ?? "";
    return [followers.reduce((one, other) => (last(other) >= last(one) ? other : one))];
  };
  /** Keep a message in a thread nothing follows, and have it routed, unless a stop came since `at`. */
  const intake = async (thread: string, text: string, at: number, images?: Picture[]) => {
    const was = marks.get(thread);
    const entry = await (async () => {
      await wait(thread, true);
      const into = threadOf(thread);
      const { record, stored } = into.push(await into.load(), userEntry(text, images));
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
  /**
   * Tell the main loop of a message said in `thread` that joined a turn of each of `joined`,
   * which follow it: it may only stop one of those turns, and then what it says is kept in the
   * thread as that work's to read next. With several in a turn it may instead say which they
   * are, when the message asks to stop and doesn't say which: that is kept as no work's. This is
   * beside the message's path, after the decisions asked before it, and stops nothing once a
   * turn has ended. A message a work takes with a thread, said before it followed that thread,
   * is not told of, nor is one with no words, which can ask nothing. It is not kept: one cut off
   * by a stop, a close or a restart is not heard, and the workers have the message all the same.
   */
  const hear = (thread: string, joined: { work: string; turn: number }[], text: string) => {
    if (stopped || closed || joined.length === 0 || !/\S/.test(text)) return;
    const at = cuts;
    const cut = () => at !== cuts;
    const still = () => joined.filter(({ work, turn }) => of(work).loop.turn() === turn);
    decided = decided
      .then(async () => {
        if (cut() || still().length === 0) return;
        const titles = new Map<string, string>();
        for (const { work } of still()) titles.set(work, await titleOf(work));
        const heardOf = still().map(({ work, turn }) => ({
          id: work,
          title: titles.get(work) ?? "",
          turn,
        }));
        if (cut() || heardOf.length === 0) return;
        const heard = await main.hear(told(thread, text), heardOf);
        if (!heard || cut()) return;
        const { say, stop } = heard;
        // A line the store refuses is the thread's to be told of: the turn is cut all the same.
        await (stop
          ? of(stop.work).loop.cancel(stop.turn, { text: say, thread })
          : (async () => {
              const into = threadOf(thread);
              const { last } = await into.load();
              const { entry } = await into.answer(say, last, crypto.randomUUID(), {
                followed: true,
              });
              out.message(thread, messageOf(entry));
            })()
        ).catch((error: unknown) => {
          log.error("What the main loop said of a message to work in a turn couldn't be kept.", {
            thread,
            error: String(error),
          });
          out.failed(thread, codeOf(error));
        });
      })
      .catch((error: unknown) =>
        log.warn("A message said to work in a turn wasn't heard.", {
          thread,
          error: String(error),
        }),
      );
  };
  /**
   * Once nobody is at a thread that work follows: what still waits there (a message that came
   * back from all it was given to, or one a piece of work has still to take) is routed, and
   * with nothing waiting the thread's mark goes. This is the one place such a mark is taken off.
   */
  const tidy = async (thread: string) => {
    const busy = () => stopped || closed || routes.has(thread) || flows.has(thread);
    if (busy() || !followed.get(thread)?.length) return;
    // As the store has it: a message a piece of work is taking still waits until that is kept.
    const { returned, offers } = await threadOf(thread).waiting();
    if (busy()) return;
    if (returned.length === 0 && offers.length === 0) {
      if (marks.has(thread)) await settle(thread);
      return;
    }
    unread.add(thread);
    if (marks.get(thread) !== true)
      await wait(thread, true).catch((error: unknown) =>
        log.warn("A thread's mark couldn't be written.", { thread, error: String(error) }),
      );
    route(thread);
  };
  /**
   * Give a message to `to`, the work following its thread that takes it. With one piece of work
   * it is that work's to keep. With several it is kept once, naming each, and each takes it in its
   * own order: a turn takes it at its next request, and work whose turn has ended since starts one.
   */
  const give = async (
    to: string[],
    thread: string,
    text: string,
    at: number,
    images?: Picture[],
  ) => {
    const joined: { work: string; turn: number }[] = [];
    /** Whether one of its works couldn't take it: it waits for that work, marked. */
    let missed = false;
    let sent: { messageId: string };
    const [only] = to;
    // Given to several, the one that followed later is last active there.
    const latest = to.at(-1);
    if (latest !== undefined) lastIn.set(thread, latest);
    if (to.length === 1 && only !== undefined) {
      const { turn, ...kept } = await using(only, (loop) => loop.send(text, thread, images));
      if (turn !== undefined) joined.push({ work: only, turn });
      sent = kept;
    } else {
      const into = threadOf(thread);
      // Marked before it is kept: whoever opens the store next gives it to each piece of work
      // that has not taken it by then.
      await started(hold(thread));
      let stored = false;
      try {
        const entry = await started(
          (async () => {
            const { record, stored } = into.push(await into.load(), {
              ...userEntry(text, images),
              to: to.map((work) => ({ work })),
            });
            await stored;
            return record.entry;
          })(),
        );
        stored = true;
        out.message(thread, messageOf(entry));
        sent = { messageId: entry.id };
        await taking();
      } finally {
        release(thread);
        if (!stored) await unheld(thread);
      }
    }
    /** Each piece of work takes it, in its own order. */
    async function taking() {
      for (const work of to) {
        // Stopped or closed since it was said: those that haven't taken it are given it by the
        // next start, or with the thread's next message.
        if (at !== cuts) break;
        try {
          const took = await using(work, (loop) => loop.adopt(thread));
          if (took && took.turn !== undefined) joined.push({ work, turn: took.turn });
        } catch (error) {
          // It is kept and the others have it: this one is told it got no answer, and takes it
          // with what it keeps next.
          log.error("A message couldn't be taken by one of its works.", {
            thread,
            work,
            error: String(error),
          });
          out.failed(thread, codeOf(error));
          missed = true;
        }
      }
    }
    // One that joined a turn is that turn's; and the main loop hears of it, to stop a turn if
    // that is what it asks.
    hear(thread, joined, text);
    // What still waits there is routed, or the thread's mark goes: unless one of its works
    // couldn't take this, which then waits, marked, for the thread's next message or a start.
    if (!missed && at === cuts) await tidy(thread);
    return sent;
  };
  /**
   * A worker hands a message back: it says so on the message, stops following the thread it was
   * said in if it asks to and didn't begin there, and when every piece of work the message was
   * given to has handed it back, it is the main loop's to decide.
   */
  const returned = async (
    work: string,
    { message, why, leave }: { message: number; why: string; leave: boolean },
  ): Promise<string> => {
    const unkept = (what: string) => (error: unknown) =>
      log.error(`${what} couldn't be kept.`, { work, error: String(error) });
    let left = false;
    let began = false;
    // Work from before works had records is kept first, so a message names work there is a
    // record of: such work began in the thread of its own name.
    if (!kept.has(work)) await follow(work, work);
    // The thread is marked before the message says it was handed back: whoever opens the store
    // next decides on it, if this looper doesn't.
    let at: string | undefined;
    try {
      const done = await of(work).record.back(message, why, async (thread) => {
        await hold(thread);
        at = thread;
      });
      if (!done)
        throw new Refusal(
          "invalid",
          "No message of this work has that number, or it was handed back already.",
        );
      const { thread } = done;
      // It is handed back from here on, whatever the store refuses of what follows. One that
      // came back from all is the main loop's, whatever it is deciding there now.
      if (done.all) unread.add(thread);
      const record = kept.get(work);
      const gone = record?.left?.includes(thread) === true;
      began = record?.follows[0] === thread;
      if (!gone) link(thread, work);
      if (leave && record !== undefined && !began && !gone) {
        // It has left from here on: it takes nothing more there and is given nothing more
        // from it, and still reads what it holds there.
        const leaves = (on: boolean) => {
          const { left: was, ...now } = kept.get(work) as z.output<typeof Work>;
          const gone = [...(was ?? []).filter((one) => one !== thread), ...(on ? [thread] : [])];
          kept.set(work, { ...now, ...(gone.length > 0 ? { left: gone } : {}) });
          const rest = (followed.get(thread) ?? []).filter((one) => one !== work);
          if (!on) followed.set(thread, [...rest, work]);
          else if (rest.length > 0) followed.set(thread, rest);
          else followed.delete(thread);
        };
        leaves(true);
        // What waited there for it, untaken, it hands back unread, and then it is kept as
        // having left. If that can't be kept it has not left, and takes what still waits.
        try {
          const dropped = await of(work).record.drop(thread, "It left that conversation.");
          if (dropped.all) unread.add(thread);
          await save(work).catch(unkept("A work's record"));
        } catch (error) {
          unkept("A message")(error);
          // Some of it may be handed back already, and have come back from all.
          unread.add(thread);
          leaves(false);
        }
        // Unless it was given the thread again meanwhile.
        left = kept.get(work)?.left?.includes(thread) === true;
      }
    } catch (error) {
      if (at !== undefined) {
        release(at);
        await unheld(at);
        at = undefined;
      }
      throw error;
    } finally {
      if (at !== undefined) release(at);
    }
    // What waits there now is routed: this message, if every piece of work it was given to has
    // handed it back, or one that this work's leaving decided. A thread nothing follows any
    // more has its next message put to the main loop.
    const thread = at as string;
    if (followed.has(thread)) await tidy(thread);
    else if ((await threadOf(thread).returned()).length > 0) {
      unread.add(thread);
      route(thread);
    } else await wait(thread, false).catch(unkept("A thread's mark"));
    return left
      ? "Handed back. This work no longer follows that conversation."
      : leave && began
        ? "Handed back. This work began in that conversation, so it still follows it."
        : "Handed back.";
  };

  /**
   * Go on with what was cut off when this store was last used, by a looper closing under it or
   * going without closing: each turn that hadn't ended, once, waiting for a place like any turn;
   * and each thread whose messages were still to be given to a piece of work, once too. A turn
   * that can't go on now keeps its mark for the next time. A stopped looper goes on with none:
   * its turns' marks go, and its waiting messages wait for their thread's next. Whoever hosts the
   * looper calls this when a request can be made; once the marks have been read, a later call
   * does nothing, but a stop's. `drop` goes on with nothing, as a stopped looper does.
   */
  const goOn = async (drop: boolean) => {
    const at = cuts;
    /** Whether anything may still go on: not once it has stopped or closed since this began. */
    const going = () => !drop && !stopped && at === cuts;
    await learn();
    // A message said before this was asked is given first: its work then has a turn of its
    // own, and is not gone on with.
    await Promise.all([...starting]);
    for (const [id, after] of cutOff) {
      // Closed meanwhile: what is left stays marked, for whoever opens the store next.
      if (closed) return;
      const held = of(id);
      try {
        // Asked at once, so a stop or a close from here on comes after it: `after` is the
        // place its turn was to start after, where its mark says. Not work whose mark has gone
        // since it was read: a turn of its ended, or it was stopped.
        if (going() && held.stands !== undefined)
          await using(id, (loop) => loop.resume(typeof after === "number" ? after : undefined));
        // Work in a turn now keeps the mark as that turn's, and a looper that has closed leaves
        // it. Otherwise nothing goes on, and it goes, where one still stands.
        if (!held.marked && !closed && held.stands !== undefined) held.mark(false);
      } catch (error) {
        log.warn("A turn that was cut off didn't go on.", { work: id, error: String(error) });
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
    // A stop looks again, whatever was looked for before: a turn that couldn't go on then kept
    // its mark, and a stopped looper leaves none.
    if (!looked || drop) {
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
     * Say a message in a thread. It is recorded and said at once. In a thread that work follows
     * it is given to each piece of it in a turn, which takes it at its next model request; with
     * none in a turn, to the one last active, which starts a turn, waiting for a place if none is
     * free. In a thread nothing follows, the main loop answers it or says whose it is first.
     * Refused `busy` while `WAITING` turns already wait and it would start one more, or while the
     * looper is stopped; and `unavailable` once it has closed.
     */
    send(thread: string, text: string, images?: Picture[]) {
      try {
        mayStart();
      } catch (error) {
        return Promise.reject(error);
      }
      const at = cuts;
      // Work known here is asked at once, so a stop that comes after this cuts it too. Given to
      // several, it goes through the thread's line, so each takes one message after another in
      // the order they were said.
      const known = takersOf(
        thread,
        followed.get(thread) ?? (!marks.has(thread) && works.has(thread) ? [thread] : []),
      );
      if (known.length === 1 && !lines.get(thread)?.waiting)
        return give(known, thread, text, at, images);
      return started(
        inLine(thread, async () => {
          const to = takersOf(thread, await followersOf(thread));
          // Stopped or closed while its work was found: nothing of it is kept.
          mayStart(at);
          return to.length === 0
            ? intake(thread, text, at, images)
            : give(to, thread, text, at, images);
        }),
      );
    },
    /** Stop a piece of work's turn now. A call already running finishes, and its result is kept. */
    cancel: async (work: string) => void (await works.get(work)?.loop.cancel()),
    /**
     * Its pieces of work, most recently active first, as many as `limit`, those last active before
     * the piece of work `before` if one is given: each with its title, whether it is working, idle or stopped,
     * when it was last active, whether its last turn failed, and its `entries` latest entries,
     * the call it is running now last. Refused `unknown` for a `before` there isn't.
     */
    async works(limit: number, entries: number, before?: string) {
      await learn();
      const now = new Date().toISOString();
      /** Most recently active first, and by id where two were last active at once. */
      const order = (a: { id: string; at?: string | undefined }, b: typeof a) =>
        (b.at ?? "").localeCompare(a.at ?? "") || b.id.localeCompare(a.id);
      const all = [...kept]
        .map(([id, work]) => ({ id, work, at: workingNow(id) ? now : work.at }))
        .sort(order);
      const cursor = before === undefined ? undefined : kept.get(before);
      if (before !== undefined && !cursor)
        throw new Refusal("unknown", "There is no such piece of work.");
      // Those last active before it, by the time it was kept with: a piece of work that has
      // become active since doesn't make a page repeat what came before.
      const mark = cursor && { id: before as string, at: cursor.at ?? now };
      const latest = all.filter((one) => !mark || order(mark, one) < 0).slice(0, limit);
      return Promise.all(
        latest.map(async ({ id, work, at }) => ({
          id,
          title: work.title,
          state: workingNow(id)
            ? ("working" as const)
            : work.stopped
              ? ("stopped" as const)
              : ("idle" as const),
          ...(at ? { at } : {}),
          ...(work.failed ? { failed: true as const } : {}),
          ...(await entriesOf(id, undefined, entries)),
        })),
      );
    },
    /**
     * A piece of work's entries, oldest first: those before the entry `before`, as many as
     * `limit`, the call it is running now last; and whether more came before them. Refused
     * `unknown` for work there isn't.
     */
    async entries(work: string, before: string | undefined, limit: number) {
      await learn();
      if (!kept.has(work)) throw new Refusal("unknown", "There is no such piece of work.");
      return entriesOf(work, before, limit);
    },
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
      await decided;
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
      // The marks that look took off are off before this answers.
      await Promise.all([...works.values()].map(({ writes }) => writes));
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
      await Promise.all([
        ...[...works.values()].map(({ loop }) => loop.cancel(undefined, undefined, true)),
        main.cancel(),
      ]);
    },
    /** Settles when every piece of work's latest turn has written all it will. */
    async settled() {
      // Until nothing more was decided meanwhile: a worker may give the main loop a message.
      for (let was: unknown; was !== decided; ) {
        was = decided;
        await was;
        await Promise.all([...works.values()].map(({ loop }) => loop.settled()));
        await Promise.all([...works.values()].map(({ writes }) => writes));
      }
    },
    /**
     * Text the model writes while it answers `requestId`: of the main loop's reply, or, with
     * `call`, of a function call's arguments, where a worker's `send` streams into the thread of
     * the message it names. What a worker writes without sending says nothing.
     */
    delta(requestId: string, text: string, call?: Call) {
      if (!call) main.delta(requestId, text);
      else for (const { loop } of works.values()) loop.stream(requestId, call, text);
    },
  };
}
export type Looper = ReturnType<typeof createLooper>;

/** Every key of `store` under `prefix`, in order. */
async function keysOf(store: Store, prefix: string) {
  const keys: string[] = [];
  let after: string | undefined;
  do {
    const page = await store.list({ prefix, ...(after === undefined ? {} : { after }) });
    keys.push(...page.keys);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return keys;
}
/**
 * Drop from `store` what a looper keeps of `threads`, before a looper is made on it: each one's
 * record and mark, and each piece of work's following of it. A piece of work left with no
 * thread it is still given anything from goes too, with its mark. It answers how many went.
 */
export async function forget(store: Store, threads: string[]): Promise<{ works: number }> {
  const gone = new Set(threads);
  for (const thread of gone) {
    // The newest first: a thread cut short keeps how it began, and its newest is no newer.
    for (const key of (await keysOf(store, recordOf(thread))).reverse())
      await store.delete({ key });
    await store.delete({ key: UNROUTED + encodeURIComponent(thread) });
  }
  let works = 0;
  for (const key of await keysOf(store, WORKS)) {
    const work = Work.safeParse((await store.get({ key })).value);
    if (!work.success || !work.data.follows.some((thread) => gone.has(thread))) continue;
    const follows = work.data.follows.filter((thread) => !gone.has(thread));
    const left = (work.data.left ?? []).filter((thread) => !gone.has(thread));
    if (follows.every((thread) => left.includes(thread))) {
      await store.delete({ key });
      await store.delete({ key: UNFINISHED + key.slice(WORKS.length) });
      works++;
      continue;
    }
    const { left: _, ...rest } = work.data;
    await store.set({
      key,
      value: { ...rest, follows, ...(left.length > 0 ? { left } : {}) } as Json,
    });
  }
  return { works };
}
