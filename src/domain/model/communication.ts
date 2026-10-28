/**
 * The communication standard: the records of progress, messages and claims, and the requests,
 * results and descriptions of the built-ins that write and read them.
 *
 * Who can read something and who it waits on are separate:
 * - **Progress** is where an actor stands, a snapshot it replaces. Anyone in the organization reads
 *   it, and it waits on nobody.
 * - **A question** is a message with options or one that expects a reply. Anyone reads it and its
 *   answer, and it waits on its addressee until answered.
 * - **Any other message** is private to its two parties, the manager of either, and the root. It
 *   waits on its addressee until read.
 * - **A claim** says which actor holds a shared resource. Anyone sees it.
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

export const Option = z
  .strictObject({
    label: Label.describe("Unique within the question."),
    detail: text(300).optional(),
  })
  .meta({ id: "Option" });

export const Message = z
  .strictObject({
    id: Id,
    from: Id.describe("The sender, as its credential identified it."),
    to: Id.describe("The addressee, on whom it is pending."),
    text: text(LIMITS.message),
    links: z.array(Link),
    options: z.array(Option).describe("A question's options; empty for none."),
    recommendation: Label.nullable().describe("The label of the option the sender recommends."),
    expects_reply: z
      .boolean()
      .describe("True for a question: it is pending on its addressee until answered."),
    answerer: Id.nullable().describe(
      "The only actor that may answer the question. Null lets its addressee answer, or the root step in.",
    ),
    cause: Id.nullable().describe(
      "The message that led to this one, such as a report's question this one escalates.",
    ),
    reply_to: z
      .array(Id)
      .describe("The messages this one replies to. It answers each question among them."),
    choice: Label.nullable().describe("The option it chose, of the questions it answers."),
    public: z
      .boolean()
      .describe(
        "Anyone in the organization reads it: a question, or a reply that answers one. Otherwise only its two parties, the manager of either, and the root read it.",
      ),
    answer: Id.nullable().describe("For a question, the reply that answered it; null while open."),
    created_at: Timestamp,
    read_at: Timestamp.nullable().describe("When its addressee read it or replied to it."),
  })
  .meta({ id: "Message", description: "A message between two actors, or a question." });

export const Resource = text(LIMITS.id).describe(
  "A shared resource, by the name the organization knows it by, such as dev-cluster.",
);

export const Claim = z
  .strictObject({
    resource: Resource,
    holder: Id,
    note: Text.describe("What the holder is doing with it."),
    until: Timestamp.nullable().describe("When it ends by itself; null holds it until released."),
    claimed_at: Timestamp,
  })
  .meta({ id: "Claim", description: "A shared resource an actor holds, which anyone sees." });

const Names = z
  .record(z.string(), z.string())
  .describe("The path of each actor the records name, by id; for the root, its name.");

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
  created_at: true,
  closed_at: true,
})
  .extend({
    progress: Progress.pick({ version: true, state: true, summary: true, updated_at: true })
      .nullable()
      .describe("Its progress state and summary; null until it sets them."),
    questions: z
      .array(Message)
      .describe("Its open questions: those it asked that are not answered yet, oldest first."),
    interfaces: z
      .array(z.string())
      .describe("Its exposed interfaces you can call, by the names you call them."),
    claims: z.array(Claim).describe("The shared resources it holds now."),
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
    questions: z.array(Message).describe("Its open questions, oldest first."),
    history: z.array(Progress).describe("Earlier versions, newest first, as many as asked."),
    names: Names,
  })
  .meta({ id: "ProgressResult" });

export const MessageSend = z
  .strictObject({
    to: Id.optional().describe(
      "The addressee: your manager or a direct report, or anyone for the root. Default: your manager, or for a reply, the sender of what it replies to.",
    ),
    text: text(LIMITS.message),
    links: z.array(Link).max(20).optional(),
    options: z.array(Option).min(2).max(6).optional().describe("Makes it a question with these."),
    recommendation: Label.optional().describe("The label of the option you recommend."),
    expects_reply: z.boolean().optional().describe("Makes it a question, with options or without."),
    answerer: Id.optional().describe(
      "For a question, the only actor that may answer it, such as the root for an approval only the user gives.",
    ),
    cause: Id.optional().describe(
      "A message to you that led to this one, such as your report's question this one escalates.",
    ),
    reply_to: z
      .array(Id)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "The messages this replies to. It marks them read and answers each question among them.",
      ),
    choice: Label.optional().describe(
      "For a reply, the option chosen, which each question it answers with options must offer.",
    ),
  })
  .superRefine((request, context) => {
    const labels = (request.options ?? []).map((option) => option.label);
    const question = labels.length > 0 || request.expects_reply === true;
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
    if (request.answerer !== undefined && !question) {
      context.addIssue({ code: "custom", path: ["answerer"], message: "only a question has one" });
    }
    if (request.choice !== undefined && request.reply_to === undefined) {
      context.addIssue({ code: "custom", path: ["choice"], message: "only a reply has one" });
    }
  })
  .meta({ id: "MessageSend" });

export const MessagesRequest = z
  .strictObject({
    box: z
      .enum(["in", "out"])
      .optional()
      .describe("in: addressed to the actor; out: sent by it. Default: in, or with reply_to, any."),
    pending: z
      .boolean()
      .default(false)
      .describe(
        "Only those still pending on their addressee: a message until read, a question until answered.",
      ),
    actor: Id.optional().describe("Whose box. Default: you."),
    with: Id.optional().describe("Only those between the actor and this other party."),
    reply_to: Id.optional().describe("Only replies to this message."),
    since: Timestamp.optional().describe("Only those sent after this time."),
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
  .strictObject({ messages: z.array(Message).describe("Newest first."), names: Names })
  .meta({ id: "MessagesResult" });

export const MessageRead = z
  .strictObject({ ids: z.array(Id).min(1).max(200).describe("Messages addressed to you.") })
  .meta({ id: "MessageRead" });

export const ClaimRequest = z
  .strictObject({
    resource: Resource,
    note: Text.describe("What you are doing with it, for whoever wants it next."),
    until: Timestamp.optional().describe("When the claim ends by itself. Default: when released."),
  })
  .meta({ id: "ClaimRequest" });

export const ReleaseRequest = z.strictObject({ resource: Resource }).meta({ id: "ReleaseRequest" });

export const COMMUNICATION = {
  progress_set: {
    writes: true,
    rootOnly: false,
    request: ProgressSet,
    response: Progress,
    description: `Set where you stand, for anyone in the organization to read: replace the fields you give of your progress.

state is running, waiting, blocked or review. summary is a short current paragraph at your own level. items are your open workstreams or steps, each with a title and a state; done ones drop off. links are what you produced. Fields you leave out keep their value, and each set keeps the one before as history. Publish only what you choose: your transcript and reasoning stay with you.`,
  },
  team: {
    writes: false,
    rootOnly: false,
    request: TeamRequest,
    response: Team,
    description: `Explore the organization: a position and its reports, each with its purpose, whether it is online, its progress state and summary, its open questions, the shared resources it holds, and its interfaces you can call.

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
    description: `Send a message, ask a question, or reply.

A message goes to your manager or a direct report; the root may send to anyone. It is private to its two parties, the manager of either and the root, and is pending on its addressee until read. With options or expects_reply it is a question instead: anyone may read it and its answer, and it is pending on its addressee until answered.

To carry a question up that you cannot settle, ask your manager a new question in your own terms, with your recommendation, and cause naming the question it escalates; once answered, answer the original. answerer names the only actor that may answer, as the root for an approval only the user gives. Otherwise a question's addressee answers it, or the root steps in.

A reply names in reply_to the messages it answers, one or more, and goes to their sender. It marks them read, and answers each question among them. choice picks one of their options; the text may reject them instead.`,
  },
  messages: {
    writes: false,
    rootOnly: false,
    request: MessagesRequest,
    response: MessagesResult,
    description: `List the messages and questions you may see, newest first. It changes nothing.

Default: those addressed to you. box out lists those you sent, and actor another actor's box, as far as you may see it. pending keeps those still waiting on their addressee. reply_to lists the replies to one message, as the answer to a question. With wait, hold until a match exists or the seconds run out.`,
  },
  message_read: {
    writes: true,
    rootOnly: false,
    request: MessageRead,
    response: MessagesResult,
    description: "Mark messages addressed to you read. Each sender sees when.",
  },
  claim: {
    writes: true,
    rootOnly: false,
    request: ClaimRequest,
    response: Claim,
    description: `Claim a shared resource, such as a release lane or a cluster, while you use it.

Anyone sees current claims in team. Claiming a resource another actor holds is refused, naming the holder; claiming one you hold renews it. until ends the claim by itself, and closing an actor ends its claims.`,
  },
  release: {
    writes: true,
    rootOnly: false,
    request: ReleaseRequest,
    response: Claim,
    description: "Release a shared resource you hold; the root may release any.",
  },
} as const satisfies Record<string, BuiltinSpec>;
