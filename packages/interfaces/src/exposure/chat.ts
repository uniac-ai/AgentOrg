import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { Pictures } from "./picture.js";

const MessageId = z.string().min(1).max(128);
/**
 * The most characters a message's text has, counted as a string's length counts them. A page says
 * so before it sends one longer, keeping the text; past it, `send` is refused `invalid`.
 */
export const MESSAGE_TEXT_MAX = 100_000;
/**
 * What a message may hold: `send` takes it with words, or with a picture at least, or as a card's
 * answer alone.
 */
const Sent = z.object({
  text: z.string().max(MESSAGE_TEXT_MAX).optional(),
  images: Pictures.optional(),
});
/**
 * Who a conversation is with: that party's Actor id, as the Hub names a caller. The person may
 * reach all of the agent's work from their conversation; a message in another party's reaches
 * only the work that follows that conversation, which alone the agent routes it into or stops.
 */
const With = z.string().min(1).max(128);
/** The most of a message's text a conversation's entry carries. */
export const LATEST_TEXT_MAX = 200;
/** The most characters a step's words have. */
export const STEP_MAX = 200;
/** The most characters a reaction has: one emoji, a sequence joined into one included. */
export const REACTION_MAX = 16;
/** The most questions a card asks, and the most choices each question offers. */
export const ASK_MAX = 4;
/** The most characters of a choice's label, of the line under it, of a question, and of its tab. */
export const ASK_TEXT_MAX = { label: 48, detail: 120, question: 200, header: 12 } as const;

/** A choice on a card: its label, sent as said when picked, and a line under it, never sent. */
const Choice = z.strictObject({
  label: z.string().min(1).max(ASK_TEXT_MAX.label),
  detail: z.string().min(1).max(ASK_TEXT_MAX.detail).optional(),
});
/**
 * A question on a card: its words, if the message above it isn't the question; its tab's name; and
 * one to four choices, one of which is picked.
 */
const Question = z.strictObject({
  question: z.string().min(1).max(ASK_TEXT_MAX.question).optional(),
  header: z.string().min(1).max(ASK_TEXT_MAX.header).optional(),
  choices: z.array(Choice).min(1).max(ASK_MAX),
});
/** A question of which several choices may be picked. */
const Many = Question.extend({ many: z.literal(true) });
/**
 * A decision card under the agent's message, for its party to answer by picking, in one of three
 * forms:
 * - one question, a tap on which is the answer, final, unless `confirm`: then a tap selects, and a
 *   confirm sends it;
 * - one question of which several may be picked, always confirmed;
 * - two to four questions, each on a tab named by its `header`, any of them taking `many`, always
 *   confirmed.
 * It is open until it is answered, until the party sends anything after it, or until a newer card
 * comes; then it stays, passed over.
 */
export const Ask = z.union([
  z.strictObject({ questions: z.array(Question).length(1), confirm: z.literal(true).optional() }),
  z.strictObject({ questions: z.array(Many).length(1) }),
  z.strictObject({
    questions: z
      .array(
        z
          .union([Question, Many])
          .and(z.object({ header: z.string().min(1).max(ASK_TEXT_MAX.header) })),
      )
      .min(2)
      .max(ASK_MAX),
  }),
]);
/**
 * A card's answer: the card, by its message's id, and for each of its questions in order, the
 * choices picked, by their place, one unless the question takes `many`.
 */
export const Answer = z.strictObject({
  to: MessageId,
  picks: z
    .array(
      z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(ASK_MAX - 1),
        )
        .min(1)
        .max(ASK_MAX),
    )
    .min(1)
    .max(ASK_MAX),
});

/**
 * What became of a message the party said, the latest said of it:
 * - `taken`: the agent has read it and is at work on it. `step` is said only with it: the words of
 *   the step the agent is at, with none when it is at no step it keeps. `taken` is said again as
 *   the step changes, and never after `answered` or `closed`.
 * - `answered`: a reply to it was sent. It is said once.
 * - `closed`: the agent is doing nothing for it now, with no answer. It may come with no `taken`
 *   before it, for a message the agent never read. `answered` may still follow it.
 *
 * The agent is at work on a message while its latest is `taken`. A message with none has had
 * nothing said of it: it is not taken yet, or was said before any of this was.
 */
export const MessageProgress = z.object({
  state: z.enum(["taken", "answered", "closed"]),
  step: z.string().max(STEP_MAX).optional(),
  /**
   * The emoji the agent closed the message with, when it closed it with no reply and gave one: a
   * reaction on it, which stays whatever is said of it after. It notifies no one. It comes with
   * the close; a later `progress` of the same message doesn't say it again, so a view keeps the one
   * it got, as `history` does.
   */
  reaction: z.string().min(1).max(REACTION_MAX).optional(),
});

/** One message of a conversation: what the party said (`user`), or the agent's reply (`assistant`). */
export const ChatMessage = z.object({
  id: MessageId,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MESSAGE_TEXT_MAX),
  /** An ISO 8601 time. */
  at: z.string().max(64),
  /** The pictures the party sent with it. */
  images: Pictures.optional(),
  /** What became of it, the latest said: the party's messages only. */
  progress: MessageProgress.optional(),
  /** A decision card under it: the agent's messages only. */
  ask: Ask.optional(),
  /**
   * The card it answers, and what was picked: the party's message that answers one. Its text is
   * what was picked, as the provider writes it: for one question, the labels joined by ", "; for
   * several, a line for each, "header: labels". A view shows the pick on the card, and no bubble
   * of the party's for this message.
   */
  answer: Answer.optional(),
});
/** What the agent is doing: `working` while it answers anything, in any conversation. */
export const ChatStatus = z.object({ state: z.enum(["idle", "working"]) });
/**
 * Why a message in a conversation got no answer. `code` is the refusal's code, such as the
 * model's `usage_limit` or `not_signed_in`, so a view can offer the right action.
 */
const ChatProblem = z.object({ code: z.string().max(128), message: z.string().max(2000) });

/**
 * One of an agent's conversations, as a list shows it: who it is with, when it began, and its
 * latest message, the head of whose text it carries. `problem` is there while a message in it got
 * no answer, until its next reply.
 */
export const Conversation = z.object({
  with: With,
  /** When it began: an ISO 8601 time. */
  at: z.string().max(64),
  latest: z
    .object({
      id: MessageId,
      at: z.string().max(64),
      role: z.enum(["user", "assistant"]),
      text: z.string().max(LATEST_TEXT_MAX),
    })
    .optional(),
  problem: ChatProblem.optional(),
});

/**
 * `chat@1`: an agent's conversations, one with each party that talks to it, found by who speaks:
 * the caller is the party. A conversation is what was said in it: the party's messages and the
 * agent's replies, with what became of each message the party said and the step the agent is at
 * on it. Nothing else the agent does to answer is in it. Its first message makes it. What works
 * is the agent, not a conversation: `status` says when it starts and when it is done. Events are
 * live only: `history` is a conversation's record, `state` the agent's status now, and `list` its
 * conversations. A provider that can't take a message now refuses it `busy`.
 */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Send this message in the caller's conversation with the agent, which it makes if there is
     * none. A message is words, pictures or both; or a card's answer, sent alone, whose text the
     * provider writes from the labels picked. An answer beside words or pictures isn't one: the
     * message is an ordinary one. The agent answers it there. Refused `busy` when the provider
     * can't take it now. An answer is refused `state` when its card isn't open, or `to` is no
     * card; and `invalid` unless it picks, for each of the card's questions in order, choices the
     * question has, once each, and exactly one where it doesn't take `many`.
     */
    send: method({
      input: z.union([
        Sent.extend({ text: z.string().min(1).max(MESSAGE_TEXT_MAX).regex(/\S/) }),
        // Or one picture at least, with any words or none.
        Sent.extend({ images: Pictures.min(1) }),
        // Or a card's answer.
        z.strictObject({ answer: Answer }),
      ]),
      output: z.object({ messageId: MessageId }),
    }),
    /**
     * A conversation's messages before `before` (or the newest), oldest first; `more` when older
     * ones remain. It is the caller's own; only the person may name another's, `with`, to read it,
     * and anyone else who does is refused `forbidden`. One that hasn't begun has none. A provider
     * returns fewer than `limit` when a page would not fit one frame.
     */
    history: method({
      input: z.object({
        with: With.optional(),
        before: MessageId.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ messages: z.array(ChatMessage), more: z.boolean() }),
    }),
    /** The agent's status now, as its latest `status` event said; for a view opened late. */
    state: method({ input: z.object({}), output: ChatStatus }),
    /**
     * The conversations after `before` in the list (or from its start), the one last written in
     * first; `more` when others follow. The person gets every one, anyone else only their own. A
     * message moves its conversation to the front, so a later page may repeat one that moved, and
     * never leaves out one that didn't: the `chat` event says each that did. A `before` the agent
     * has no conversation with gives an empty page.
     */
    list: method({
      input: z.object({
        before: With.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ conversations: z.array(Conversation), more: z.boolean() }),
    }),
  },
  events: {
    /** A message, to its conversation's party and to the person. */
    message: event(ChatMessage.extend({ with: With })),
    /**
     * Text of the assistant message `id`, as it streams, to its conversation's party and to the
     * person. Its `message` event follows, unless the reply was given up as it was written: a view
     * lets go of pieces no message has come for once the agent is `idle`, and of any that come
     * after their message.
     */
    delta: event(z.object({ with: With, id: MessageId, text: z.string() })),
    /** The agent's status, when it changes. */
    status: event(ChatStatus),
    /**
     * What became of the message `id` the party said, to its conversation's party and to the
     * person: said as it changes, and again as its step changes while it is taken. It replaces
     * what was said of that message before.
     */
    progress: event(MessageProgress.extend({ with: With, id: MessageId })),
    /**
     * A conversation as it now is, to its party and to the person: it began, a message was sent in
     * it, or one got no answer.
     */
    chat: event(Conversation),
  },
});
