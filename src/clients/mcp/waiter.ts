/**
 * The waiter: a short-lived process the session's client starts whenever the session's turn ends.
 * As the session's position, it waits for what the session has not seen: messages to the position
 * that it has not read, questions addressed to it, and answers to the questions it asked. It writes
 * them as one input framed as AgentOrg's, marks the messages read, and ends, which the client takes
 * as the session's next input, waking it when idle. The session's cursor, a place in the sequence
 * questions and messages share, marks what has been delivered.
 *
 * A newer waiter for the same session replaces it, and a replaced waiter ends without writing
 * anything, so two waiters never deliver the same thing. Delivery is still at least once: a waiter
 * stopped between writing and moving the cursor leaves what it wrote for the next.
 */

import type { z } from "zod";
import { type Actor, connectClient } from "../../actor/index.ts";
import type {
  Answer,
  Message,
  MessagesResult,
  Question,
  QuestionsResult,
  Team,
} from "../../domain/model/index.ts";
import { credentials } from "../../home.ts";
import { sessions } from "./sessions.ts";

/** How long each read waits, under the SDK's 60-second limit on a request. */
const WAIT_SECONDS = 50;

export interface WaitOptions {
  coreUrl: string;
  session: string;
  /** True while the client session runs. */
  alive: () => boolean;
  /** Write what is delivered, the session's next input. */
  write: (text: string) => void;
}

/** What the session has not seen, each oldest first. */
export interface News {
  messages: z.output<typeof Message>[];
  /** Open questions addressed to the position. */
  questions: z.output<typeof Question>[];
  /** Questions the position asked, answered by someone else. */
  answers: z.output<typeof Question>[];
  names: Record<string, string>;
  /** The newest place in the sequence every read covered. */
  cursor: number;
}

const value = <T>(answer: Answer): T => {
  if (answer.state === "done") return answer.value as T;
  throw new Error(`${answer.code}: ${answer.message}`);
};

const call = async <T>(client: Actor, name: string, input: Record<string, unknown>) =>
  value<T>(await client.call(name, input, { timeoutMs: ((Number(input.wait) || 0) + 30) * 1000 }));

/** Wait for what the session's position has not seen; true once some was delivered. */
export async function waitForNews(options: WaitOptions): Promise<boolean> {
  const { session } = options;
  const actor = sessions.position(session);
  if (actor === undefined) return false;
  sessions.claimWaiter(session, process.pid);
  const current = () => options.alive() && sessions.waiter(session) === process.pid;
  let client: Actor | undefined;
  let here: Here | undefined;
  // A replaced waiter, or one whose client session ended, stops within a second rather than at
  // the end of its read: closing the connection ends the read.
  const watch = setInterval(() => {
    if (!current()) void client?.close();
  }, 1000);
  try {
    for (let pause = 250; current(); pause = Math.min(pause * 2, 10_000)) {
      const credential = credentials.read(actor);
      if (credential === undefined) return false;
      try {
        client = await connectClient({
          url: options.coreUrl,
          actorId: actor,
          credential,
          name: "agentorg-waiter",
        });
        here ??= await whoAmI(client);
        if (await round(client, here, options, current)) return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, pause));
      } finally {
        await client?.close();
      }
    }
    return false;
  } finally {
    clearInterval(watch);
  }
}

async function whoAmI(client: Actor): Promise<Here> {
  const team = await call<z.output<typeof Team>>(client, "team", { depth: 0 });
  const self = team.positions[0];
  if (self === undefined) throw new Error("the core named no position");
  return { self, root: team.root };
}

/** Wait for anything past the cursor, then deliver what concerns the session; true if any did. */
async function round(
  client: Actor,
  here: Here,
  options: WaitOptions,
  current: () => boolean,
): Promise<boolean> {
  const { session } = options;
  const saved = sessions.cursor(session);
  const cursor = saved === undefined ? undefined : Number(saved);
  if (cursor !== undefined) {
    // Messages to the position, or questions asked or answered anywhere; read sorts them out.
    const held = { since: cursor, wait: WAIT_SECONDS };
    await Promise.race([call(client, "messages", held), call(client, "questions", held)]);
  }
  const news = await read(client, here.self.id, cursor);
  const count = news.messages.length + news.questions.length + news.answers.length;
  if (count > 0) {
    if (!current()) return false;
    options.write(describe(news, here));
    const ids = news.messages.map((message) => message.id);
    if (ids.length > 0) await call(client, "message_read", { ids });
  }
  sessions.advance(session, String(news.cursor));
  return count > 0;
}

/**
 * What the position has not seen past the cursor. Without one, as at a session's first wait, its
 * unread messages and open questions, however old, and no answers.
 */
async function read(client: Actor, self: string, cursor: number | undefined): Promise<News> {
  const since = cursor === undefined ? {} : { since: cursor };
  const [inbox, asked, own] = await Promise.all([
    call<z.output<typeof MessagesResult>>(client, "messages", { unread: true, ...since }),
    call<z.output<typeof QuestionsResult>>(client, "questions", { to: self, open: true, ...since }),
    cursor === undefined
      ? undefined
      : call<z.output<typeof QuestionsResult>>(client, "questions", { from: self, since: cursor }),
  ]);
  const answered = (own?.questions ?? []).filter(
    (question) => question.answer !== null && question.answer.by !== self,
  );
  return {
    messages: inbox.messages.reverse(),
    questions: asked.questions.reverse(),
    answers: answered.reverse(),
    names: { ...inbox.names, ...asked.names, ...own?.names },
    cursor: Math.min(inbox.cursor, asked.cursor, own?.cursor ?? Number.POSITIVE_INFINITY),
  };
}

interface Here {
  self: z.output<typeof Team>["positions"][number];
  root: string;
}

function sender(id: string, names: Record<string, string>, here: Here): string {
  if (id === here.root) return "the user (the root)";
  const path = names[id] ?? id;
  if (id === here.self.manager) return `${path}, your manager`;
  if (path.startsWith(`${here.self.path}.`)) return `${path}, your report`;
  return path;
}

const linked = (links: { url: string; title?: string | undefined }[]) =>
  links.length === 0
    ? []
    : [
        `Links: ${links.map((link) => (link.title ? `${link.title} ${link.url}` : link.url)).join("; ")}`,
      ];

function message(item: z.output<typeof Message>, news: News, here: Here): string {
  const replying = item.reply_to === null ? "" : `, replying to ${item.reply_to}`;
  return [
    `Message ${item.id} from ${sender(item.from, news.names, here)}${replying}:`,
    item.text,
    ...linked(item.links),
  ].join("\n");
}

function question(item: z.output<typeof Question>, news: News, here: Here): string {
  const only =
    item.answerer === null ? "" : `; only ${sender(item.answerer, news.names, here)} may answer`;
  const options = item.options.map((option) => {
    const detail = option.detail === undefined ? "" : ` (${option.detail})`;
    const recommended = option.label === item.recommendation ? ", recommended" : "";
    return `${option.label}${detail}${recommended}`;
  });
  return [
    `Question ${item.id} from ${sender(item.from, news.names, here)}, waiting on you${only}:`,
    item.text,
    ...(options.length === 0 ? [] : [`Options: ${options.join("; ")}`]),
    ...linked(item.links),
  ].join("\n");
}

function answer(item: z.output<typeof Question>, news: News, here: Here): string {
  const given = item.answer;
  if (given === null) return "";
  const chose = given.choice === null ? "" : `, choosing "${given.choice}"`;
  const asked = item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text;
  return [
    `Answer to your question ${item.id} from ${sender(given.by, news.names, here)}${chose}:`,
    ...(given.text === null ? [] : [given.text]),
    `(You asked: ${asked})`,
  ].join("\n");
}

const counted = (count: number, one: string, many: string) =>
  count === 0 ? [] : [count === 1 ? `1 ${one}` : `${count} ${many}`];

/**
 * What the session has not seen, as its input: plainly AgentOrg's, from other positions, never the
 * user typing in the session, with each sender's path and each item's id and kind.
 */
export function describe(news: News, here: Here): string {
  const parts = [
    ...counted(news.messages.length, "message", "messages"),
    ...counted(news.questions.length, "question to you", "questions to you"),
    ...counted(news.answers.length, "answer to your questions", "answers to your questions"),
  ];
  const listed =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
  const position = here.self.path || here.self.name;
  return [
    `AgentOrg delivered ${listed} to your position, ${position} (${here.self.id}). They come from other positions through AgentOrg, not from the user typing in this session; one is the user's own words only when it is from the user (the root). Reply to a message with message_send and reply_to. Answer a question to you with question_answer, or carry it up with question_ask and cause. An id you have seen before is the same item again.`,
    ...news.messages.map((item) => message(item, news, here)),
    ...news.questions.map((item) => question(item, news, here)),
    ...news.answers.map((item) => answer(item, news, here)),
  ].join("\n\n");
}
