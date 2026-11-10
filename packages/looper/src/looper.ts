/**
 * The looper: the loops of whoever hosts it, one for each thread a message comes in on. A thread is
 * a name its host gives; its record is kept under `thread/<name>/` in the store, and its loop and
 * record are made when the thread is first used and then stay in memory.
 */
import { createLoop } from "./loop.js";
import { createRecord } from "./record.js";
import type { Log, Model, Shown, Status, Store, Tool } from "./types.js";

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
  log: Log;
}) {
  const { store, out, log } = options;
  const threads = new Map<string, ReturnType<typeof open>>();

  const open = (thread: string) => {
    const record = createRecord(under(store, recordOf(thread)), log);
    const loop = createLoop({
      request: options.request,
      model: options.model,
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
    /** Start a turn in a thread with a message; refused `busy` while the thread is in one. */
    send: (thread: string, text: string) => of(thread).loop.send(text),
    /** Run a thread's last turn again; what followed its message goes from the record. */
    retry: (thread: string) => of(thread).loop.retry(),
    /** Stop a thread's turn now. A call already running finishes, and its result is kept. */
    cancel: async (thread: string) => threads.get(thread)?.loop.cancel(),
    /** What a thread's loop is doing. */
    state: (thread: string): Status => threads.get(thread)?.loop.state() ?? { state: "idle" },
    /** A thread's messages before `before`, oldest first, as many as fit `limit`. */
    page: (thread: string, before: string | undefined, limit: number) =>
      of(thread).record.page(before, limit),
    /** Settles when a turn stopped in a thread has no call still running. */
    drained: async (thread: string) => threads.get(thread)?.loop.drained(),
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
