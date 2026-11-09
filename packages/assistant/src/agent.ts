/**
 * The agent loop: a turn sends the conversation and the tools to the model, runs each function the
 * model calls through its slot, and sends the results back, until the model answers without
 * calling anything, or the turn has made its 20 calls.
 */
import type { ChatMessage, llmSession } from "@agentorg/interfaces";
import { type Log, Refused, type Slot } from "@agentorg/sdk";
import type { z } from "zod";
import { argumentsOf, type History, head, messageOf, type ResponseItem } from "./history.js";
import { capped, codeOf, runTool, type Tools } from "./tools.js";

export const MAX_CALLS = 20;

type Status =
  | { state: "idle" | "thinking" | "tool" }
  | { state: "error"; detail: { code: string; message: string } };
type FunctionCall = Extract<ResponseItem, { type: "function_call" }>;
export interface Chat {
  message(message: z.input<typeof ChatMessage>): void;
  delta(id: string, text: string): void;
  status(status: Status): void;
}
interface Turn {
  cancelled: boolean;
  /** The model request running now. */
  requestId?: string | undefined;
  /** The chat id of the reply that request becomes, which its streamed text carries. */
  replyId?: string | undefined;
  /** Settles when the turn's loop has ended. */
  ended?: Promise<void>;
}

export function createAgent(options: {
  /** Read for each model request: what it's told and what it can call follow what it's bound to. */
  request(): Promise<{ instructions: string; tools: Tools }>;
  model: Slot<typeof llmSession>;
  /** The model chosen for this agent, read for each request; none means the provider's default. */
  chosenModel(): Promise<string | undefined>;
  history: History;
  chat: Chat;
  log: Log;
}) {
  const { model, history, chat, log } = options;
  let turn: Turn | undefined;
  /** A cancelled turn whose running call hasn't settled: the next turn waits for its records. */
  let draining: Promise<void> | undefined;
  /** The latest status, for a view that asks. */
  let latest: Status = { state: "idle" };
  const say = (next: Status) => {
    latest = next;
    chat.status(next);
  };

  /** A turn's status, while it is still the turn: a cancelled one has already said idle. */
  const status = (current: Turn, next: Status) => {
    if (turn === current) say(next);
  };
  /** Run a turn on the record as it stands; its progress arrives as events. */
  const begin = (current: Turn) => {
    current.ended = run(current)
      .then(
        () => status(current, { state: "idle" }),
        (error: unknown) => {
          if (current.cancelled) return;
          log.error("A turn failed.", { error: String(error) });
          status(current, { state: "error", detail: codeOf(error) });
        },
      )
      .finally(() => {
        if (turn === current) turn = undefined;
      })
      .catch((error: unknown) => log.error("A turn's status failed.", { error: String(error) }));
  };
  const show = (entry: Awaited<ReturnType<History["append"]>>) => chat.message(messageOf(entry));
  /** A call starting: shown as running, under the id its record will have when it ends. */
  const running = (call: FunctionCall, id: string) =>
    chat.message({
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
      show(await history.append(entry, id));
    } catch (error) {
      chat.message(
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
    show(await history.append({ role: "tool", text, items: [] }));
  };

  async function run(current: Turn) {
    let calls = 0;
    for (;;) {
      status(current, { state: "thinking" });
      const { instructions, tools } = await options.request();
      const input = await history.input();
      const chosen = await options.chosenModel();
      if (current.cancelled) return;
      const requestId = crypto.randomUUID();
      const replyId = crypto.randomUUID();
      current.requestId = requestId;
      current.replyId = replyId;
      let output: Awaited<ReturnType<typeof model.call.respond>>["output"];
      try {
        ({ output } = await model.call.respond({
          requestId,
          ...(chosen ? { model: chosen } : {}),
          instructions,
          input,
          tools: [...tools.values()].map((found) => found.tool),
        }));
      } finally {
        current.requestId = undefined;
      }
      if (current.cancelled) return;
      const texts = output.flatMap((item) => (item.type === "message" ? [item.content] : []));
      const called = output.filter((item): item is FunctionCall => item.type === "function_call");
      if (texts.length > 0 || called.length === 0)
        show(
          await history.append(
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
        throw new Refused("limit", `This turn stopped after ${MAX_CALLS} tool calls.`);
    }
  }

  return {
    /** Start a turn with the person's message; its progress arrives as events. */
    async send(text: string) {
      if (turn) throw new Refused("busy", "A turn is running. Wait for it, or cancel it.");
      const current: Turn = { cancelled: false };
      turn = current;
      try {
        // A cancelled turn's last call lands in the record before this message does.
        await draining;
        draining = undefined;
        const entry = await history.append({
          role: "user",
          items: [{ type: "message", role: "user", content: text }],
        });
        show(entry);
        begin(current);
        return { messageId: entry.id };
      } catch (error) {
        if (turn === current) turn = undefined;
        throw error;
      }
    },
    /**
     * Run the last turn again, without recording the person's message again. What followed it goes
     * from the record, so the new reply takes its place; what its tools did stays done.
     */
    async retry() {
      if (turn) throw new Refused("busy", "A turn is running. Wait for it, or cancel it.");
      const current: Turn = { cancelled: false };
      turn = current;
      try {
        await draining;
        draining = undefined;
        const last = await history.lastUser();
        if (!last) throw new Refused("nothing_to_retry", "No message has been sent yet.");
        await history.dropAfter(last.id);
        begin(current);
        return { messageId: last.id };
      } catch (error) {
        if (turn === current) turn = undefined;
        throw error;
      }
    },
    /** The status now. */
    state: () => latest,
    /**
     * Stop the turn now: its model request is cancelled, no further call starts, and a new turn
     * may begin at once. A call already running finishes, and its result is kept.
     */
    async cancel() {
      const current = turn;
      if (!current) return;
      current.cancelled = true;
      turn = undefined;
      // In a model call, nothing more is recorded; in a tool call, its result still is.
      if (!current.requestId) draining = current.ended;
      say({ state: "idle" });
      if (current.requestId && model.bound)
        await model.call.cancel({ requestId: current.requestId }).catch(() => {});
    },
    /** Streamed text of the model request running now, for the reply it becomes. */
    delta(requestId: string, text: string) {
      if (turn?.requestId === requestId && turn.replyId) chat.delta(turn.replyId, text);
    },
  };
}
