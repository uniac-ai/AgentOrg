/**
 * The main loop: one per looper. It is given a thread in which a message waits that no piece of
 * work keeps: one said where nothing follows, or one every piece of work it was given to handed
 * back; and the work there is. It says whose the message is, new work or work there is, or
 * answers it itself when it needs no work, or closes it with no reply when it asks for nothing,
 * or stops a piece of work the message asks to stop. It is also told of a message that joined
 * turns of work, which that work has: then it is given those pieces of work and that message, and
 * may only stop one of them. It does none of the work, and it has two functions to call: `route`,
 * and `no_reply_needed`, which it is not offered for a message that joined turns. Each time is
 * one model request, which holds nothing of those before it but what it is given.
 */
import { NO_REPLY, reactionOf } from "./loop.js";
import { PICTURES_BUDGET, withPictures } from "./record.js";
import { build, type Part } from "./told.js";
import {
  head,
  type Item,
  type Log,
  type Model,
  type Picture,
  type Retry,
  type ToolSpec,
} from "./types.js";
import { GLANCE, JOB, JUDGMENT, PLAIN, RECEIPT, TRUST } from "./words.js";

/**
 * What the main loop is told, before who it speaks as: its job, the receipt it writes for new
 * work, and how it speaks, which is a worker's way for a short answer, plain words, whose words
 * are asks, and the judgment it works by.
 */
export const MAIN_INSTRUCTIONS = [JOB, RECEIPT, GLANCE, PLAIN, TRUST, JUDGMENT].join("\n\n");
/**
 * How who it speaks as is told after its words: as whom it answers, and not what it does, so the
 * front desk does none of what that one is told to do.
 */
const VOICE =
  "When you answer yourself, you speak as the one described below. What that one is told to do is a worker's to do, not yours:";
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
/** The function the main loop calls to place or stop. */
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

/**
 * The function the main loop calls when what came in needs no reply: a worker's, but for all it
 * decides on, which it names by no number.
 */
export const CLOSE: ToolSpec = { ...NO_REPLY, parameters: { type: "object", properties: {} } };

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
  /** For a message it closed with no reply: its call, and what it was told, put in its place. */
  items?: Item[];
}
/**
 * What the main loop decided. `answer` is what it wrote. `placed` is whose what came in is: work
 * it was told of, or new work by its title. `stop` is there when it called to stop work, and
 * then nothing is placed: the turn to cut is the one it was told of, and none when that work was
 * not told of as in a turn. `quiet` is there when it said what came in needs no reply, and wrote
 * and placed nothing: it is closed, with nothing said.
 */
export interface Decided {
  answer?: string;
  placed?: { work: string } | { title: string };
  stop?: { work: string; turn?: number };
  quiet?: true;
  /** With `quiet`: the emoji it closed with, if it gave one. */
  reaction?: string;
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
      said.slice(-TOLD.messages).flatMap(
        ({ role, text, images, items }): Item[] =>
          items ?? [
            {
              type: "message" as const,
              role,
              content: text.length > TOLD.each ? `${head(text, TOLD.each)}…` : text,
              ...(images ? { images } : {}),
            },
          ],
      ),
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
   * Read for each request: which model to ask, none meaning the model's own default, who the main
   * loop speaks as when it answers itself, and the host's blocks it is told after that.
   */
  request(): Promise<{
    model?: string | undefined;
    voice?: string | undefined;
    blocks?: readonly Part[] | undefined;
  }>;
  /** Whether its request out now is being tried again changed. */
  retried(): void;
  log: Log;
}) {
  /**
   * The request out now, whether it was dropped, where its text goes as it is written, and while it
   * is being tried again, which retry begins when.
   */
  let asking:
    | {
        requestId?: string;
        dropped?: true;
        drop(): void;
        written(text: string): void;
        retrying?: Retry | undefined;
      }
    | undefined;
  /** Its request out now is being tried again as `retry` says, or with none, no longer. */
  const retry = (requestId: string, retry: Retry | undefined) => {
    if (asking?.requestId !== requestId || (!asking.retrying && !retry)) return;
    asking.retrying = retry;
    options.retried();
  };

  /**
   * What the main loop is told when it may answer: its words, then who it speaks as, if anyone, and
   * the host's blocks after that, as a worker is told them after the agent's words.
   */
  const spokenAs = (
    instructions: string,
    voice: string | undefined,
    blocks: readonly Part[] = [],
  ) => {
    if (!voice && blocks.length === 0) return instructions;
    const told = build([
      { owner: "looper", text: instructions },
      ...(voice
        ? [
            { owner: "looper", text: VOICE },
            { owner: "host", text: voice, max: TOLD.voice },
          ]
        : []),
      ...blocks,
    ]);
    for (const part of told.cut)
      options.log.warn(
        `What ${part.owner} tells the model was cut from ${part.was} to ${part.kept} characters.`,
      );
    return told.text;
  };

  /**
   * Make one request of the model, offering it `tools`: what it wrote, what it called `route`
   * with, and whether it called `no_reply_needed`. `voiced` is whether it is told who it speaks
   * as. None for a request that is dropped, which the model is then not asked, or told to cancel;
   * one the model refuses rejects, as it refused.
   */
  const ask = async (
    instructions: string,
    voiced: boolean,
    input: Item[],
    written: (text: string) => void,
    tools: ToolSpec[] = [ROUTE],
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
      const { model, voice, blocks } = given.to;
      mine.requestId = crypto.randomUUID();
      const asked = options.model.respond({
        requestId: mine.requestId,
        ...(model ? { model } : {}),
        instructions: voiced ? spokenAs(instructions, voice, blocks) : instructions,
        input,
        tools,
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
      const close = reply.output.find(
        (item) => item.type === "function_call" && item.name === CLOSE.name,
      );
      const quiet = close !== undefined;
      // Its emoji, if it gave one that is: one that isn't is let go, and the message closed all the same.
      let reaction: string | undefined;
      if (close?.type === "function_call")
        try {
          reaction = reactionOf((JSON.parse(close.arguments) as { reaction?: unknown })?.reaction);
        } catch {}
      return { ...(text.trim() ? { text } : {}), routed, quiet, reaction };
    } finally {
      if (asking === mine) asking = undefined;
      if (mine.retrying) {
        mine.retrying = undefined;
        options.retried();
      }
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
      const asked = await ask(MAIN_INSTRUCTIONS, true, put(said, works, back, last), written, [
        ROUTE,
        CLOSE,
      ]);
      if (!asked) return undefined;
      const { text, routed, quiet, reaction } = asked;
      const answered: Decided = text === undefined ? {} : { answer: text };
      // Text and no call: it answered, and nothing is placed; and so with text beside saying it
      // needs no reply, as what it wrote may already be showing.
      if (!routed && text !== undefined) return answered;
      // No text and no `route`, and it needs no reply: closed, with nothing said or placed.
      if (!routed && quiet) return { quiet: true, ...(reaction ? { reaction } : {}) };
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
      if (asking?.requestId !== requestId) return;
      retry(requestId, undefined);
      asking.written(text);
    },
    /** The model request `requestId` is being tried again, if it is the one out now. */
    retry,
    /** While the request out now is being tried again: which retry begins when. */
    retrying: () => asking?.retrying,
    /** Drop the request out now: it is cancelled, and it says nothing. */
    async cancel() {
      const cut = asking;
      if (!cut) return;
      cut.drop();
      if (cut.requestId) await options.model.cancel({ requestId: cut.requestId }).catch(() => {});
    },
  };
}
