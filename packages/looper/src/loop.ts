/**
 * A loop: a turn sends its record and the tools to the model, runs each function the model calls,
 * and sends the results back, until the model answers without calling anything, or the turn has
 * made its `MAX_CALLS` calls. A message said while a turn runs is recorded at once, and the turn
 * takes it at its next model request. A loop is one piece of work's: its messages come in the
 * threads the work follows, and what comes of a request is kept in the thread of the newest
 * message that request read.
 */
import { argumentsOf, head, type LoopRecord, messageOf, userEntry } from "./record.js";
import { capped, runTool } from "./tools.js";
import {
  codeOf,
  type Item,
  type Log,
  type Model,
  Refusal,
  type Shown,
  type Status,
  type Tool,
} from "./types.js";

/** A brake on a turn, not a budget: nothing approves a call, and the person can stop it. */
export const MAX_CALLS = 200;
/** What a thread shows, and its model is told, when a turn that was cut off goes on. */
const CUT_OFF = {
  shown: "Cut off by a restart: going on from where it stopped.",
  told: "This turn was cut off by a restart. Check what is already done before you repeat anything, then go on.",
};

type FunctionCall = Extract<Item, { type: "function_call" }>;
/** Where a loop says what it does, each message with the thread it is shown in. */
export interface LoopOut {
  message(thread: string, message: Shown): void;
  /** Text of the reply `id` as the model writes it. */
  delta(thread: string, id: string, text: string): void;
  /** What it is doing. */
  status(status: Status): void;
  /** A message in `thread` got no answer, and why: said before the `error` status. */
  failed(thread: string, problem: { code: string; message: string }): void;
}
interface Turn {
  cancelled: boolean;
  /** The model request running now. */
  requestId?: string | undefined;
  /** The id of the reply that request becomes, which its streamed text carries. */
  replyId?: string | undefined;
  /** Settles when the turn's loop has ended. */
  ended?: Promise<void>;
  /** Its place among the turns running, or in the line for one. */
  place?: Place;
  /** Set until it has that place. */
  waiting?: boolean;
  /** Set while it waits for its end to be taken: it writes nothing meanwhile. */
  ending?: boolean;
  /** Set on a turn that goes on from one that was cut off. */
  resumed?: boolean;
  /** The thread it answers in now: that of the newest message its latest request read. */
  thread?: string;
  /** The threads it has taken a message in: each is told if it fails. */
  took: Set<string>;
}
/** A turn's place among the turns running: `entered` settles when it has it, or has left. */
export interface Place {
  entered: Promise<void>;
  /** Give the place back, or stop waiting for it. */
  leave(): void;
}

export function createLoop(options: {
  /**
   * Read for each model request, since any of it may change between two: what the model is told,
   * what it can call, and which model to ask, none meaning the model's own default.
   */
  request(): Promise<{ instructions: string; tools: Tool[]; model?: string | undefined }>;
  model: Model;
  /**
   * Ask for a place for a turn about to start, or a turn in the line for one. `begun` says whether
   * its record held anything before it. It throws when the turn can't be taken now.
   */
  enter(begun: boolean): Place;
  record: LoopRecord;
  out: LoopOut;
  log: Log;
}) {
  const { model, record, out, log } = options;
  let turn: Turn | undefined;
  /** A cancelled turn whose running call hasn't settled: the next turn waits for its records. */
  let draining: Promise<void> | undefined;
  /** Settles when the latest turn's loop has ended. */
  let lastEnded: Promise<void> | undefined;
  /** The latest status, for a view that asks. */
  let latest: Status = { state: "idle" };
  /** Set once a turn has started here: nothing that was cut off earlier is left to go on with. */
  let began = false;
  /** Counts the cancels, so that what was asked before one can tell when it is taken after it. */
  let cancels = 0;
  /** What is being taken now: the next thing asked is taken after it. */
  let taking: Promise<unknown> = Promise.resolve();
  /**
   * Take what was asked in the order it was asked, one at a time: a message, going on, a turn's
   * end. `cancelled` says whether a cancel came between its asking and its taking.
   */
  const inOrder = <T>(take: (cancelled: boolean) => Promise<T>) => {
    const at = cancels;
    const taken = taking.then(() => take(at !== cancels));
    taking = taken.catch(() => {});
    return taken;
  };
  const say = (next: Status) => {
    latest = next;
    out.status(next);
  };

  /** A turn's status, while it is still the turn: a cancelled one has already said idle. */
  const status = (current: Turn, next: Status) => {
    if (turn === current) say(next);
  };
  /** Run a turn on the record as it stands; its progress is said through `out`. */
  const begin = (current: Turn) => {
    current.ended = placed(current)
      .catch((error: unknown) => {
        if (current.cancelled) return;
        log.error("A turn failed.", { error: String(error) });
        // Every thread it took a message in, and the one it was answering in, is told.
        const detail = codeOf(error);
        for (const thread of new Set([...current.took, current.thread ?? record.id]))
          out.failed(thread, detail);
        status(current, { state: "error", detail });
      })
      .finally(() => {
        current.place?.leave();
        if (turn === current) turn = undefined;
      })
      .catch((error: unknown) => log.error("A turn's status failed.", { error: String(error) }));
    lastEnded = current.ended;
  };
  const show = ({ entry, thread }: Awaited<ReturnType<LoopRecord["append"]>>) =>
    out.message(thread, messageOf(entry));
  /** A call starting: shown as running, under the id its record will have when it ends. */
  const running = (call: FunctionCall, id: string, thread: string) =>
    out.message(thread, {
      id,
      role: "tool",
      text: `${call.name}: running`,
      at: new Date().toISOString(),
      tool: { name: head(call.name, 128), state: "running", input: argumentsOf(call.arguments) },
    });
  /**
   * Record a function call with its output, keeping every call paired, as the API needs. Its end
   * is shown even if the record can't be written, so no call is left shown as running.
   */
  const answered = async (
    call: FunctionCall,
    result: { output: string; ok: boolean; code?: string },
    id: string,
    read: number,
    thread: string,
  ) => {
    const entry = {
      role: "tool" as const,
      text: `${call.name}: ${result.ok ? "done" : result.code}`,
      state: result.ok ? ("done" as const) : ("refused" as const),
      items: [
        call,
        {
          type: "function_call_output" as const,
          callId: call.callId,
          output: capped(result.output),
        },
      ],
    };
    try {
      show(await record.append(entry, { thread, id, read }));
    } catch (error) {
      out.message(
        thread,
        messageOf({
          ...entry,
          id,
          at: new Date().toISOString(),
          items: [{ ...call, arguments: argumentsOf(call.arguments) }, ...entry.items.slice(1)],
        }),
      );
      throw error;
    }
  };
  /**
   * Note calls that won't run, in one message however many there are. They never ran, so the
   * record leaves them out: what the model is sent next holds only calls with their outputs.
   */
  const skipped = async (calls: FunctionCall[], code: string, thread: string) => {
    if (calls.length === 0) return;
    const text =
      calls.length === 1 ? `${calls[0]?.name}: ${code}` : `${calls.length} calls: ${code}`;
    show(await record.append({ role: "tool", text, items: [] }, { thread }));
  };

  async function run(current: Turn) {
    let calls = 0;
    for (;;) {
      const { instructions, tools, model: chosen } = await options.request();
      const { items: input, read, thread } = await record.input();
      if (current.cancelled) return;
      current.thread = thread;
      const requestId = crypto.randomUUID();
      const replyId = crypto.randomUUID();
      current.requestId = requestId;
      current.replyId = replyId;
      let output: Awaited<ReturnType<typeof model.respond>>["output"];
      try {
        ({ output } = await model.respond({
          requestId,
          ...(chosen ? { model: chosen } : {}),
          instructions,
          input,
          tools: tools.map(({ run: _, ...tool }) => tool),
        }));
      } finally {
        current.requestId = undefined;
      }
      if (current.cancelled) return;
      const texts = output.flatMap((item) => (item.type === "message" ? [item.content] : []));
      const called = output.filter((item): item is FunctionCall => item.type === "function_call");
      if (texts.length > 0 || called.length === 0)
        show(
          await record.append(
            {
              role: "assistant",
              items: texts.map((content) => ({ type: "message", role: "assistant", content })),
            },
            { thread, id: replyId, read },
          ),
        );
      if (called.length === 0) {
        if (current.cancelled) return;
        // The turn's end is taken in order with what was asked, so a message being recorded now
        // is recorded first. One said since this request read the record is answered before the
        // turn ends. With none the turn is over at once: the next message taken starts another.
        current.ending = true;
        const over = await inOrder(async () => {
          const more = await record.saidAfter(read);
          if (current.cancelled) return true;
          if (more) return false;
          current.place?.leave();
          status(current, { state: "idle" });
          turn = undefined;
          return true;
        });
        current.ending = false;
        if (over) return;
        continue;
      }
      for (const [i, call] of called.entries()) {
        if (current.cancelled || calls >= MAX_CALLS) {
          const rest = called.slice(i);
          await skipped(rest, current.cancelled ? "cancelled" : "limit", thread);
          break;
        }
        calls++;
        status(current, { state: "tool" });
        // A call that has started runs to its end, and its real result is kept: it may have
        // taken effect.
        const id = crypto.randomUUID();
        running(call, id, thread);
        const result = await runTool(tools, call.name, call.arguments);
        await answered(call, result, id, read, thread);
      }
      if (current.cancelled) return;
      if (calls >= MAX_CALLS)
        throw new Refusal("limit", `This turn stopped after ${MAX_CALLS} tool calls.`);
      status(current, { state: "thinking" });
    }
  }
  /** A turn from its place to its end: it waits for the place already shown as thinking. */
  async function placed(current: Turn) {
    status(current, { state: "thinking" });
    await current.place?.entered;
    current.waiting = false;
    if (current.cancelled) return;
    // Where it answers until a request says: so a failure before one names its thread.
    current.thread = await record.where();
    await run(current);
  }
  /**
   * Take a turn's place, or its turn in the line for one, before anything of it is kept. A turn
   * cancelled already takes none: it runs nothing.
   */
  const enter = (current: Turn, begun: boolean) => {
    if (current.cancelled) return;
    current.place = options.enter(begun);
    current.waiting = true;
  };

  const said = async (text: string, thread: string, joined: boolean) => {
    const kept = await record.append(
      { ...userEntry(text), ...(joined ? { joined: true as const } : {}) },
      { thread },
    );
    show(kept);
    return { messageId: kept.entry.id };
  };
  /**
   * Start a turn: `open` takes its place and keeps what opens it, then its loop runs. When `open`
   * gives nothing, no turn starts. A turn `cancelled` before it started keeps what opens it and
   * runs nothing.
   */
  const start = async <T>(
    cancelled: boolean,
    open: (current: Turn) => Promise<{ opened: T } | undefined>,
  ) => {
    const current: Turn = { cancelled, took: new Set() };
    if (!cancelled) turn = current;
    began = true;
    try {
      // A cancelled turn's last call lands in the record before anything new does.
      await draining;
      draining = undefined;
      const begun = await open(current);
      if (begun) begin(current);
      else if (turn === current) turn = undefined;
      return begun?.opened;
    } catch (error) {
      current.place?.leave();
      if (turn === current) turn = undefined;
      throw error;
    }
  };

  return {
    /**
     * Say a message in a thread the work follows. With no turn it starts one, whose progress is
     * said through `out`. In a turn, running or waiting for its place, it is recorded and said at
     * once, and the turn takes it at its next model request.
     */
    send: (text: string, thread: string) =>
      inOrder(async (cancelled) => {
        if (turn) {
          turn.took.add(thread);
          return said(text, thread, true);
        }
        return (await start(cancelled, async (current) => {
          enter(current, await record.begun());
          current.took.add(thread);
          return { opened: await said(text, thread, false) };
        })) as { messageId: string };
      }),
    /**
     * Take the messages waiting in `thread`, which the work has come to follow, as its own, and
     * answer them: in the turn running, or in one this starts. With none waiting no turn starts.
     * When a cancel came first nothing is taken, and it says so with `false`.
     */
    adopt: (thread: string) =>
      inOrder(async (cancelled) => {
        if (cancelled) return false;
        if (turn) {
          turn.took.add(thread);
          await record.adopt(thread, true);
          return true;
        }
        await start(false, async (current) => {
          enter(current, await record.begun());
          current.took.add(thread);
          if ((await record.adopt(thread, false)) > 0) return { opened: undefined };
          current.place?.leave();
          return undefined;
        });
        return true;
      }),
    /**
     * Go on with a turn that was cut off before it ended, as by a restart: the thread it was
     * answering in shows one line saying so, and the model is told once to check what is already
     * done. Nothing goes on in work with nothing kept, in work that has had a turn since the loop
     * was made, or when a cancel comes first.
     */
    resume: () =>
      inOrder(async (cancelled) => {
        if (began || cancelled) return;
        await start(false, async (current) => {
          if ((await record.empty()) || current.cancelled) return undefined;
          enter(current, true);
          current.resumed = true;
          // In the thread of the message it was answering.
          const thread = await record.where();
          current.took.add(thread);
          show(
            await record.append(
              {
                role: "tool",
                text: CUT_OFF.shown,
                items: [{ type: "message", role: "user", content: CUT_OFF.told }],
              },
              { thread },
            ),
          );
          return { opened: undefined };
        });
      }),
    /** Whether the turn running now goes on from one that was cut off. */
    resumed: () => turn?.resumed === true,
    /** The status now. */
    state: () => latest,
    /**
     * Stop the turn now: its model request is cancelled, no further call starts, and a new turn
     * may begin at once. A call already running finishes, and its result is kept. A turn waiting
     * for its place never starts.
     */
    async cancel() {
      // Counted with no turn too: a message asked but not yet taken starts none after this.
      cancels++;
      const current = turn;
      if (!current) return;
      current.cancelled = true;
      turn = undefined;
      // A turn that will write nothing more gives its place back now: one still waiting for it,
      // one the model is answering, or one waiting for its end. Any other keeps its place until it
      // has written what it will, and what comes next waits for that: the reply it is storing,
      // or the result of its running call.
      const quiet = current.requestId !== undefined || current.ending === true;
      if (current.waiting || quiet) current.place?.leave();
      if (!quiet) draining = current.ended ?? draining;
      say({ state: "idle" });
      if (current.requestId) await model.cancel({ requestId: current.requestId }).catch(() => {});
    },
    /** Settles when the latest turn has written all it will. */
    settled: async () => {
      await lastEnded;
    },
    /** Settles when a stopped turn's running call has ended: at once, if none is running. */
    drained: async () => {
      await draining;
    },
    /** Streamed text of the model request running now, for the reply it becomes. */
    delta(requestId: string, text: string) {
      if (turn?.requestId === requestId && turn.replyId)
        out.delta(turn.thread ?? record.id, turn.replyId, text);
    },
  };
}
