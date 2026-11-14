import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { Pictures } from "./picture.js";

const MessageId = z.string().min(1).max(128);
/**
 * The most characters a message's text has, counted as a string's length counts them. A page says
 * so before it sends one longer, keeping the text; past it, `send` is refused `invalid`.
 */
export const MESSAGE_TEXT_MAX = 100_000;
/** What a message may hold: `send` takes it with words, or with a picture at least. */
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

/** One message of a conversation: what the party said (`user`), or the agent's reply (`assistant`). */
export const ChatMessage = z.object({
  id: MessageId,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MESSAGE_TEXT_MAX),
  /** An ISO 8601 time. */
  at: z.string().max(64),
  /** The pictures the party sent with it. */
  images: Pictures.optional(),
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
 * the caller is the party. A conversation is what was said in it and nothing more: the party's
 * messages and the agent's replies. What the agent does to answer is not in it. Its first message
 * makes it. What works is the agent, not a conversation: `status` says when it starts and when it
 * is done. Events are live only: `history` is a conversation's record, `state` the agent's status
 * now, and `list` its conversations. A provider that can't take a message now refuses it `busy`.
 */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Send this message in the caller's conversation with the agent, which it makes if there is
     * none. A message is words, pictures or both. The agent answers it there. Refused `busy` when
     * the provider can't take it now.
     */
    send: method({
      input: z.union([
        Sent.extend({ text: z.string().min(1).max(MESSAGE_TEXT_MAX).regex(/\S/) }),
        // Or one picture at least, with any words or none.
        Sent.extend({ images: Pictures.min(1) }),
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
     * A conversation as it now is, to its party and to the person: it began, a message was sent in
     * it, or one got no answer.
     */
    chat: event(Conversation),
  },
});
