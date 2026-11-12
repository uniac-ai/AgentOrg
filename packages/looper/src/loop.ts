/**
 * A loop: a turn sends its record and the tools to the model, runs each function the model calls,
 * and sends the results back, until a request calls nothing, or the turn has made its
 * `MAX_CALLS` calls. A message said while a turn runs is recorded at once, and the turn
 * takes it at its next model request. A loop is one piece of work's: its messages come in the
 * threads the work follows, and what comes of a request is kept in the thread of the newest
 * message that request read and the work has not handed back. Its worker is told which work this
 * is and reads each of the person's messages by a number. It has two functions beside its tools:
 * `send`, the only way anything it says reaches the person, which answers a message, and
 * `hand_back`, which says a message is not this work's. What it writes without sending, and what
 * its calls did, are kept for the work and said in no thread.
 */
import {
  HAND_BACK_NAME,
  head,
  type LoopRecord,
  messageOf,
  PICTURES_BUDGET,
  SEND_NAME,
  SENT,
  userEntry,
  type WorkEntry,
} from "./record.js";
import { capped, refused, runTool } from "./tools.js";
import {
  type Call,
  codeOf,
  type Item,
  type Log,
  type Model,
  type Outcome,
  type Picture,
  Refusal,
  type Shown,
  type Status,
  type Tool,
  type ToolSpec,
} from "./types.js";

/** What a message's thread is told when its work's turn ended without a reply to it. */
const NOT_ANSWERED = { code: "not_answered", message: "Not answered" };
/** A brake on a turn, not a budget: nothing approves a call, and the person can stop it. */
export const MAX_CALLS = 200;
/** What its work keeps, and its model is told, when a turn that was cut off goes on. */
const CUT_OFF = {
  kept: "Cut off by a restart: going on from where it stopped.",
  told: "This turn was cut off by a restart. Check what is already done before you repeat anything, then go on.",
};

/** A function of the looper's own: what a worker says to the person, in reply to a message. */
export const SEND: ToolSpec = {
  name: SEND_NAME,
  description:
    "Says something to the person, in reply to one of their messages, in the conversation it was said in: the only way anything reaches them. It answers that message. You may send more than once, and go on working after.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "number", description: "The number the message starts with." },
      text: { type: "string", description: "What to say, as the person will read it." },
    },
    required: ["message", "text"],
  },
  // What it says streams into the chat as it is written.
  streamed: true,
};
/** A function of the looper's own: it says a message is not this work's. */
export const HAND_BACK: ToolSpec = {
  name: HAND_BACK_NAME,
  description:
    "Says a message from the person is not for this piece of work, so it can be given to other work or start new work. Once per message.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "number", description: "The number the message starts with." },
      why: { type: "string", description: "One sentence: why it is not this work's." },
      leave: {
        type: "boolean",
        description:
          "True when the conversation this message was said in has nothing to do with this work: the work is then given nothing more from it. It changes nothing for the conversation this work began in.",
      },
    },
    required: ["message", "why"],
  },
};
/**
 * What a worker is told after what its host tells it: which work this is, how to answer, and how
 * to hand a message back.
 */
export const workInstructions = (
  title: string,
) => `This is one piece of work: ${title}. Other pieces of work may be going on beside it, each with a worker of its own, and a message from the person may reach several of them at once.

Each message from the person starts with its number in brackets, like [12]. Decide each one once. If it asks for something that belongs to this work, do it and answer it by calling \`send\` with its number: only what you send reaches the person. What you write without sending is seen by no one but you, in your later requests. You may send while the work goes on, and more than once. If it asks for something that does not belong to this work, call \`hand_back\` with its number and one sentence why, and send nothing about it: it is then given to other work, or starts new work. A message that asks for nothing, like thanks, still gets a short answer. A message you neither answer nor hand back is shown to the person as not answered when you are done. When you have nothing more to do, end without calling anything.

A message that begins "(Left out:" is not from the person and needs no answer. It stands for earlier messages, and what was done for them, that no longer fit: all of it was said and done, so do not do it again. A call whose arguments or output say they were left out did run. Message [1] is what this work was asked.`;

type FunctionCall = Extract<Item, { type: "function_call" }>;
/**
 * A `send` the model is writing: its arguments so far, the id its reply will have, where in them
 * the words not yet said begin, and the thread of the message it names: unknown until that is
 * read, `null` while it is looked up, and again when it names none this work can answer.
 */
interface Stream {
  reply: string;
  args: string;
  at?: number;
  thread?: string | null;
}
/** Whole characters and escapes of a JSON string, as far as they go: the words of a `send` read so far. */
const WORDS = /(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/y;
/** Where a loop says what it does, each message with the thread it is said in. */
export interface LoopOut {
  /** A message said in `thread`: what the person said, or a reply sent there. */
  message(thread: string, message: Shown): void;
  /** A piece of a reply as it is sent: `id` is the reply's, which its message has once it is said. */
  delta(thread: string, id: string, text: string): void;
  /** What its work did changed: a call began, or something was kept for it. */
  worked(): void;
  /** What it is doing. */
  status(status: Status): void;
  /**
   * A message in `thread` got no answer, and why: said before the `error` status, or as a turn
   * ends without a reply to it.
   */
  failed(thread: string, problem: { code: string; message: string }): void;
}
interface Turn {
  /** Its number among the starts of this loop: what names it to whoever stops it. */
  id: number;
  cancelled: boolean;
  /** Whether what cancelled it was the loop closing: it stays to be gone on with. */
  closed?: boolean;
  /** The model request running now. */
  requestId?: string | undefined;
  /** Settles when the turn's loop has ended. */
  ended?: Promise<void>;
  /** Its place among the turns running, or in the line for one. */
  place?: Place;
  /** Set until it runs: it has that place, and no stopped turn before it is still writing. */
  waiting?: boolean;
  /** Set while it waits for its end to be taken: it writes nothing meanwhile. */
  ending?: boolean;
  /** Set on a turn that goes on from one that was cut off. */
  resumed?: boolean;
  /** What the `send`s its latest request is writing have said so far, by call. */
  streams?: Map<string, Stream>;
  /**
   * The place it started after: a message of its work up to there is an earlier turn's, which a
   * stop or a failure left unanswered. One that opens with what its work held starts after the
   * last thing its work did.
   */
  from?: number;
  /**
   * Set once it has written or sent something, or run a call of its tools: it is at something of
   * its own.
   */
  acted?: boolean;
  /** The thread it answers in now: that of the newest message its latest request read. */
  thread?: string;
  /** The threads it has taken a message in: each is told if it fails. */
  took: Set<string>;
  /** The word its calls are made under, which a stop of it names. */
  group: string;
  /** Its calls whose pictures are kept, oldest first, each with what its pictures carry. */
  pictured: { id: string; size: number }[];
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
  /** The work's title, for its worker to know which work this is. */
  title(): Promise<string>;
  /**
   * A turn is about to start, after the place `after`, the highest its work holds: settles once
   * that is kept, before anything of the turn is, so whoever goes on after a host that went in
   * between can tell whether a message of the turn was kept. Without `after`, the turn starts
   * with what was kept before it. `unstarted` takes it back when no turn began, or, `stopped`,
   * when the turn was stopped while it started.
   */
  starting(after?: number): Promise<void>;
  unstarted(stopped: boolean): void;
  /**
   * A turn was stopped, not closed: end what its calls left running, by the group they were made
   * under (see `Tool.run`).
   */
  stopGroup?(group: string): Promise<unknown>;
  /**
   * The worker hands the message at `message` back, with why; with `leave`, it stops following
   * the thread it was said in too. It gives what the worker is told of it.
   */
  back(handed: { message: number; why: string; leave: boolean }): Promise<string>;
  out: LoopOut;
  log: Log;
}) {
  const { model, record, out, log } = options;
  const handBack: Tool = {
    ...HAND_BACK,
    async run(input) {
      const { message, why, leave } = (input ?? {}) as Record<string, unknown>;
      if (typeof message !== "number" || typeof why !== "string" || why.trim() === "")
        throw new Refusal("invalid", "Give the message's number and one sentence why.");
      return {
        output: await options.back({ message, why: head(why, 2000), leave: leave === true }),
        ok: true,
      };
    },
  };
  let turn: Turn | undefined;
  /**
   * A stopped turn that had begun to run and hasn't ended: it may still write the result of its
   * running call, or the reply it was keeping. What is kept meanwhile is kept as joined, so the
   * model reads it after that; and the next turn reads the record once it has ended.
   */
  let draining: Promise<void> | undefined;
  /**
   * That turn's place, the loop's while it still writes. A turn started meanwhile asks for none:
   * when the stopped turn has ended, its place goes to that turn, or is given back.
   */
  let lingering: Place | undefined;
  /** Settles when the latest turn's loop has ended. */
  let lastEnded: Promise<void> | undefined;
  /** The latest status, for a view that asks. */
  let latest: Status = { state: "idle" };
  /** The starts made here: each turn's number. */
  let turns = 0;
  /** Whether the latest turn to end was cut by a stop. */
  let stoppedLast = false;
  /**
   * The call of its tools running now, until what came of it is kept: a turn's, also once a stop
   * has cut that turn and the call still runs.
   */
  let calling: WorkEntry | undefined;
  /** The turns that began here. After the first, nothing cut off earlier is gone on with. */
  let turnsBegun = 0;
  /** Counts the cancels, so that what was asked before one can tell when it is taken after it. */
  let cancels = 0;
  /** Counts those that were stops, not the loop closing: what a stop cut is not gone on with. */
  let stops = 0;
  /** What is being taken now: the next thing asked is taken after it. */
  let taking: Promise<unknown> = Promise.resolve();
  /**
   * Take what was asked in the order it was asked, one at a time: a message, going on, a turn's
   * end. `cancelled` says whether a cancel came between its asking and its taking, and `closed`
   * whether that was the loop closing and no stop.
   */
  const inOrder = <T>(take: (cancelled: boolean, closed: boolean) => Promise<T>) => {
    const at = cancels;
    const stopped = stops;
    const taken = taking.then(() => take(at !== cancels, at !== cancels && stopped === stops));
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
    turnsBegun++;
    stoppedLast = false;
    current.ended = placed(current)
      .catch((error: unknown) => {
        if (current.cancelled) return;
        // The log has the words the chat is given, so a model's failure has its reason there too.
        const detail = codeOf(error);
        log.error(`A turn failed: ${detail.message}`, { error: String(error) });
        // Every thread it took a message in, and the one it was answering in, is told.
        for (const thread of new Set([
          ...current.took,
          ...(current.thread ? [current.thread] : []),
        ]))
          out.failed(thread, detail);
        status(current, { state: "error", detail });
      })
      // However it ended, what its calls gave goes before its place does; a turn the loop's
      // closing cut is gone on with, and keeps them. A message said meanwhile starts another turn.
      .then(() => {
        if (turn === current) turn = undefined;
        return current.closed ? undefined : unpicture(current, 0);
      })
      .finally(() => {
        current.place?.leave();
        if (turn === current) turn = undefined;
      })
      .catch((error: unknown) => log.error("A turn's status failed.", { error: String(error) }));
    lastEnded = current.ended;
  };
  /**
   * Keep the pictures of a turn's newest calls that fit `room` together, and leave out the rest:
   * a request gives no more, and none once the turn is over.
   */
  const unpicture = async (current: Turn, room: number) => {
    let left = room;
    const gone = new Set<string>();
    for (const { id, size } of [...current.pictured].reverse())
      if (size <= left) left -= size;
      else gone.add(id);
    if (gone.size === 0) return;
    try {
      await record.unpicture([...gone]);
      current.pictured = current.pictured.filter(({ id }) => !gone.has(id));
    } catch (error) {
      // Tried again at its next call or its end.
      log.warn("A call's pictures couldn't be left out.", { error: String(error) });
    }
  };
  const show = ({ entry, thread }: Awaited<ReturnType<LoopRecord["append"]>>) =>
    out.message(thread, messageOf(entry));
  /**
   * A `send`: what it sends is said in the thread of the message it answers, and kept there as
   * the call and its output, which is all the model reads of it. One that names no message of
   * this work's to answer, or says nothing, is refused to the model; one the store refuses fails
   * the turn, as any reply would.
   */
  const sending = async (call: FunctionCall, id: string, read: number, thread: string) => {
    const refuse = (message: string) =>
      answered(call, refused("invalid", message), id, read, thread);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {}
    const { message, text } = (args ?? {}) as Record<string, unknown>;
    if (typeof message !== "number" || typeof text !== "string" || text.trim() === "")
      return refuse("Give the message's number and what to say.");
    const output = { type: "function_call_output" as const, callId: call.callId, output: SENT };
    const sent = await record.reply(message, [call, output], { id, read });
    if (!sent)
      return refuse(
        `There is no message [${message}] of this work to answer: check its number, and that it wasn't handed back.`,
      );
    show(sent);
  };
  /**
   * Say what a `send` being written has said and hasn't been said yet, once the thread of the
   * message it names is known. Until it names one, what it says waits; when it names one this
   * work can't answer, nothing of it is said.
   */
  const flow = (stream: Stream) => {
    if (stream.thread === undefined) {
      const message = /"message"\s*:\s*(\d+)\s*[,}]/.exec(stream.args)?.[1];
      if (message === undefined) return;
      stream.thread = null;
      void record.replyThread(Number(message)).then(
        (thread) => {
          stream.thread = thread ?? null;
          flow(stream);
        },
        () => {},
      );
      return;
    }
    if (!stream.thread) return;
    if (stream.at === undefined) {
      const begins = /"text"\s*:\s*"/.exec(stream.args);
      if (!begins) return;
      stream.at = begins.index + begins[0].length;
    }
    WORDS.lastIndex = stream.at;
    const read = WORDS.exec(stream.args)?.[0] ?? "";
    if (read === "") return;
    stream.at += read.length;
    let words: string;
    try {
      words = JSON.parse(`"${read}"`) as string;
    } catch {
      // Not JSON's words, as with a control character in them: nothing more of it is said.
      stream.thread = null;
      return;
    }
    out.delta(stream.thread, stream.reply, words);
  };
  /** Record a function call with its output, keeping every call paired, as the API needs. */
  const answered = async (
    call: FunctionCall,
    result: Outcome,
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
          ...(result.images?.length ? { images: result.images } : {}),
        },
      ],
    };
    await record.append(entry, { thread, id, read });
  };
  /**
   * Note calls that won't run, in one message however many there are. They never ran, so the
   * record leaves them out: what the model is sent next holds only calls with their outputs.
   */
  const skipped = async (calls: FunctionCall[], code: string, thread: string) => {
    if (calls.length === 0) return;
    const text =
      calls.length === 1 ? `${calls[0]?.name}: ${code}` : `${calls.length} calls: ${code}`;
    await record.append({ role: "tool", text, items: [] }, { thread });
    out.worked();
  };

  async function run(current: Turn) {
    let calls = 0;
    for (;;) {
      const { instructions, tools: theirs, model: chosen } = await options.request();
      const tools = [...theirs, handBack];
      const told = workInstructions(await options.title());
      const offered = {
        instructions: instructions ? `${instructions}\n\n${told}` : told,
        tools: [...theirs.map(({ run: _, ...tool }) => tool), SEND, HAND_BACK],
      };
      const { items: input, read, thread } = await record.input(offered);
      if (current.cancelled) return;
      current.thread = thread;
      const requestId = crypto.randomUUID();
      current.requestId = requestId;
      current.streams = new Map();
      let output: Awaited<ReturnType<typeof model.respond>>["output"];
      try {
        ({ output } = await model.respond({
          requestId,
          ...(chosen ? { model: chosen } : {}),
          ...offered,
          input,
        }));
      } finally {
        current.requestId = undefined;
      }
      if (current.cancelled) return;
      const texts = output.flatMap((item) => (item.type === "message" ? [item.content] : []));
      const called = output.filter((item): item is FunctionCall => item.type === "function_call");
      // What it wrote without sending is kept for the work, and said to nobody.
      if (texts.some((text) => text.trim() !== "")) {
        current.acted = true;
        await record.append(
          {
            role: "assistant",
            unsent: true,
            items: texts.map((content) => ({ type: "message", role: "assistant", content })),
          },
          { thread, read },
        );
        out.worked();
      }
      /**
       * The turn's end, taken in order with what was asked, so a message being recorded now is
       * recorded first. One said since this request read the record is answered before the turn
       * ends. With none the turn is over at once: the next message taken starts another.
       */
      const ends = async () => {
        current.ending = true;
        const over = await inOrder(async () => {
          const more = await record.saidAfter(read);
          if (current.cancelled) return true;
          if (more) return false;
          // What it took and neither answered nor handed back went unanswered, said before it is
          // idle; unless a stop came meanwhile.
          const unanswered = await record.closeUnanswered(current.from ?? 0, read);
          if (current.cancelled) return true;
          for (const where of unanswered) out.failed(where, NOT_ANSWERED);
          await unpicture(current, 0);
          current.place?.leave();
          status(current, { state: "idle" });
          turn = undefined;
          return true;
        });
        current.ending = false;
        return over;
      };
      if (called.length === 0) {
        if (current.cancelled || (await ends())) return;
        continue;
      }
      /** Whether every call of this request handed a message back. */
      let handedAll = true;
      for (const [i, call] of called.entries()) {
        if (current.cancelled || calls >= MAX_CALLS) {
          const rest = called.slice(i);
          await skipped(rest, current.cancelled ? "cancelled" : "limit", thread);
          break;
        }
        calls++;
        const id = crypto.randomUUID();
        // Sending is the looper's own: what was sent is kept as said, with its call. One that
        // can't be sent is kept for the model, and shown to nobody.
        if (call.name === SEND.name) {
          handedAll = false;
          current.acted = true;
          // A reply that streamed keeps the id its pieces had.
          await sending(call, current.streams?.get(call.callId)?.reply ?? id, read, thread);
          continue;
        }
        // Handing a message back is the looper's own: kept for the model, shown to nobody.
        if (call.name === HAND_BACK.name) {
          const result = await runTool(tools, call.name, call.arguments, current.group);
          handedAll &&= result.ok;
          await answered(call, result, id, read, thread);
          continue;
        }
        handedAll = false;
        current.acted = true;
        status(current, { state: "tool" });
        // A call that has started runs to its end, and its real result is kept: it may have
        // taken effect.
        calling = {
          id,
          at: new Date().toISOString(),
          call: { name: head(call.name, 128), state: "running", input: call.arguments },
        };
        out.worked();
        const result = await runTool(tools, call.name, call.arguments, current.group);
        // A stop asked while this call was on its way may have come before what it started: it is
        // asked again now that the call is back.
        if (current.cancelled && !current.closed)
          void options.stopGroup?.(current.group).catch(() => {});
        try {
          await answered(call, result, id, read, thread);
          const size = (result.images ?? []).reduce((sum, one) => sum + one.data.length, 0);
          if (size > 0) {
            current.pictured.push({ id, size });
            await unpicture(current, PICTURES_BUDGET);
          }
        } finally {
          // Said once it is no longer the call running: what was kept of it is there to read.
          if (calling?.id === id) calling = undefined;
          out.worked();
        }
      }
      if (current.cancelled) return;
      if (calls >= MAX_CALLS)
        throw new Refusal("limit", `This turn stopped after ${MAX_CALLS} tool calls.`);
      // A request that only handed messages back, in a turn that has done nothing else and has
      // nothing else left unanswered, has nothing to go on with: the turn ends there, unless
      // more was said meanwhile.
      if (
        handedAll &&
        !current.acted &&
        !(await record.unanswered(current.from ?? 0)) &&
        (await ends())
      )
        return;
      status(current, { state: "thinking" });
    }
  }
  /**
   * A turn from its place to its end: it waits for the place, and for what a stopped turn before
   * it still writes, already shown as thinking.
   */
  async function placed(current: Turn) {
    status(current, { state: "thinking" });
    await draining;
    await current.place?.entered;
    current.waiting = false;
    if (current.cancelled) return;
    // Where it answers until a request says: so a failure before one names its thread.
    current.thread = await record.where();
    await run(current);
  }
  /**
   * Take a turn's place, or its turn in the line for one, before anything of it is kept. While a
   * stopped turn of this work still writes, the turn takes none: it gets that turn's, so a piece
   * of work holds one place. A turn cancelled already takes none: it runs nothing.
   */
  const enter = (current: Turn, begun: boolean) => {
    if (current.cancelled) return;
    if (!lingering) current.place = options.enter(begun);
    current.waiting = true;
  };

  const said = async (text: string, thread: string, joined: boolean, images?: Picture[]) => {
    const kept = await record.append(
      { ...userEntry(text, images), ...(joined ? { joined: true as const } : {}) },
      { thread },
    );
    show(kept);
    return { messageId: kept.entry.id };
  };
  /**
   * Start a turn: `open` takes its place and keeps what opens it, at once, then its loop runs.
   * When `open` gives nothing, no turn starts. A turn `cancelled` before it started keeps what
   * opens it and runs nothing. A turn that is `fresh`, not one going on from a cut-off, is told
   * of as starting before anything of it is kept, unless a stop cancelled it first: one the
   * loop's closing cut, `closed`, is told of, and stays to be gone on with.
   */
  const start = async <T>(
    cancelled: boolean,
    open: (current: Turn) => Promise<{ opened: T } | undefined>,
    fresh = true,
    closed = false,
  ) => {
    const current: Turn = {
      id: ++turns,
      cancelled,
      closed,
      took: new Set(),
      group: crypto.randomUUID(),
      pictured: [],
    };
    if (!cancelled) turn = current;
    const told = fresh && (!cancelled || closed);
    try {
      const top = told ? await record.top() : 0;
      if (told) await options.starting(top);
      const begun = await open(current);
      // It opens with what its work held already: no message past that place says it started.
      const past = told && begun !== undefined && (await record.after(top));
      if (told && begun && !past) await options.starting();
      // A turn that goes on from a cut-off has said where it started.
      if (told && begun) current.from = past ? top : await record.acted();
      // Stopped while it started, it keeps what opens it and runs nothing: no turn to go on
      // with. Cut by the loop closing, it stays one.
      if (told && current.cancelled && !current.closed) options.unstarted(true);
      if (begun) begin(current);
      else {
        current.place?.leave();
        if (turn === current) turn = undefined;
        if (told) options.unstarted(false);
      }
      return begun?.opened;
    } catch (error) {
      current.place?.leave();
      if (turn === current) turn = undefined;
      if (told) options.unstarted(false);
      throw error;
    }
  };

  return {
    /**
     * Say a message in a thread the work follows. It is recorded and said at once. In a turn,
     * running or waiting for its place, the turn takes it at its next model request: `turn` is
     * then that turn's number. With no turn it starts one, whose progress is said through `out`.
     */
    send: (text: string, thread: string, images?: Picture[]) =>
      inOrder(async (cancelled, closed): Promise<{ messageId: string; turn?: number }> => {
        const into = turn;
        if (into) {
          into.took.add(thread);
          return { ...(await said(text, thread, true, images)), turn: into.id };
        }
        return (await start(
          cancelled,
          async (current) => {
            enter(current, await record.begun());
            current.took.add(thread);
            return { opened: await said(text, thread, draining !== undefined, images) };
          },
          true,
          closed,
        )) as { messageId: string };
      }),
    /**
     * Take the messages waiting in `thread` for this work, as its own, and answer them: in the
     * turn running, whose number it then gives if there were any, or in one this starts. With
     * none waiting no turn starts. When a cancel came first nothing is taken, and it says so
     * with `false`.
     */
    adopt: (thread: string) =>
      inOrder(async (cancelled): Promise<false | { turn?: number }> => {
        if (cancelled) return false;
        const into = turn;
        if (into) {
          into.took.add(thread);
          return (await record.adopt(thread, true)) > 0 ? { turn: into.id } : {};
        }
        await start(false, async (current) => {
          enter(current, await record.begun());
          current.took.add(thread);
          if ((await record.adopt(thread, draining !== undefined)) > 0)
            return { opened: undefined };
          return undefined;
        });
        return {};
      }),
    /**
     * Go on with a turn that was cut off before it ended, as by a restart: its work keeps one
     * line saying so, and the model is told once to check what is already done. `after` is the
     * place the turn was to start after, where that was kept: nothing goes on in work that holds
     * no message said to it past that place, since nothing of the turn was kept; without it, in
     * work that has nothing kept. Nor in work that has had a turn since the loop was made, or
     * when a cancel comes first. A message the store refused began no turn, so it is not one.
     */
    resume: (after?: number) =>
      inOrder(async (cancelled) => {
        if (turnsBegun > 0 || cancelled) return;
        await start(
          false,
          async (current) => {
            // Nothing to go on with: nothing is kept, or nothing of the turn that was cut off.
            const kept = after === undefined ? !(await record.empty()) : await record.after(after);
            if (!kept || current.cancelled) return undefined;
            enter(current, true);
            current.resumed = true;
            current.from = after ?? (await record.acted());
            // What the turn cut off kept of its calls' pictures is this turn's to leave out, and
            // what any turn a restart cut before it kept.
            current.pictured = await record.pictured();
            current.acted = true;
            // Kept for the work in the thread of the message it was answering, and said in none.
            const thread = await record.where();
            current.took.add(thread);
            await record.append(
              {
                role: "tool",
                text: CUT_OFF.kept,
                items: [{ type: "message", role: "user", content: CUT_OFF.told }],
              },
              { thread },
            );
            out.worked();
            return { opened: undefined };
          },
          false,
        );
      }),
    /** Whether the turn running now goes on from one that was cut off. */
    resumed: () => turn?.resumed === true,
    /** The status now. */
    state: () => latest,
    /**
     * A piece of a function call's arguments, as the model writes them for `requestId`: what a
     * `send` of the request running now says streams into the thread of the message it names.
     */
    stream(requestId: string, call: Call, text: string) {
      const streams = turn?.requestId === requestId ? turn.streams : undefined;
      if (!streams || call.name !== SEND_NAME) return;
      let stream = streams.get(call.id);
      if (!stream) {
        stream = { reply: crypto.randomUUID(), args: "" };
        streams.set(call.id, stream);
      }
      stream.args += text;
      flow(stream);
    },
    /** The call of its tools running now, a stopped turn's included, until it is kept. */
    running: () => calling,
    /** Whether the latest turn to end was cut by a stop, not by the loop closing. */
    stopped: () => stoppedLast,
    /** The number of the turn running or waiting for its place, if one is. */
    turn: () => turn?.id,
    /**
     * Stop the turn now, or with `only`, the turn of that number if it is still the one: its
     * model request is cancelled and no further call starts. A call already running finishes,
     * and its result is kept; a new turn may be started at once, and reads the record after
     * that. A turn waiting for its place never starts. It says whether it cut a turn. `line` is
     * what the main loop says as it stops it, kept in that thread in order with what was asked
     * before. A stop asks for what the turn's calls left running to end, without waiting for
     * it. `closing` is for the loop's host going: what it cuts is not stopped, what its calls
     * left running stays, and a turn cut while it was starting stays to be gone on with.
     */
    async cancel(only?: number, line?: { text: string; thread: string }, closing = false) {
      const current = turn;
      if (only !== undefined && current?.id !== only) return false;
      // Counted with no turn too: a message asked but not yet taken starts none after this.
      cancels++;
      if (!closing) stops++;
      if (!current) return false;
      current.cancelled = true;
      current.closed = closing;
      turn = undefined;
      // A turn that will write nothing more gives its place back now: one still waiting for it,
      // one the model is answering, or one waiting for its end. Any other's place is kept until
      // it has written what it will: the reply it is storing, or the result of its running call.
      const quiet = current.requestId !== undefined || current.ending === true;
      if (current.waiting || quiet) current.place?.leave();
      else if (current.ended) {
        const still = current.ended;
        draining = still;
        lingering = current.place;
        current.place = undefined;
        // Once that has ended nothing is being written by a stopped turn any more: its place
        // goes to the turn that waited for this, or back.
        still.finally(() => {
          if (draining !== still) return;
          draining = undefined;
          if (turn?.waiting && !turn.place) turn.place = lingering;
          else lingering?.leave();
          lingering = undefined;
        });
      }
      stoppedLast = !closing;
      say({ state: "idle" });
      if (!closing) void options.stopGroup?.(current.group).catch(() => {});
      await Promise.all([
        current.requestId && model.cancel({ requestId: current.requestId }).catch(() => {}),
        line && inOrder(async () => show(await record.stopLine(line.text, line.thread))),
        // One that writes nothing more has what its calls gave left out now, before the stop is
        // done; any other, once it has written what it will.
        quiet && !closing && unpicture(current, 0),
      ]);
      return true;
    },
    /** Settles when the latest turn has written all it will. */
    settled: async () => {
      await lastEnded;
    },
    /** Settles when a stopped turn has written what it will: at once, if none is writing. */
    drained: async () => {
      await draining;
    },
  };
}
