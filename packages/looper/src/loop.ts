/**
 * A loop: a turn sends its record and the tools to the model, runs each function the model calls,
 * and sends the results back, until the model answers without calling anything, or the turn has
 * made its `MAX_CALLS` calls.
 */
import { argumentsOf, head, type LoopRecord, messageOf } from "./record.js";
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

type FunctionCall = Extract<Item, { type: "function_call" }>;
/** Where a loop says what it does. */
export interface LoopOut {
  message(message: Shown): void;
  /** Text of the reply `id` as the model writes it. */
  delta(id: string, text: string): void;
  status(status: Status): void;
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
  let ending: Promise<void> | undefined;
  /** The latest status, for a view that asks. */
  let latest: Status = { state: "idle" };
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
      .then(
        () => status(current, { state: "idle" }),
        (error: unknown) => {
          if (current.cancelled) return;
          log.error("A turn failed.", { error: String(error) });
          status(current, { state: "error", detail: codeOf(error) });
        },
      )
      .finally(() => {
        current.place?.leave();
        if (turn === current) turn = undefined;
      })
      .catch((error: unknown) => log.error("A turn's status failed.", { error: String(error) }));
    ending = current.ended;
  };
  const show = (entry: Awaited<ReturnType<LoopRecord["append"]>>) => out.message(messageOf(entry));
  /** A call starting: shown as running, under the id its record will have when it ends. */
  const running = (call: FunctionCall, id: string) =>
    out.message({
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
      show(await record.append(entry, id));
    } catch (error) {
      out.message(
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
  const skipped = async (calls: FunctionCall[], code: string) => {
    if (calls.length === 0) return;
    const text =
      calls.length === 1 ? `${calls[0]?.name}: ${code}` : `${calls.length} calls: ${code}`;
    show(await record.append({ role: "tool", text, items: [] }));
  };

  async function run(current: Turn) {
    let calls = 0;
    for (;;) {
      const { instructions, tools, model: chosen } = await options.request();
      const input = await record.input();
      if (current.cancelled) return;
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
            replyId,
          ),
        );
      if (called.length === 0) return;
      for (const [i, call] of called.entries()) {
        if (current.cancelled || calls >= MAX_CALLS) {
          const rest = called.slice(i);
          await skipped(rest, current.cancelled ? "cancelled" : "limit");
          break;
        }
        calls++;
        status(current, { state: "tool" });
        // A call that has started runs to its end, and its real result is kept: it may have
        // taken effect.
        const id = crypto.randomUUID();
        running(call, id);
        const result = await runTool(tools, call.name, call.arguments);
        await answered(call, result, id);
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
    if (!current.cancelled) await run(current);
  }
  /** Take a turn's place, or its turn in the line for one, before anything of it is kept. */
  const enter = (current: Turn, begun: boolean) => {
    current.place = options.enter(begun);
    current.waiting = true;
  };

  return {
    /** Start a turn with a message; its progress is said through `out`. */
    async send(text: string) {
      if (turn) throw new Refusal("busy", "A turn is running. Wait for it, or cancel it.");
      const current: Turn = { cancelled: false };
      turn = current;
      try {
        // A cancelled turn's last call lands in the record before this message does.
        await draining;
        draining = undefined;
        enter(current, !(await record.empty()));
        const entry = await record.append({
          role: "user",
          items: [{ type: "message", role: "user", content: text }],
        });
        show(entry);
        begin(current);
        return { messageId: entry.id };
      } catch (error) {
        current.place?.leave();
        if (turn === current) turn = undefined;
        throw error;
      }
    },
    /**
     * Run the last turn again, without recording its message again. What followed it goes
     * from the record, so the new reply takes its place; what its tools did stays done.
     */
    async retry() {
      if (turn) throw new Refusal("busy", "A turn is running. Wait for it, or cancel it.");
      const current: Turn = { cancelled: false };
      turn = current;
      try {
        await draining;
        draining = undefined;
        const last = await record.lastUser();
        if (!last) throw new Refusal("nothing_to_retry", "No message has been sent yet.");
        enter(current, true);
        // Cancelled already, it runs nothing, so what followed the message stays.
        if (!current.cancelled) await record.dropAfter(last.id);
        begin(current);
        return { messageId: last.id };
      } catch (error) {
        current.place?.leave();
        if (turn === current) turn = undefined;
        throw error;
      }
    },
    /** The status now. */
    state: () => latest,
    /**
     * Stop the turn now: its model request is cancelled, no further call starts, and a new turn
     * may begin at once. A call already running finishes, and its result is kept. A turn waiting
     * for its place never starts.
     */
    async cancel() {
      const current = turn;
      if (!current) return;
      current.cancelled = true;
      turn = undefined;
      // A turn that will write nothing more gives its place back now: one still waiting for it, or
      // one the model is answering. One in a call keeps its place until the call ends.
      if (current.waiting || current.requestId) current.place?.leave();
      // In a model call, nothing more is recorded; in a tool call, its result still is.
      // A turn that hadn't begun leaves what was already running to be waited for.
      if (!current.requestId) draining = current.ended ?? draining;
      say({ state: "idle" });
      if (current.requestId) await model.cancel({ requestId: current.requestId }).catch(() => {});
    },
    /** Settles when the latest turn has written all it will. */
    settled: async () => {
      await ending;
    },
    /** Settles when a stopped turn's running call has ended: at once, if none is running. */
    drained: async () => {
      await draining;
    },
    /** Streamed text of the model request running now, for the reply it becomes. */
    delta(requestId: string, text: string) {
      if (turn?.requestId === requestId && turn.replyId) out.delta(turn.replyId, text);
    },
  };
}
