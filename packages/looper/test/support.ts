import { createLooper, type Json, type OutputItem, Refusal, type Tool } from "../src/index.ts";

/**
 * A looper whose model answers a worker's request only when the test says so, naming the request by
 * the last thing said to it. `asked` is what the model has been asked for workers, in order. The
 * main loop's requests are answered at once, with new work, unless `routing` says otherwise;
 * `routed` is what it was put, and `mains` its requests whole.
 */
export function looperWith(
  options: {
    tools?: Tool[];
    stopped?: boolean;
    /** A model that never hears a cancel: its answer stays out. */
    deaf?: boolean;
    /** Awaited before each write to the store, and before each read or listing from it. */
    writing?: (key: string) => Promise<void> | undefined;
    reading?: (key: string) => Promise<void> | undefined;
    /** The store, to make a looper again on what another kept. */
    values?: Map<string, Json>;
    /** Called as each message is said. */
    saying?: (line: string) => void;
    /** Who the main loop speaks as. */
    voice?: string;
    /** What the main loop answers when put `text`: by default, new work. */
    routing?: (text: string) => OutputItem[] | Promise<OutputItem[]> | undefined;
  } = {},
) {
  const values = options.values ?? new Map<string, Json>();
  const said: string[] = [];
  const asked: string[] = [];
  const routed: string[] = [];
  /** Each request the main loop made, as the model got it. */
  const mains: { instructions: string; tools: unknown[]; input: string[] }[] = [];
  /** The ids of those requests, each message said, and each piece of text streamed. */
  const mainIds: string[] = [];
  const messages: { thread: string; id: string; role: string; text: string }[] = [];
  const deltas: { thread: string; id: string; text: string }[] = [];
  /** Each time it said whether anything is at work, and each message that got no answer. */
  const working: boolean[] = [];
  const failures: string[] = [];
  /** What each request held, in the order the model reads it. */
  const inputs: string[][] = [];
  const open = new Map<string, { id: string; answer(output: OutputItem[]): void; fail(): void }>();
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
      delete: async ({ key }) => void values.delete(key),
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
          const text = last?.type === "message" ? last.content : "";
          if (tools.some((tool) => tool.name === "route")) {
            routed.push(text);
            mainIds.push(requestId);
            mains.push({
              instructions,
              tools,
              input: input.map((item) => (item.type === "message" ? item.content : item.type)),
            });
            open.set("the main loop", {
              id: requestId,
              answer: () => {},
              fail: () => fail(gone()),
            });
            Promise.resolve(options.routing?.(text) ?? newWork()).then(
              (output) => answer({ output }),
              fail,
            );
            return;
          }
          asked.push(text);
          inputs.push(
            input.map((item) =>
              item.type === "message"
                ? item.content
                : item.type === "function_call"
                  ? `call ${item.name}`
                  : `output ${item.output}`,
            ),
          );
          open.set(text, {
            id: requestId,
            answer: (output) => answer({ output }),
            fail: () => fail(gone()),
          });
        }),
      async cancel({ requestId }) {
        if (options.deaf) return;
        for (const request of open.values()) if (request.id === requestId) request.fail();
      },
    },
    request: async () => ({
      instructions: "",
      tools: options.tools ?? [],
      ...(options.voice === undefined ? {} : { voice: options.voice }),
    }),
    out: {
      message(thread, { id, role, text }) {
        messages.push({ thread, id, role, text });
        said.push(`${thread}: ${role}: ${text}`);
        options.saying?.(`${thread}: ${role}: ${text}`);
      },
      delta: (thread, id, text) => void deltas.push({ thread, id, text }),
      working: (on) => void working.push(on),
      failed: (thread, { code }) => void failures.push(`${thread}: ${code}`),
    },
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    log: { info() {}, warn() {}, error() {} },
  });
  /** Answer the request that ends with `text`, or fail it. */
  const answer = (text: string, output: OutputItem[] = says("Done.")) =>
    open.get(text)?.answer(output);
  const fail = (text: string) => open.get(text)?.fail();
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
    routed,
    mains,
    mainIds,
    messages,
    deltas,
    working,
    failures,
    answer,
    fail,
    fill,
  };
}
const gone = () => new Refusal("cancelled", "The request was cancelled.");
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

/** A tool that runs until the test lets it end. */
export function held() {
  const { shut, open: finish } = gate();
  const tool: Tool = {
    name: "hold",
    parameters: {},
    run: async () => {
      await shut;
      return { output: "held", ok: true };
    },
  };
  const called: OutputItem[] = [
    { type: "function_call", callId: "c1", name: "hold", arguments: "{}" },
  ];
  return { tool, called, finish };
}
