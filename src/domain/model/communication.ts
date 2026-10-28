/**
 * The communication standard: the records of progress, questions and messages, and the requests,
 * results and descriptions of the built-ins that write and read them.
 *
 * Who can read something and who it waits on are separate:
 * - **Progress** is where an actor stands, a snapshot it replaces. Anyone in the organization reads
 *   it, and it waits on nobody.
 * - **A question** is published, like progress: anyone reads it and its answer. It names one
 *   addressee, on whom it waits until answered.
 * - **A message** is private correspondence between two actors, read by its parties, the manager
 *   of either, and the root. It waits on its addressee until read.
 *
 * Questions and messages share one cursor, a sequence number that a question takes again when it
 * is answered, so one `since` finds new messages, new questions and new answers.
 */

import { z } from "zod";
import type { BuiltinSpec } from "./builtins.ts";
import { Actor, Id, LIMITS, MAX_WAIT_SECONDS, Text, Timestamp } from "./records.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const Title = text(LIMITS.title);
const Label = text(80);
const Summary = z.string().trim().max(LIMITS.summary);

export const ProgressState = z.enum(["running", "waiting", "blocked", "review"]);

/** An item's state. Done items drop off, so there is no done. */
export const ItemState = z.enum(["planned", "running", "waiting", "blocked", "review"]);

export const Link = z
  .strictObject({
    url: z
      .url({ protocol: /^(https?|file)$/ })
      .max(2000)
      .describe("An http, https or file URL."),
    title: Title.optional().describe("What it is, such as a pull request's title."),
  })
  .meta({ id: "Link" });

export const WaitsOn = z
  .union([
    z
      .strictObject({ actor: Id, item: Title.optional() })
      .describe("An actor, or with item, the item of its progress with that title."),
    z.strictObject({ item: Title }).describe("Another item of the same progress, by its title."),
    z.strictObject({ text: Text }).describe("Anything else, such as a release elsewhere."),
  ])
  .meta({ id: "WaitsOn" });

export const Item = z
  .strictObject({
    title: Title.describe("Unique within the progress."),
    state: ItemState,
    summary: text(LIMITS.text).optional(),
    links: z.array(Link).max(10).optional(),
    owner: Id.optional().describe(
      "The actor that holds it: a report, for drill-down, or one elsewhere, for work handed off but still tracked.",
    ),
    waits_on: z.array(WaitsOn).min(1).max(10).optional().describe("What blocks it."),
  })
  .meta({ id: "Item", description: "An open workstream or step." });

export const Progress = z
  .strictObject({
    actor: Id,
    version: z.number().int().min(1).describe("1 for the first set, and one more for each after."),
    state: ProgressState,
    summary: Summary.describe("A short current paragraph in plain text; line breaks are kept."),
    items: z.array(Item).max(50).describe("The open workstreams or steps."),
    links: z
      .array(Link)
      .max(20)
      .describe("What the actor produced: pull requests, pages, documents."),
    updated_at: Timestamp,
  })
  .meta({
    id: "Progress",
    description: "Where an actor stands, as it last set it. Anyone in the organization reads it.",
  });

export const Cursor = z
  .number()
  .int()
  .min(0)
  .describe("A place in the sequence questions and messages share; a greater one is newer.");

export const Option = z
  .strictObject({
    label: Label.describe("Unique within the question."),
    detail: text(300).optional(),
  })
  .meta({ id: "Option" });

export const QuestionAnswer = z
  .strictObject({
    by: Id.describe(
      "The actor whose credential answered: the addressee, the answerer, the root, or the asker recording the user's words.",
    ),
    choice: Label.nullable().describe("The option chosen; null when the answer is words only."),
    text: text(LIMITS.message).nullable().describe("The answer's words."),
    recorded: z
      .boolean()
      .describe(
        "The asker recorded the user's words, given in its own session: the user did not answer through the core.",
      ),
    at: Timestamp,
  })
  .meta({ id: "QuestionAnswer", description: "How a question was answered, and by whom." });

export const Question = z
  .strictObject({
    id: Id,
    cursor: Cursor.describe(
      "Its place in the sequence: where it was asked, or once answered, where.",
    ),
    from: Id.describe("The asker."),
    to: Id.describe("The addressee, on whom it is pending until answered."),
    text: text(LIMITS.message),
    links: z.array(Link),
    options: z.array(Option).describe("Empty for an open question."),
    recommendation: Label.nullable().describe("The label of the option the asker recommends."),
    answerer: Id.nullable().describe(
      "The only actor besides the root that may answer it. Null lets its addressee answer, or the root step in.",
    ),
    cause: Id.nullable().describe("The question this one carries up, in the asker's own terms."),
    answer: QuestionAnswer.nullable().describe("Null while open."),
    created_at: Timestamp,
  })
  .meta({
    id: "Question",
    description: "A question an actor published, waiting on its addressee. Anyone reads it.",
  });

export const Message = z
  .strictObject({
    id: Id,
    cursor: Cursor.describe("Its place in the sequence."),
    from: Id.describe("The sender, as its credential identified it."),
    to: Id.describe("The addressee, on whom it is pending until read."),
    text: text(LIMITS.message),
    links: z.array(Link),
    reply_to: Id.nullable().describe("The message this one replies to."),
    created_at: Timestamp,
    read_at: Timestamp.nullable().describe("When its addressee read it, or replied to it."),
  })
  .meta({
    id: "Message",
    description:
      "A private message between two actors, read by its parties, the manager of either, and the root.",
  });

const Names = z
  .record(z.string(), z.string())
  .describe("The path of each actor the records name, by id; for the root, its name.");

const Newest = Cursor.describe(
  "The newest cursor when this read ran: give it as since to see only what comes after.",
);

/** Item titles are unique, and an item waits only on items that are there. */
const uniqueItems = (items: z.output<typeof Item>[], context: z.RefinementCtx) => {
  const titles = items.map((item) => item.title);
  if (new Set(titles).size !== titles.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "titles must be unique" });
  }
  items.forEach((item, index) => {
    for (const waits of item.waits_on ?? []) {
      if ("item" in waits && !("actor" in waits) && !titles.includes(waits.item)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "waits_on"],
          message: `there is no item ${waits.item}`,
        });
      }
    }
  });
};

export const ProgressSet = z
  .strictObject({
    state: ProgressState.optional().describe("Required the first time."),
    summary: Summary.optional().describe(
      "A short current paragraph at your own level, in plain text, never a log.",
    ),
    items: z.array(Item).max(50).optional().describe("Your open workstreams or steps, in order."),
    links: z.array(Link).max(20).optional().describe("What you produced."),
  })
  .superRefine((request, context) => {
    if (request.items) uniqueItems(request.items, context);
  })
  .meta({ id: "ProgressSet" });

export const TeamRequest = z
  .strictObject({
    actor: Id.optional().describe("The position to start from. Default: you."),
    depth: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(1)
      .describe("How many levels of its reports to include; 0 for the position alone."),
  })
  .meta({ id: "TeamRequest" });

export const Position = Actor.pick({
  id: true,
  name: true,
  path: true,
  purpose: true,
  manager: true,
  online: true,
  created_at_attach: true,
  created_at: true,
  closed_at: true,
})
  .extend({
    progress: Progress.pick({ version: true, state: true, summary: true, updated_at: true })
      .nullable()
      .describe("Its progress state and summary; null until it sets them."),
    questions: z.array(Question).describe("Its open questions, oldest first."),
    interfaces: z
      .array(z.string())
      .describe("Its exposed interfaces you can call, by the names you call them."),
  })
  .meta({ id: "Position", description: "A position in the organization, as anyone sees it." });

export const Team = z
  .strictObject({
    root: Id.describe("The root's id, as for a question that only the user may answer."),
    positions: z
      .array(Position)
      .describe(
        "The position first, then its open reports down to the depth, each after its manager.",
      ),
    names: Names,
  })
  .meta({ id: "Team" });

export const ProgressRequest = z
  .strictObject({
    actor: Id,
    history: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe("How many earlier versions to add."),
  })
  .meta({ id: "ProgressRequest" });

export const ProgressResult = z
  .strictObject({
    actor: Id,
    progress: Progress.nullable().describe("Null until the actor sets it."),
    questions: z.array(Question).describe("Its open questions, oldest first."),
    history: z.array(Progress).describe("Earlier versions, newest first, as many as asked."),
    names: Names,
  })
  .meta({ id: "ProgressResult" });

export const QuestionAsk = z
  .strictObject({
    to: Id.optional().describe(
      "The addressee: your manager or a direct report, or anyone for the root. Default: your manager.",
    ),
    text: text(LIMITS.message).describe("The question, with the context its addressee needs."),
    links: z.array(Link).max(20).optional(),
    options: z.array(Option).min(2).max(6).optional(),
    recommendation: Label.optional().describe("The label of the option you recommend."),
    answerer: Id.optional().describe(
      "The only actor besides the root that may answer it, such as the root itself for an approval only the user gives.",
    ),
    cause: Id.optional().describe("A question to you that this one carries up, in your own terms."),
  })
  .superRefine((request, context) => {
    const labels = (request.options ?? []).map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "labels must be unique" });
    }
    if (request.recommendation !== undefined && !labels.includes(request.recommendation)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "must be the label of one of the options",
      });
    }
  })
  .meta({ id: "QuestionAsk" });

export const QuestionAnswerRequest = z
  .strictObject({
    questions: z.array(Id).min(1).max(20).describe("The open questions it answers."),
    choice: Label.optional().describe(
      "The option chosen, which each question with options must offer.",
    ),
    text: text(LIMITS.message)
      .optional()
      .describe("Your words, which may reject the options and reframe."),
    recorded: z
      .boolean()
      .default(false)
      .describe(
        "The user answered in your own session: record their words, quoted in text, for questions you asked.",
      ),
  })
  .superRefine((request, context) => {
    if (request.choice === undefined && request.text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "an answer needs a choice or text",
      });
    }
    if (request.recorded && request.text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "a recorded answer quotes the user's words",
      });
    }
  })
  .meta({ id: "QuestionAnswerRequest" });

export const QuestionsRequest = z
  .strictObject({
    to: Id.optional().describe("Only those addressed to this actor."),
    from: Id.optional().describe("Only those this actor asked."),
    open: z.boolean().default(false).describe("Only those not answered yet."),
    since: Cursor.optional().describe("Only those asked or answered after this cursor."),
    limit: z.number().int().min(1).max(200).default(50),
    wait: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(0)
      .describe("Seconds to hold the read until a match exists, with progress notifications."),
  })
  .meta({ id: "QuestionsRequest" });

export const QuestionsResult = z
  .strictObject({
    questions: z.array(Question).describe("Newest first."),
    cursor: Newest,
    names: Names,
  })
  .meta({ id: "QuestionsResult" });

export const MessageSend = z
  .strictObject({
    to: Id.describe("Any open position, found with team."),
    text: text(LIMITS.message),
    links: z.array(Link).max(20).optional(),
    reply_to: Id.optional().describe(
      "A message between you and the addressee that this one replies to. A reply marks it read.",
    ),
  })
  .meta({ id: "MessageSend" });

export const MessagesRequest = z
  .strictObject({
    box: z
      .enum(["in", "out"])
      .default("in")
      .describe("in: those addressed to the actor; out: those it sent."),
    unread: z.boolean().default(false).describe("Only those their addressee has not read."),
    actor: Id.optional().describe("Whose box. Default: you."),
    with: Id.optional().describe("Only those between the actor and this other party."),
    since: Cursor.optional().describe("Only those sent after this cursor."),
    limit: z.number().int().min(1).max(200).default(50),
    wait: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(0)
      .describe("Seconds to hold the read until a match exists, with progress notifications."),
  })
  .meta({ id: "MessagesRequest" });

export const MessagesResult = z
  .strictObject({
    messages: z.array(Message).describe("Newest first."),
    cursor: Newest,
    names: Names,
  })
  .meta({ id: "MessagesResult" });

export const MessageRead = z
  .strictObject({ ids: z.array(Id).min(1).max(200).describe("Messages addressed to you.") })
  .meta({ id: "MessageRead" });

export const COMMUNICATION = {
  progress_set: {
    writes: true,
    rootOnly: false,
    request: ProgressSet,
    response: Progress,
    description: `Set where you stand, for anyone in the organization to read: replace the fields you give of your progress.

state is running, waiting, blocked or review. summary is a short current paragraph at your own level. items are your open workstreams or steps, each with a title and a state; done ones drop off. links are what you produced. Fields you leave out keep their value, and each set keeps the one before as history. Publish only what you choose: your transcript and reasoning stay with you.`,
  },
  question_ask: {
    writes: true,
    rootOnly: false,
    request: QuestionAsk,
    response: Question,
    description: `Ask a question, published for anyone to read and pending on its addressee until answered.

It goes to your manager, or to a direct report; the root may ask anyone. To carry up a question you cannot settle, ask your manager a new one in your own terms, with your recommendation, and cause naming the question; once answered, answer the original. answerer names the only actor besides the root that may answer, as the root for an approval only the user gives. Wait for the answer with questions, from you and since a cursor.`,
  },
  question_answer: {
    writes: true,
    rootOnly: false,
    request: QuestionAnswerRequest,
    response: QuestionsResult,
    description: `Answer one or more open questions addressed to you; the root may answer any.

A question that names an answerer is answered by that actor or the root alone. choice is optional, and text may reject the options and reframe; either way the question is answered. When the user answers in your own session, answer your own question with recorded and their words quoted in text: it is marked as recorded by you. An approval with an answerer is never recorded: the user answers it through the core.`,
  },
  questions: {
    writes: false,
    rootOnly: false,
    request: QuestionsRequest,
    response: QuestionsResult,
    description: `List questions, newest first, as anyone may. It changes nothing.

What waits on you is to you and open. New answers to yours are from you since a cursor. With wait, hold until a match exists or the seconds run out.`,
  },
  team: {
    writes: false,
    rootOnly: false,
    request: TeamRequest,
    response: Team,
    description: `Explore the organization: a position and its reports, each with its purpose, whether it is online, its progress state and summary, its open questions, and its interfaces you can call.

Default: you and your direct reports. Anyone may explore any position.`,
  },
  progress: {
    writes: false,
    rootOnly: false,
    request: ProgressRequest,
    response: ProgressResult,
    description: `Read an actor's full progress, with its open questions. Anyone may read anyone's.

history adds that many earlier versions.`,
  },
  message_send: {
    writes: true,
    rootOnly: false,
    request: MessageSend,
    response: Message,
    description: `Send a private message to any open position, found with team: findings, evidence, a brief or a handoff.

Its two parties, the manager of either, and the root may read it. It is pending on its addressee until read, and you see when it is. To ask for a decision, ask a question instead.`,
  },
  messages: {
    writes: false,
    rootOnly: false,
    request: MessagesRequest,
    response: MessagesResult,
    description: `List the messages you may see, newest first. It changes nothing.

Default: those addressed to you. box out lists those you sent, and actor another actor's box, as far as you may see it. With wait, hold until a match exists or the seconds run out; since a cursor, that is a new message.`,
  },
  message_read: {
    writes: true,
    rootOnly: false,
    request: MessageRead,
    response: MessagesResult,
    description: "Mark messages addressed to you read. Each sender sees when.",
  },
} as const satisfies Record<string, BuiltinSpec>;
