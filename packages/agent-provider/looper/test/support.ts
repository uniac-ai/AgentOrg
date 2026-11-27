import {
  type Card,
  type CardAnswer,
  type Compacted,
  type Conversed,
  createLooper,
  Entry,
  type FilesOf,
  type Item,
  type Json,
  type OutputItem,
  type Picture,
  Refusal,
  type Summarize,
  type ToCompact,
  type Tool,
  textOf,
} from "../src/index.ts";
import { LAST_ACTIVE } from "../src/main.ts";
import type { Part } from "../src/told.ts";

/** What a stand-in summarizer was given: what to summarize and the host's files; and what it gave. */
export interface Given {
  compacting: ToCompact;
  files: FilesOf | undefined;
  compacted?: Compacted;
}

/**
 * What writes summaries in these tests unless one says otherwise, keeping in `given` what it was
 * given: one request to the work's model, with fixed words, whose answer is the summary, with the
 * files the host names for the calls it summarizes. These tests are of what the loop does with a
 * summary; how one is written is the summary package's.
 */
export const standIn =
  (given: Given[] = []): Summarize =>
  async (ask, compacting, files) => {
    const one: Given = { compacting, files };
    given.push(one);
    const named = [...compacting.history, ...compacting.prefix].flatMap((item) =>
      item.type === "function_call" ? [files?.(item)] : [],
    );
    const read = named.flatMap((paths) => paths?.read ?? []);
    const changed = named.flatMap((paths) => paths?.changed ?? []);
    one.compacted = {
      summary: await ask("Summarize the conversation.", "Summarize the conversation."),
      upTo: compacting.upTo,
      ...(read.length > 0 ? { read } : {}),
      ...(changed.length > 0 ? { changed } : {}),
    };
    return one.compacted;
  };

/**
 * A looper whose model answers a worker's request only when the test says so, naming the request by
 * the last thing said to it. `asked` is what the model has been asked for workers, in order. A
 * worker's request that only follows what it sent, with nothing said since, is answered at once
 * with nothing, as by a model that has said all it had, and is not among `asked`; with
 * `askAfterSend`, it is asked like any other. The main loop's requests are answered at once, with
 * new work, unless `routing` says otherwise; `routed` is what it was put, and `mains` its requests
 * whole.
 */
export function looperWith(
  options: {
    tools?: Tool[];
    /** Functions the main loop is offered beside its own when it decides on a message. */
    frontDesk?: Tool[];
    stopped?: boolean;
    askAfterSend?: boolean;
    /** Asked to end what a stopped turn's calls left running, by their group. */
    stopGroup?: (group: string) => Promise<unknown>;
    /** A model that never hears a cancel: its answer stays out. */
    deaf?: boolean;
    /** Awaited before each write to the store, and before each read or listing from it. */
    writing?: (key: string) => Promise<void> | undefined;
    reading?: (key: string) => Promise<void> | undefined;
    deleting?: (key: string) => Promise<void> | undefined;
    /** The store, to make a looper again on what another kept. */
    values?: Map<string, Json>;
    /** Called as each message is said. */
    saying?: (line: string) => void;
    /** Who the main loop speaks as. */
    voice?: string;
    /** What the main loop answers when put `text`: by default, new work. */
    routing?: (text: string) => OutputItem[] | Promise<OutputItem[]> | undefined;
    /**
     * Whether each thread has a loop of its own, which every message reaches first: the agent
     * alone, asked as a worker is, or one that routes.
     */
    conversations?: "alone" | "routes";
    /**
     * What a conversation's own loop answers, given the last thing said to it and its request
     * whole: by default, it passes its newest message on to new work. A call naming
     * `message: "newest"` names the newest message it was given.
     */
    talking?: (
      text: string,
      request: { instructions: string; input: Item[] },
    ) => OutputItem[] | Promise<OutputItem[]> | undefined;
    /**
     * How the main loop places a message no work in a turn took, given that message and what it
     * is told of which work was last active: by default, it gives it to that work, as a follow-up
     * is.
     */
    idle?: (said: string, text: string) => OutputItem[] | Promise<OutputItem[]> | undefined;
    /** Who a message said in a thread is from, when not the person. */
    speaker?: (thread: string) => string | undefined;
    /**
     * What the model answers a request for a summary, which offers nothing to call: by default a
     * summary that names how many it has given.
     */
    summarizing?: (text: string) => OutputItem[] | Promise<OutputItem[]>;
    /** The files a call read and changed. */
    files?: FilesOf;
    /** What summarizes a work's earlier steps: by default, `standIn`, keeping `given`. */
    summarizer?: () => Summarize | undefined;
    /**
     * What the host tells each request's model, before the looper's own words: as words, as parts,
     * or as what a function gives each time the host is asked.
     */
    instructions?: string | readonly Part[] | (() => string | readonly Part[]);
    /** Told what each request is read for: a conversation's own loop says which conversation. */
    requested?: (conversation?: Conversed) => void;
    /** Run at each model request a loop makes, with its input: what it gives is sent. */
    pass?: (input: Item[], conversation?: Conversed) => Item[];
  } = {},
) {
  const values = options.values ?? new Map<string, Json>();
  const said: string[] = [];
  const asked: string[] = [];
  const routed: string[] = [];
  /** Each request the main loop made, as the model got it. */
  const mains: { instructions: string; tools: unknown[]; input: string[] }[] = [];
  /** Those requests' items, as the model got them. */
  const mainRaw: unknown[][] = [];
  /** The ids of those requests, each message said, and each piece of text streamed. */
  const mainIds: string[] = [];
  const messages: {
    thread: string;
    id: string;
    role: string;
    text: string;
    images?: Picture[];
    ask?: Card;
    answer?: CardAnswer;
  }[] = [];
  const deltas: { thread: string; id: string; text: string }[] = [];
  /** Each time it said whether anything is at work, and each message that got no answer. */
  const working: boolean[] = [];
  const failures: string[] = [];
  /** Each piece of work said to have changed, in order. */
  const worked: string[] = [];
  /**
   * What was said to have become of each user message, in order: `thread: id fact`, and with a
   * step, `thread: id fact: step`.
   */
  const progress: string[] = [];
  /** What each piece of work's life said, in order: `work: event`. */
  const lives: string[] = [];
  /** Each close said with a reaction: `thread: id emoji`. */
  const reactions: string[] = [];
  /** What the looper warned of in its log, in order. */
  const warnings: string[] = [];
  /**
   * What each worker's request held, in the order the model reads it, each of the person's
   * messages without the number it starts with, and what was sent as its words; `numbered` has
   * them as the model got them, and `told` what each request was told and offered.
   */
  const inputs: string[][] = [];
  const numbered: string[][] = [];
  /** Each worker's request's id, in the order they were made. */
  const askedIds: string[] = [];
  /** Each worker's request's items, as the model got them. */
  const raw: unknown[][] = [];
  const told: { instructions: string; tools: string[] }[] = [];
  /** Each request of a conversation's own loop: what it was told and offered, and its input. */
  const talks: { instructions: string; tools: string[]; input: string[] }[] = [];
  /** Each request for a summary, as the model got it: what it was told, and the one message. */
  const summaries: { instructions: string; text: string }[] = [];
  /** What the stand-in summarizer was given each time, when it is the one summarizing. */
  const given: Given[] = [];
  /** The requests still out, each by the last thing said to it and the first. */
  const open: {
    text: string;
    first: string;
    id: string;
    /**
     * The number of the newest message it read and hasn't handed back, which `sends` names unless
     * told another.
     */
    newest: number;
    answer(output: OutputItem[]): void;
    fail(error?: Error): void;
  }[] = [];
  const close = (id: string) => {
    const at = open.findIndex((request) => request.id === id);
    if (at !== -1) open.splice(at, 1);
  };
  const looper = createLooper({
    store: {
      async get({ key }) {
        await options.reading?.(key);
        return values.has(key) ? { value: values.get(key) as Json } : {};
      },
      async set({ key, value }) {
        await options.writing?.(key);
        values.set(key, value);
      },
      async delete({ key }) {
        await options.deleting?.(key);
        values.delete(key);
      },
      // Two keys at a time, so anything long is read over several pages.
      async list({ prefix = "", after }) {
        await options.reading?.(prefix);
        const rest = [...values.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort();
        const keys = rest.slice(0, 2);
        return { keys, next: rest.length > 2 ? (keys[1] as string) : null };
      },
    },
    model: {
      respond: ({ requestId, instructions, input, tools }) =>
        new Promise((answer, fail) => {
          const last = input.findLast((item) => item.type === "message" && item.role === "user");
          const text = last?.type === "message" ? unnumbered(last.content) : "";
          if (tools.length === 0) {
            summaries.push({ instructions, text });
            open.push({
              text: "a summary",
              first: "",
              id: requestId,
              newest: 0,
              answer: () => {},
              fail: () => fail(gone()),
            });
            Promise.resolve(
              options.summarizing?.(text) ?? says(`## Goal\n- Summary ${summaries.length}.`),
            ).then((output) => answer({ output }), fail);
            return;
          }
          if (tools.some((tool) => tool.name === "route") && tools.some((t) => t.name === "send")) {
            const newest = newestOf(input);
            // The last thing said to it is its newest numbered message: the work there is comes after.
            const said = input.findLast(
              (item) =>
                item.type === "message" && item.role === "user" && /^\[\d+\]/.test(item.content),
            );
            const text = said?.type === "message" ? unnumbered(said.content) : "";
            talks.push({
              instructions,
              tools: tools.map((tool) => tool.name),
              input: input.map((item) =>
                item.type === "message"
                  ? item.content
                  : item.type === "function_call"
                    ? `call ${item.name} ${item.arguments}`
                    : `output ${item.output}`,
              ),
            });
            open.push({
              text: "the conversation",
              first: "",
              id: requestId,
              newest,
              answer: () => {},
              fail: () => fail(gone()),
            });
            Promise.resolve(
              options.talking?.(text, { instructions, input }) ?? passes("Work"),
            ).then(
              (output) => answer({ output: output.map((item) => naming(item, newest)) }),
              fail,
            );
            return;
          }
          if (tools.some((tool) => tool.name === "route")) {
            routed.push(text);
            mainIds.push(requestId);
            mainRaw.push(structuredClone(input));
            mains.push({
              instructions,
              tools,
              input: input.map((item) => (item.type === "message" ? item.content : item.type)),
            });
            open.push({
              text: "the main loop",
              first: "",
              id: requestId,
              newest: 0,
              answer: () => {},
              fail: () => fail(gone()),
            });
            Promise.resolve(
              (text.startsWith(IDLE)
                ? (options.idle?.(saidBefore(input), text) ?? followUp(text))
                : options.routing?.(text)) ?? newWork(),
            ).then((output) => answer({ output }), fail);
            return;
          }
          const tail = input.at(-1);
          const sent = new Map(
            input.flatMap((item) =>
              item.type === "function_call" && item.name === "send"
                ? [[item.callId, sentText(item.arguments)] as const]
                : [],
            ),
          );
          if (
            !options.askAfterSend &&
            tail?.type === "function_call_output" &&
            sent.has(tail.callId) &&
            tail.output === "Sent."
          ) {
            answer({ output: [] });
            return;
          }
          asked.push(text);
          askedIds.push(requestId);
          const lines = (plain: boolean) =>
            input.flatMap((item) =>
              item.type === "message"
                ? [plain ? unnumbered(item.content) : item.content]
                : item.type === "function_call"
                  ? [sent.get(item.callId) ?? `call ${item.name}`]
                  : sent.has(item.callId) && item.output === "Sent."
                    ? []
                    : [`output ${item.output}`],
            );
          inputs.push(lines(true));
          numbered.push(lines(false));
          raw.push(structuredClone(input));
          told.push({ instructions, tools: tools.map((tool) => tool.name) });
          const first = input.find((item) => item.type === "message" && item.role === "user");
          // The newest message it read that it hasn't handed back.
          const back = new Set(
            input.flatMap((item) => {
              if (item.type !== "function_call" || item.name !== "hand_back") return [];
              const done = input.some(
                (one) =>
                  one.type === "function_call_output" &&
                  one.callId === item.callId &&
                  one.output.startsWith("Handed back."),
              );
              return done ? [(JSON.parse(item.arguments) as { message: number }).message] : [];
            }),
          );
          const newest =
            input
              .flatMap((item) =>
                item.type === "message" && item.role === "user"
                  ? [Number(/^\[(\d+)\]/.exec(item.content)?.[1] ?? 0)]
                  : [],
              )
              .findLast((number) => number > 0 && !back.has(number)) ?? 0;
          open.push({
            text,
            first: first?.type === "message" ? unnumbered(first.content) : "",
            id: requestId,
            newest,
            answer: (output) => answer({ output: output.map((item) => naming(item, newest)) }),
            fail: (error) => fail(error ?? gone()),
          });
        }),
      async cancel({ requestId }) {
        if (options.deaf) return;
        for (const request of [...open])
          if (request.id === requestId) {
            close(request.id);
            request.fail();
          }
      },
    },
    request: async (conversation) => {
      options.requested?.(conversation);
      return {
        instructions:
          typeof options.instructions === "function"
            ? options.instructions()
            : (options.instructions ?? ""),
        tools: options.tools ?? [],
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.frontDesk === undefined ? {} : { frontDesk: options.frontDesk }),
      };
    },
    out: {
      message(thread, { id, role, text, images, ask, answer }) {
        messages.push({
          thread,
          id,
          role,
          text,
          ...(images ? { images } : {}),
          ...(ask ? { ask } : {}),
          ...(answer ? { answer } : {}),
        });
        said.push(`${thread}: ${role}: ${text}`);
        options.saying?.(`${thread}: ${role}: ${text}`);
      },
      delta: (thread, id, text) => void deltas.push({ thread, id, text }),
      working: (on) => void working.push(on),
      failed: (thread, { code }) => void failures.push(`${thread}: ${code}`),
      // None for the main loop: its model request being tried again, or no longer.
      worked: (work) => void worked.push(work ?? ""),
      life: ({ event, work }) => void lives.push(`${work}: ${event}`),
      progress: (thread, id, fact, step, reaction) => {
        progress.push(`${thread}: ${id} ${fact}${step === undefined ? "" : `: ${step}`}`);
        if (reaction !== undefined) reactions.push(`${thread}: ${id} ${reaction}`);
      },
    },
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.stopGroup === undefined ? {} : { stopGroup: options.stopGroup }),
    ...(options.speaker === undefined ? {} : { speaker: options.speaker }),
    ...(options.files === undefined ? {} : { files: options.files }),
    summarizer: options.summarizer ?? (() => standIn(given)),
    ...(options.conversations === undefined ? {} : { conversations: options.conversations }),
    ...(options.pass === undefined ? {} : { pass: options.pass }),
    log: { info() {}, warn: (message) => void warnings.push(message), error() {} },
  });
  /**
   * Answer the request that ends with `text`, or fail it: the newest still out, or with `of`,
   * the one of the work whose first message has that in it.
   */
  const found = (text: string, of?: string) => {
    const request = open.findLast(
      (one) => one.text === text && (of === undefined || one.first.includes(of)),
    );
    if (request) close(request.id);
    return request;
  };
  const answer = (text: string, output: OutputItem[] = sends("Done."), of?: string) =>
    found(text, of)?.answer(output);
  const fail = (text: string, error?: Error) => found(text)?.fail(error);
  /** Threads no message was sent in before, each sent one and left in its turn. */
  const fill = async (names: string[]) => {
    const before = asked.length;
    for (const name of names) await looper.send(name, `Work ${name}.`);
    while (asked.length < before + names.length) await idle();
  };
  return {
    looper,
    values,
    said,
    asked,
    askedIds,
    inputs,
    numbered,
    raw,
    told,
    summaries,
    given,
    routed,
    mains,
    mainRaw,
    mainIds,
    messages,
    deltas,
    working,
    failures,
    worked,
    progress,
    lives,
    reactions,
    warnings,
    talks,
    answer,
    fail,
    fill,
  };
}
const gone = () => new Refusal("cancelled", "The request was cancelled.");
/** What a call of `send` sent, from its arguments. */
const sentText = (args: string) => {
  try {
    const { text } = JSON.parse(args) as { text?: unknown };
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
};
/** A call of `send` that names no message, as `sends` makes it, made to name `newest`. */
const naming = (item: OutputItem, newest: number): OutputItem => {
  if (item.type !== "function_call" || !["send", "route", "no_reply_needed"].includes(item.name))
    return item;
  const args = JSON.parse(item.arguments) as { message?: unknown };
  return args.message === NEWEST
    ? { ...item, arguments: JSON.stringify({ ...args, message: newest }) }
    : item;
};
const NEWEST = "newest";
/** A message as the person said it: without the number a worker's model reads it by. */
const unnumbered = (content: string) => content.replace(/^\[\d+(\.\d+)?\] /, "");
/** A worker handing the message of that number back. */
export const handsBack = (
  message: number,
  why = "It isn't this work's.",
  leave = false,
): OutputItem[] => [
  {
    type: "function_call",
    callId: `back-${crypto.randomUUID()}`,
    name: "hand_back",
    arguments: JSON.stringify({ message, why, ...(leave ? { leave } : {}) }),
  },
];
/** What the main loop calls `route` with. */
export const route = (said: { work?: string; title?: string; stop?: string }): OutputItem[] => [
  {
    type: "function_call",
    callId: `route-${crypto.randomUUID()}`,
    name: "route",
    arguments: JSON.stringify(said),
  },
];
/** The main loop placing what came in: new work with a title, or a piece of work there is by its id. */
export const newWork = (title = "Work") => route({ title });
export const routeTo = (work: string) => route({ work });
/** The message a main-loop request is about: the person's newest, before what it is told of it. */
const saidBefore = (input: Item[]) => {
  for (const item of [...input].reverse())
    if (item.type === "message" && item.role === "user" && !item.content.startsWith(IDLE))
      return item.content;
  return "";
};
/** What the main loop is told of a message no work in a turn took: which work was last active. */
export const IDLE = LAST_ACTIVE;
/** Given to the work last active, as a follow-up is: what the main loop is told names it. */
export const followUp = (text: string) => routeTo(text.slice(IDLE.length, -1));
/** The main loop stopping a piece of work in a turn, by its id. */
export const stops = (work: string) => route({ stop: work });
export const says = (content: string): OutputItem[] => [
  { type: "message", role: "assistant", content },
];
/** The newest message a request read and didn't hand back or pass on, by its number. */
const newestOf = (input: Item[]) => {
  // A call that was refused passed nothing on.
  const refused = new Set(
    input.flatMap((item) =>
      item.type === "function_call_output" && item.output.startsWith('{"error"')
        ? [item.callId]
        : [],
    ),
  );
  const gone = new Set(
    input.flatMap((item) => {
      if (
        item.type !== "function_call" ||
        !["hand_back", "route"].includes(item.name) ||
        refused.has(item.callId)
      )
        return [];
      const { message } = JSON.parse(item.arguments) as { message?: number };
      return typeof message === "number" ? [message] : [];
    }),
  );
  return (
    input
      .flatMap((item) =>
        item.type === "message" && item.role === "user"
          ? [Number(/^\[(\d+)\]/.exec(item.content)?.[1] ?? 0)]
          : [],
      )
      .findLast((number) => number > 0 && !gone.has(number)) ?? 0
  );
};
/** A conversation's loop passing a message on: to new work by its title, or to work there is. */
export const passes = (
  title: string,
  work?: string,
  message?: number,
  receipt?: string,
): OutputItem[] => [
  {
    type: "function_call",
    callId: `route-${crypto.randomUUID()}`,
    name: "route",
    arguments: JSON.stringify({
      message: message ?? NEWEST,
      ...(work === undefined ? { title } : { work }),
      ...(receipt === undefined ? {} : { receipt }),
    }),
  },
];
/** A conversation's loop closing a message with no reply, with a reaction if given. */
export const closes = (reaction?: string, message?: number): OutputItem[] => [
  {
    type: "function_call",
    callId: `close-${crypto.randomUUID()}`,
    name: "no_reply_needed",
    arguments: JSON.stringify({ message: message ?? NEWEST, ...(reaction ? { reaction } : {}) }),
  },
];
/** A worker sending `text` to the person, in reply to the message of that number: by default the newest it read. */
export const sends = (text: string, message?: number): OutputItem[] => [
  {
    type: "function_call",
    callId: `send-${crypto.randomUUID()}`,
    name: "send",
    arguments: JSON.stringify({ message: message ?? NEWEST, text }),
  },
];
/**
 * Everything a thread's record keeps, in order, each as its text: what was said there, a reply
 * by what it sent, and what work kept there that is said in no thread, its calls and what its
 * worker didn't send.
 */
export const kept = (values: Map<string, Json>, thread: string) =>
  [...values.keys()]
    .filter((key) => key.startsWith(`thread/${encodeURIComponent(thread)}/msg/`))
    .sort()
    .map((key) => textOf(Entry.parse(values.get(key))));
/** A promise and the way to settle it. */
export function gate() {
  let open: () => void = () => {};
  let fail: () => void = () => {};
  const shut = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error("the store refused it"));
  });
  return { shut, open, fail };
}
/** Wait until `condition` holds. */
export async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((soon) => setImmediate(soon));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}
/** Let everything that can happen now happen: for showing that nothing more does. */
export async function idle() {
  for (let i = 0; i < 50; i++) await new Promise((soon) => setImmediate(soon));
}

/**
 * A tool, `hold` unless named otherwise, that runs until the test lets it end. `groups` is the
 * group of each call, in order.
 */
export function held(name = "hold") {
  const { shut, open: finish } = gate();
  const groups: string[] = [];
  const tool: Tool = {
    name,
    parameters: {},
    run: async (_input, group) => {
      groups.push(group);
      await shut;
      return { output: "held", ok: true };
    },
  };
  const called: OutputItem[] = [{ type: "function_call", callId: "c1", name, arguments: "{}" }];
  /** A model's answer that calls it `count` times. */
  const calls = (count: number): OutputItem[] =>
    Array.from({ length: count }, () => ({
      type: "function_call",
      callId: `c-${crypto.randomUUID()}`,
      name,
      arguments: "{}",
    }));
  return { tool, called, calls, groups, finish };
}
