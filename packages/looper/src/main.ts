/**
 * The main loop: one per looper. It is given a thread in which a message waits that no piece of
 * work keeps: one said where nothing follows, or one every piece of work it was given to handed
 * back; and the work there is. It says whose the message is, new work or work there is, or
 * answers it itself when it needs no work, or stops a piece of work the message asks to stop. It
 * is also told of a message that joined turns of work, which that work has: then it is given
 * those pieces of work and that message, and may only stop one of them. It does none of the
 * work, and it has one function to call. Each time is one model request, which holds nothing of
 * those before it but what it is given.
 */
import { PICTURES_BUDGET, withPictures } from "./record.js";
import { head, type Item, type Log, type Model, type Picture, type ToolSpec } from "./types.js";

/** What the main loop is told, before who it speaks as. */
export const MAIN_INSTRUCTIONS = `You are the front desk. You do none of the work: you say whose a message is, answer it yourself when it needs no work, or stop a piece of work it asks to stop.

You are given the latest pieces of work, each by its id and title, whether it is in a turn or at rest, and a line on what it last said; then the conversation where a message has come in that no work owns. A message from anyone other than the person starts by saying who it is from, like (from <who>).

- Give it to a piece of work only when it points at that work explicitly: it names it, quotes it, or refers to what it is doing or just did, and exactly one piece of work fits. Call \`route\` with that work's id. Its worker will read it with everything it already knows, and answer where it came in. From then on it follows that conversation too.
- Answer it yourself, in plain text and calling nothing, only when it needs no tools and nothing you can't see here: a greeting, thanks, a question about who you are or about the work listed, or a request to stop that no one piece of work in a turn fits. Never say you will do, find, check or look into something: you can't, and saying so starts no work.
- Stop a piece of work when the message asks to stop it and exactly one piece of work in a turn fits. Call \`route\` with only \`stop\`, set to its id, and say in a few words that you stopped it. If none fits, or more than one, stop nothing and call nothing: say what is in a turn, so they can say which.
- Anything else is new work, also when it is on a subject like that of work there is. Call \`route\` with no \`work\`, and a \`title\` of a few words that says what the new work is.

Whatever you write is said as the reply, in that conversation. So when you give a message to work, old or new, write nothing: the worker answers.

A message may also come to you from a conversation that work follows, when every piece of work it was given to handed it back: you are then told which did, and why. Decide it the same way. The work that handed it back is not listed, and is never given it again.

A message may also come to you from a conversation that several pieces of work follow, none of them in a turn: you are then told which of them was last active there. A message that goes on from what that work last said here, such as a further question on the same thing, an answer to its question, a next step or a correction, points at that work, though it names nothing: give it to it. A question about what a piece of work did or decided is that work's, though it says "you": give it to the one whose title or what it last said shows it did that, when exactly one does. Otherwise decide it the same way.

A wrong match stays, and a promise starts nothing: when in doubt whose it is, it is new work.`;
/**
 * What the main loop is told when a message joined turns of work: the workers have it, and the
 * main loop may only stop one of those turns, or say which they are.
 */
export const HEARD_INSTRUCTIONS = `You are the front desk. You are given the pieces of work that are in a turn, each by its id and title, and then a message that was just said in a conversation those pieces of work follow. Their workers have the message and will read it: you don't answer it, and you give it to nobody.

Act only if the message asks to stop work. If exactly one of those pieces of work fits, call \`route\` with only \`stop\`, set to its id, and say in a few words that you stopped it. If it asks to stop and more than one fits, call nothing and say which are in a turn, so whoever said it can say which: that is said to them. Otherwise call nothing and write nothing.`;
/** What the main loop is told of a message no work in a turn took, before the id of the work last active. */
export const LAST_ACTIVE =
  "None of the work that follows this conversation is in a turn. The one last active here: ";
/** What is said where the main loop called to stop work and wrote nothing: whether a turn was cut. */
export const stopWord = (cut: boolean) => (cut ? "Stopped." : "Nothing was stopped.");
/** How who it speaks as is told after that. */
const VOICE =
  "When you answer yourself, you speak as the one described below. What that one is told to do is a worker's to do, not yours:";

/** The one function the main loop calls. */
export const ROUTE: ToolSpec = {
  name: "route",
  description:
    "Says whose what came in is: a piece of work there is, or new work. Or stops a piece of work.",
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
      stop: {
        type: "string",
        description: "The id of the work in a turn to stop. With it, leave the others out.",
      },
    },
  },
};

/** A piece of work as the main loop is told of it. */
export interface Listed {
  id: string;
  title: string;
  /** Which turn of it is running or waiting for its place, when one is. */
  turn?: number | undefined;
  /** The head of what it last said, if it has said anything. */
  last?: string | undefined;
  /** Whether its last turn failed. */
  failed?: boolean | undefined;
}
/** A message of the thread, as the main loop reads it. */
export interface Said {
  role: "user" | "assistant";
  text: string;
  /** The pictures the person sent with it. */
  images?: Picture[];
}
/**
 * What the main loop decided. `answer` is what it wrote. `placed` is whose what came in is: work
 * it was told of, or new work by its title. `stop` is there when it called to stop work, and
 * then nothing is placed: the turn to cut is the one it was told of, and none when that work was
 * not told of as in a turn.
 */
export interface Decided {
  answer?: string;
  placed?: { work: string } | { title: string };
  stop?: { work: string; turn?: number };
}

/** A work's title: the first line of `text` that says anything, in a few words. */
export const titled = (text: string) =>
  head((text.split("\n").find((line) => /\S/.test(line)) ?? "").replace(/\s+/g, " ").trim(), 80);

/**
 * How much the main loop is told, enough to place a message: the thread's newest messages and the
 * start of each, the latest pieces of work with the start of what each last said, and the start
 * of who it speaks as.
 */
export const TOLD = { messages: 8, each: 4000, works: 12, last: 1000, voice: 100_000 };
/** The work there is, as the main loop is told of it. */
const listing = (works: Listed[]) =>
  works.length === 0
    ? "There is no work."
    : [
        "The work there is:",
        ...works.map(({ id, title, turn, last, failed }) => {
          const state =
            turn !== undefined ? "in a turn" : failed ? "at rest; its last turn failed" : "at rest";
          return `- ${id}: ${title} (${state})${last ? `; it last said: ${last}` : ""}`;
        }),
      ].join("\n");
/** A piece of work that handed a message back, and why. */
export interface Returned {
  id: string;
  title: string;
  why: string;
}
/**
 * What the main loop's request holds: the work there is, then the thread as a conversation, and
 * for a message that came back, which work handed it back and why, or for one no work in a turn
 * took, which work was last active there.
 */
const put = (said: Said[], works: Listed[], back: Returned[] = [], last?: string): Item[] => [
  { type: "message", role: "user", content: listing(works) },
  ...(withPictures(
    [
      said.slice(-TOLD.messages).map(({ role, text, images }) => ({
        type: "message" as const,
        role,
        content: text.length > TOLD.each ? `${head(text, TOLD.each)}…` : text,
        ...(images ? { images } : {}),
      })),
    ],
    PICTURES_BUDGET,
  )[0] ?? []),
  ...(back.length > 0
    ? [
        {
          type: "message" as const,
          role: "user" as const,
          content: [
            "That was given to this work, which handed it back:",
            ...back.map(
              ({ id, title, why }) => `- ${id}: ${title}; because: ${head(why, TOLD.last)}`,
            ),
          ].join("\n"),
        },
      ]
    : last
      ? [
          {
            type: "message" as const,
            role: "user" as const,
            content: `${LAST_ACTIVE}${last}.`,
          },
        ]
      : []),
];

export function createMain(options: {
  model: Model;
  /**
   * Read for each request: which model to ask, none meaning the model's own default, and who the
   * main loop speaks as when it answers itself.
   */
  request(): Promise<{ model?: string | undefined; voice?: string | undefined }>;
  log: Log;
}) {
  /** The request out now, whether it was dropped, and where its text goes as it is written. */
  let asking:
    | { requestId?: string; dropped?: true; drop(): void; written(text: string): void }
    | undefined;

  /**
   * Make one request of the model: what it wrote, and what it called `route` with. `voiced` is
   * whether it is told who it speaks as. None for a request that is dropped, which the model is
   * then not asked, or told to cancel; one the model refuses rejects, as it refused.
   */
  const ask = async (
    instructions: string,
    voiced: boolean,
    input: Item[],
    written: (text: string) => void,
  ) => {
    let drop = () => {};
    const gone = new Promise<undefined>((resolve) => {
      drop = () => {
        mine.dropped = true;
        resolve(undefined);
      };
    });
    const mine: NonNullable<typeof asking> = { drop: () => drop(), written };
    asking = mine;
    try {
      const given = await Promise.race([options.request().then((to) => ({ to })), gone]);
      if (!given || mine.dropped) return undefined;
      const { model, voice } = given.to;
      mine.requestId = crypto.randomUUID();
      const asked = options.model.respond({
        requestId: mine.requestId,
        ...(model ? { model } : {}),
        instructions:
          voiced && voice
            ? `${instructions}\n\n${VOICE}\n\n${head(voice, TOLD.voice)}`
            : instructions,
        input,
        tools: [ROUTE],
      });
      // A model that never answers a request it was told to cancel holds nothing up.
      asked.catch(() => {});
      const reply = await Promise.race([asked, gone]);
      if (!reply || mine.dropped) return undefined;
      const text = reply.output
        .flatMap((item) => (item.type === "message" ? [item.content] : []))
        .join("");
      const call = reply.output.find(
        (item) => item.type === "function_call" && item.name === ROUTE.name,
      );
      let routed: { work?: unknown; title?: unknown; stop?: unknown } | undefined;
      if (call?.type === "function_call")
        try {
          routed = (JSON.parse(call.arguments) ?? {}) as NonNullable<typeof routed>;
        } catch {
          // Arguments that don't read: as a call that says nothing.
          routed = {};
        }
      return { ...(text.trim() ? { text } : {}), routed };
    } finally {
      if (asking === mine) asking = undefined;
    }
  };
  /** The turn of the work that `stop` names, if it was told of as in a turn. */
  const turnOf = (stop: unknown, works: Listed[]) => works.find(({ id }) => id === stop)?.turn;

  return {
    /**
     * Decide on a thread, given what was said in it and the work there is. `written` is given its
     * text as the model writes it. `last` is the work last active there, for a message no work in
     * a turn took. Nothing is said for a decision that is dropped. A request the model refuses
     * rejects, as it refused.
     */
    async decide(
      said: Said[],
      works: Listed[],
      written: (text: string) => void,
      back: Returned[],
      last?: string,
    ): Promise<Decided | undefined> {
      const asked = await ask(MAIN_INSTRUCTIONS, true, put(said, works, back, last), written);
      if (!asked) return undefined;
      const { text, routed } = asked;
      const answered: Decided = text === undefined ? {} : { answer: text };
      // Text and no call: it answered, and nothing is placed.
      if (!routed && text !== undefined) return answered;
      // A call that names work to stop only stops: nothing is placed.
      if (typeof routed?.stop === "string" && routed.stop !== "") {
        const turn = turnOf(routed.stop, works);
        return {
          ...answered,
          stop: { work: routed.stop, ...(turn === undefined ? {} : { turn }) },
        };
      }
      if (works.some(({ id }) => id === routed?.work))
        return { ...answered, placed: { work: routed?.work as string } };
      // Anything else starts new work, titled by what came in if the model gave no title.
      if (typeof routed?.work === "string" && routed.work !== "")
        options.log.warn("The main loop named work there isn't; it is new work.", {
          work: head(routed.work, 128),
        });
      const title = titled(typeof routed?.title === "string" ? routed.title : "");
      const newest = said.findLast(({ role }) => role === "user")?.text ?? "";
      // A picture sent by itself has no words to name it by.
      return { ...answered, placed: { title: title || titled(newest) || "A picture" } };
    },
    /**
     * Hear a message that joined a turn of each of `works`, which have it: the main loop may only
     * stop one of those turns, and is not told who it speaks as. It gives the turn to stop, with
     * what to say where the message was said; or, when several were listed and it stops none,
     * what it wrote, which says which are in a turn; or none, when it does neither or the
     * request is dropped. A request the model refuses rejects, as it refused.
     */
    async hear(
      text: string,
      works: Listed[],
    ): Promise<{ say: string; stop?: { work: string; turn: number } } | undefined> {
      const asked = await ask(
        HEARD_INSTRUCTIONS,
        false,
        put([{ role: "user", text }], works),
        () => {},
      );
      if (!asked) return undefined;
      const work = works.find(({ id }) => id === asked.routed?.stop);
      if (work?.turn !== undefined)
        return { say: asked.text ?? stopWord(true), stop: { work: work.id, turn: work.turn } };
      return works.length > 1 && asked.text !== undefined ? { say: asked.text } : undefined;
    },
    /** Text the model writes while it answers `requestId`, if that is the request out now. */
    delta(requestId: string, text: string) {
      if (asking?.requestId === requestId) asking.written(text);
    },
    /** Drop the request out now: it is cancelled, and it says nothing. */
    async cancel() {
      const cut = asking;
      if (!cut) return;
      cut.drop();
      if (cut.requestId) await options.model.cancel({ requestId: cut.requestId }).catch(() => {});
    },
  };
}
