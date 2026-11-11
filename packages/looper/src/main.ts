/**
 * The main loop: one per looper. It is given a thread no piece of work follows, in which a message
 * has come in, and the work there is. It says whose the message is, new work or work there is, or
 * answers it itself when it needs no work. It does none of the work, and it has one function to
 * call. Each decision is one model request, which holds nothing of the decisions before it but
 * what was said in that thread.
 */
import { head } from "./record.js";
import type { Item, Log, Model, ToolSpec } from "./types.js";

/** What the main loop is told, before who it speaks as. */
export const MAIN_INSTRUCTIONS = `You are the front desk. You do none of the work: you say whose a message is, or answer it yourself when it needs no work.

You are given the latest pieces of work, each by its id and title, whether it is in a turn or at rest, and a line on what it last said; then the conversation where a message has come in that no work owns.

- Give it to a piece of work only when it points at that work explicitly: it names it, quotes it, or refers to what it is doing or just did, and exactly one piece of work fits. Call \`route\` with that work's id. Its worker will read it with everything it already knows, and answer where it came in. From then on everything said there goes to that work.
- Answer it yourself, in plain text and calling nothing, only when it needs no tools and nothing you can't see here: a greeting, thanks, a question about who you are or about the work listed. Never say you will do, find, check or look into something: you can't, and saying so starts no work.
- Anything else is new work, also when it is on a subject like that of work there is. Call \`route\` with no \`work\`, and a \`title\` of a few words that says what the new work is.

Whatever you write is said to the person as the reply. So when you call \`route\`, write nothing: the worker answers.

A wrong match stays, and a promise starts nothing: when in doubt it is new work.`;
/** How who it speaks as is told after that. */
const VOICE =
  "When you answer yourself, you speak as the one described below. What that one is told to do is a worker's to do, not yours:";

/** The one function the main loop calls. */
export const ROUTE: ToolSpec = {
  name: "route",
  description: "Says whose what came in is: a piece of work there is, or new work.",
  parameters: {
    type: "object",
    properties: {
      work: {
        type: "string",
        description: "The id of the work that it points at. Leave it out for new work.",
      },
      title: {
        type: "string",
        description: "For new work: a few words that say what it is.",
      },
    },
  },
};

/** A piece of work as the main loop is told of it. */
export interface Listed {
  id: string;
  title: string;
  /** Whether a turn of it is running or waiting for its place. */
  running: boolean;
  /** The head of what it last said, if it has said anything. */
  last?: string | undefined;
  /** Whether its last turn failed. */
  failed?: boolean | undefined;
}
/** A message of the thread, as the main loop reads it. */
export interface Said {
  role: "user" | "assistant";
  text: string;
}
/**
 * What the main loop decided. `placed` is whose what came in is: work it was told of, or new work
 * by its title. `answer` is what it said itself: alone, when it placed nothing, or beside.
 */
export interface Decided {
  answer?: string;
  placed?: { work: string } | { title: string };
}

/** A work's title: the first line of `text` that says anything, in a few words. */
export const titled = (text: string) =>
  head((text.split("\n").find((line) => /\S/.test(line)) ?? "").replace(/\s+/g, " ").trim(), 80);

/**
 * How much the main loop is told, enough to place a message: the thread's newest messages and the
 * start of each, the latest pieces of work with the start of what each last said, and the start
 * of who it speaks as.
 */
export const TOLD = { messages: 8, each: 4000, works: 12, last: 200, voice: 100_000 };
/** The work there is, as the main loop is told of it. */
const listing = (works: Listed[]) =>
  works.length === 0
    ? "There is no work."
    : [
        "The work there is:",
        ...works.map(({ id, title, running, last, failed }) => {
          const state = running
            ? "in a turn"
            : failed
              ? "at rest; its last turn failed"
              : "at rest";
          return `- ${id}: ${title} (${state})${last ? `; it last said: ${last}` : ""}`;
        }),
      ].join("\n");
/** What the main loop's request holds: the work there is, then the thread as a conversation. */
const put = (said: Said[], works: Listed[]): Item[] => [
  { type: "message", role: "user", content: listing(works) },
  ...said.slice(-TOLD.messages).map(({ role, text }) => ({
    type: "message" as const,
    role,
    content: text.length > TOLD.each ? `${head(text, TOLD.each)}…` : text,
  })),
];

export function createMain(options: {
  model: Model;
  /**
   * Read for each decision: which model to ask, none meaning the model's own default, and who
   * the main loop speaks as when it answers itself.
   */
  request(): Promise<{ model?: string | undefined; voice?: string | undefined }>;
  log: Log;
}) {
  /** The decision being made now, how to drop it, and where its text goes as it is written. */
  let deciding: { requestId?: string; drop(): void; written(text: string): void } | undefined;

  return {
    /**
     * Decide on a thread, given what was said in it (`heard`) and the work there is: one decision
     * at a time. `written` is given its text as the model writes it. Nothing is said for a
     * decision that is cancelled. A request the model refuses rejects, as it refused.
     */
    async decide(
      heard: Said[],
      works: Listed[],
      written: (text: string) => void,
    ): Promise<Decided | undefined> {
      let drop = () => {};
      const dropped = new Promise<undefined>((resolve) => {
        drop = () => resolve(undefined);
      });
      const mine: NonNullable<typeof deciding> = { drop, written };
      deciding = mine;
      try {
        const given = await Promise.race([options.request().then((to) => ({ to })), dropped]);
        if (!given) return undefined;
        const { model, voice } = given.to;
        mine.requestId = crypto.randomUUID();
        const asked = options.model.respond({
          requestId: mine.requestId,
          ...(model ? { model } : {}),
          instructions: voice
            ? `${MAIN_INSTRUCTIONS}\n\n${VOICE}\n\n${head(voice, TOLD.voice)}`
            : MAIN_INSTRUCTIONS,
          input: put(heard, works),
          tools: [ROUTE],
        });
        // A model that never answers a request it was told to cancel holds nothing up.
        asked.catch(() => {});
        const reply = await Promise.race([asked, dropped]);
        if (!reply) return undefined;
        const text = reply.output
          .flatMap((item) => (item.type === "message" ? [item.content] : []))
          .join("");
        const call = reply.output.find(
          (item) => item.type === "function_call" && item.name === ROUTE.name,
        );
        const said: Decided = text.trim() ? { answer: text } : {};
        // Text and no call: it answered, and nothing is placed.
        if (call?.type !== "function_call" && said.answer !== undefined) return said;
        let routed: { work?: unknown; title?: unknown } = {};
        if (call?.type === "function_call")
          try {
            routed = (JSON.parse(call.arguments) ?? {}) as typeof routed;
          } catch {
            // Arguments that don't read: new work, as with no call.
          }
        if (works.some(({ id }) => id === routed.work))
          return { ...said, placed: { work: routed.work as string } };
        // Anything else starts new work, titled by what came in if the model gave no title.
        if (typeof routed.work === "string" && routed.work !== "")
          options.log.warn("The main loop named work there isn't; it is new work.", {
            work: head(routed.work, 128),
          });
        const title = titled(typeof routed.title === "string" ? routed.title : "");
        const newest = heard.findLast(({ role }) => role === "user")?.text ?? "";
        return { ...said, placed: { title: title || titled(newest) } };
      } finally {
        if (deciding === mine) deciding = undefined;
      }
    },
    /** Text the model writes while it answers `requestId`, if that is the decision being made. */
    delta(requestId: string, text: string) {
      if (deciding?.requestId === requestId) deciding.written(text);
    },
    /** Drop the decision being made: its request is cancelled, and it says nothing. */
    async cancel() {
      const cut = deciding;
      if (!cut) return;
      cut.drop();
      if (cut.requestId) await options.model.cancel({ requestId: cut.requestId }).catch(() => {});
    },
  };
}
