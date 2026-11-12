import {
  createLooper,
  Entry,
  type Json,
  type OutputItem,
  type Picture,
  Refusal,
  type Tool,
  textOf,
} from "../src/index.ts";

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
    /** Who a message said in a thread is from, when not the person. */
    speaker?: (thread: string) => string | undefined;
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
  }[] = [];
  const deltas: { thread: string; id: string; text: string }[] = [];
  /** Each time it said whether anything is at work, and each message that got no answer. */
  const working: boolean[] = [];
  const failures: string[] = [];
  /** Each piece of work said to have changed, in order. */
  const worked: string[] = [];
  /**
   * What each worker's request held, in the order the model reads it, each of the person's
   * messages without the number it starts with, and what was sent as its words; `numbered` has
   * them as the model got them, and `told` what each request was told and offered.
   */
  const inputs: string[][] = [];
  const numbered: string[][] = [];
  /** Each worker's request's items, as the model got them. */
  const raw: unknown[][] = [];
  const told: { instructions: string; tools: string[] }[] = [];
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
    fail(): void;
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
            Promise.resolve(options.routing?.(text) ?? newWork()).then(
              (output) => answer({ output }),
              fail,
            );
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
            fail: () => fail(gone()),
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
    request: async () => ({
      instructions: "",
      tools: options.tools ?? [],
      ...(options.voice === undefined ? {} : { voice: options.voice }),
    }),
    out: {
      message(thread, { id, role, text, images }) {
        messages.push({ thread, id, role, text, ...(images ? { images } : {}) });
        said.push(`${thread}: ${role}: ${text}`);
        options.saying?.(`${thread}: ${role}: ${text}`);
      },
      delta: (thread, id, text) => void deltas.push({ thread, id, text }),
      working: (on) => void working.push(on),
      failed: (thread, { code }) => void failures.push(`${thread}: ${code}`),
      worked: (work) => void worked.push(work),
    },
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.stopGroup === undefined ? {} : { stopGroup: options.stopGroup }),
    ...(options.speaker === undefined ? {} : { speaker: options.speaker }),
    log: { info() {}, warn() {}, error() {} },
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
  const fail = (text: string) => found(text)?.fail();
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
    inputs,
    numbered,
    raw,
    told,
    routed,
    mains,
    mainRaw,
    mainIds,
    messages,
    deltas,
    working,
    failures,
    worked,
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
  if (item.type !== "function_call" || item.name !== "send") return item;
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
/** The main loop stopping a piece of work in a turn, by its id. */
export const stops = (work: string) => route({ stop: work });
export const says = (content: string): OutputItem[] => [
  { type: "message", role: "assistant", content },
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

/** A tool that runs until the test lets it end. `groups` is the group of each call, in order. */
export function held() {
  const { shut, open: finish } = gate();
  const groups: string[] = [];
  const tool: Tool = {
    name: "hold",
    parameters: {},
    run: async (_input, group) => {
      groups.push(group);
      await shut;
      return { output: "held", ok: true };
    },
  };
  const called: OutputItem[] = [
    { type: "function_call", callId: "c1", name: "hold", arguments: "{}" },
  ];
  /** A model's answer that calls it `count` times. */
  const calls = (count: number): OutputItem[] =>
    Array.from({ length: count }, () => ({
      type: "function_call",
      callId: `c-${crypto.randomUUID()}`,
      name: "hold",
      arguments: "{}",
    }));
  return { tool, called, calls, groups, finish };
}
