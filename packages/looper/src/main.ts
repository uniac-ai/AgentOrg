/**
 * The main loop: one per looper. It is given the messages that have come in where no piece of
 * work is listening, and says whose they are: new work, or work under way. It does none of the
 * work and answers nobody. It has one function to call, and each decision is one model request
 * that holds nothing of the decisions before it.
 */
import { head } from "./record.js";
import type { Log, Model, ToolSpec } from "./types.js";

/** What the main loop is told. */
export const MAIN_INSTRUCTIONS = `You are the front desk. You do none of the work and you answer nobody: you say whose a message is, by calling \`route\` once.

You are given the pieces of work under way, each by its id and title, and what has come in where no work is listening yet.

- Give it to a piece of work under way only when it points at that work explicitly: it names it, quotes it, or refers to what it is doing, and exactly one piece of work fits. Call \`route\` with that work's id. Its worker will read it with everything it already knows, and answer where it came in. From then on everything said there goes to that work.
- Anything else is new work, also when it is on a subject like that of work under way. Call \`route\` with no \`work\`, and a \`title\` of a few words that says what the new work is.

A wrong match stays, so when in doubt it is new work. Your only answer is the call.`;

/** The one function the main loop calls. */
export const ROUTE: ToolSpec = {
  name: "route",
  description: "Says whose what came in is: a piece of work under way, or new work.",
  parameters: {
    type: "object",
    properties: {
      work: {
        type: "string",
        description: "The id of the work under way that it points at. Leave it out for new work.",
      },
      title: {
        type: "string",
        description: "For new work: a few words that say what it is.",
      },
    },
  },
};

/** A piece of work as the main loop is told of it. */
export interface Underway {
  id: string;
  title: string;
}
/** What the main loop decided: work under way that takes the messages, or new work's title. */
export type Routed = { work: string } | { title: string };

/** A work's title: the first line of `text` that says anything, in a few words. */
export const titled = (text: string) =>
  head((text.split("\n").find((line) => /\S/.test(line)) ?? "").replace(/\s+/g, " ").trim(), 80);

/** The main loop is put the newest messages waiting, and the start of each: enough to place them. */
const PUT = { messages: 8, each: 4000 };
/** What has come in, as it is put to the main loop with the work under way. */
export const put = (texts: string[], underway: Underway[]) =>
  [
    underway.length === 0 ? "No work is under way." : "Work under way:",
    ...underway.map(({ id, title }) => `- ${id}: ${title}`),
    "",
    "What came in:",
    texts
      .slice(-PUT.messages)
      .map((text) => (text.length > PUT.each ? `${head(text, PUT.each)}…` : text))
      .join("\n\n"),
  ].join("\n");

export function createMain(options: {
  model: Model;
  /** Which model to ask, none meaning the model's own default. */
  chosen(): Promise<string | undefined>;
  log: Log;
}) {
  /** The decision being made now, and how to drop it. */
  let deciding: { requestId?: string; drop(): void } | undefined;

  return {
    /**
     * Say whose `texts` are, given the work under way: one decision at a time. Nothing is said
     * for a decision that is cancelled. A request the model refuses rejects, as it refused.
     */
    async route(texts: string[], underway: Underway[]): Promise<Routed | undefined> {
      let drop = () => {};
      const dropped = new Promise<undefined>((resolve) => {
        drop = () => resolve(undefined);
      });
      const mine: NonNullable<typeof deciding> = { drop };
      deciding = mine;
      try {
        const chosen = await Promise.race([options.chosen().then((model) => ({ model })), dropped]);
        if (!chosen) return undefined;
        mine.requestId = crypto.randomUUID();
        const asked = options.model.respond({
          requestId: mine.requestId,
          ...(chosen.model ? { model: chosen.model } : {}),
          instructions: MAIN_INSTRUCTIONS,
          input: [{ type: "message", role: "user", content: put(texts, underway) }],
          tools: [ROUTE],
        });
        // A model that never answers a request it was told to cancel holds nothing up.
        asked.catch(() => {});
        const answer = await Promise.race([asked, dropped]);
        if (!answer) return undefined;
        const call = answer.output.find(
          (item) => item.type === "function_call" && item.name === ROUTE.name,
        );
        let said: { work?: unknown; title?: unknown } = {};
        if (call?.type === "function_call")
          try {
            said = (JSON.parse(call.arguments) ?? {}) as typeof said;
          } catch {
            // Arguments that don't read: new work, as with no call.
          }
        if (underway.some(({ id }) => id === said.work)) return { work: said.work as string };
        // Anything else starts new work, titled by what came in if the model gave no title.
        if (typeof said.work === "string" && said.work !== "")
          options.log.warn("The main loop named work that isn't under way; it is new work.", {
            work: head(said.work, 128),
          });
        const title = titled(typeof said.title === "string" ? said.title : "");
        return { title: title || titled(texts.join("\n")) };
      } finally {
        if (deciding === mine) deciding = undefined;
      }
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
