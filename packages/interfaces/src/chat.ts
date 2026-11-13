import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { Pictures } from "./picture.js";

const MessageId = z.string().min(1).max(128);
const ChatId = z.string().min(1).max(128);
/** The longest title a chat has. */
export const CHAT_TITLE_MAX = 200;
/** One chat of an agent's, where a call names it. */
const OnChat = z.object({ chat: ChatId });
/** What a message may hold: `send` takes it with words, or with a picture at least. */
const Sent = z.object({
  chat: ChatId.optional(),
  text: z.string().max(100_000).optional(),
  images: Pictures.optional(),
});

/**
 * A tool call a `tool` message stood for: its name, whether it was `running` or ended `done` or
 * `refused`, and its input and output as text. Never sent: kept only for views that still read
 * it.
 */
export const ChatTool = z.object({
  name: z.string().min(1).max(128),
  state: z.enum(["running", "done", "refused"]),
  input: z.string().max(100_000).optional(),
  output: z.string().max(100_000).optional(),
});

/**
 * One message of a chat: what the person said (`user`), or the agent's reply (`assistant`). The
 * `tool` role and `tool` member are never sent: kept only for views that still read them.
 */
export const ChatMessage = z.object({
  id: MessageId,
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().max(100_000),
  /** An ISO 8601 time. */
  at: z.string().max(64),
  tool: ChatTool.optional(),
  /** The pictures the person sent with it. */
  images: Pictures.optional(),
});
/** What the agent is doing: `working` while it answers anything, in any chat. */
export const ChatStatus = z.object({ state: z.enum(["idle", "working"]) });
/**
 * Why a message in a chat got no answer. `code` is the refusal's code, such as the model's
 * `usage_limit` or `not_signed_in`, so a view can offer the right action.
 */
const ChatProblem = z.object({ code: z.string().max(128), message: z.string().max(2000) });

/**
 * One of an agent's chats, as a list shows it. Its `title` is its first message's first line until
 * it is renamed. `latest` is its newest reply, so a view can tell what is new without reading the
 * chat. `problem` is there while a message in it got no answer, until its next reply.
 */
export const ChatEntry = z.object({
  id: ChatId,
  title: z.string().max(CHAT_TITLE_MAX),
  /** When it started: an ISO 8601 time. */
  at: z.string().max(64),
  latest: z.object({ id: MessageId, at: z.string().max(64) }).optional(),
  problem: ChatProblem.optional(),
  archived: z.boolean(),
});

/**
 * `chat@1`: an agent's chats. A chat is the messages sent in it and nothing more: the person's,
 * and the agent's replies. What the agent does to answer is not in it. `send` with no `chat`
 * starts one, and with one, goes on in it. Messages and streaming text arrive as events, each
 * naming its chat. What works is the agent, not a chat: `status` says when it starts and
 * when it is done. Events are live only: `history` is a chat's record, `state` the agent's status
 * now, and `list` the chats. A provider that can't take
 * a message now refuses it `busy`. A call naming a chat the agent doesn't have is refused
 * `unknown`.
 */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Send this message in `chat`, or in a new chat; the result says which. A message is words,
     * pictures or both. The agent answers it in that chat. An archived chat takes a message like
     * any other, and stays archived. Refused `busy` when the provider can't take it now.
     */
    send: method({
      input: z.union([
        Sent.extend({ text: z.string().min(1).max(100_000).regex(/\S/) }),
        // Or one picture at least, with any words or none.
        Sent.extend({ images: Pictures.min(1) }),
      ]),
      output: z.object({ chat: ChatId, messageId: MessageId }),
    }),
    /**
     * A chat's messages before `before` (or the newest), oldest first; `more` when older ones
     * remain. A provider returns fewer than `limit` when a page would not fit one frame.
     */
    history: method({
      input: OnChat.extend({
        before: MessageId.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ messages: z.array(ChatMessage), more: z.boolean() }),
    }),
    /** The agent's status now, as its latest `status` event said; for a view opened late. */
    state: method({ input: z.object({}), output: ChatStatus }),
    /**
     * The chats after `before` in the list (or from its start), newest first by their last
     * message; `more` when others follow. Those not archived, or with `archived`, those that are.
     * A message sent in a chat moves it to the front, so a later page may repeat a chat that
     * moved, and never leaves out one that didn't: the `chat` event says each that did. A `before`
     * the agent doesn't have gives an empty page.
     */
    list: method({
      input: z.object({
        archived: z.boolean().optional(),
        before: ChatId.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ chats: z.array(ChatEntry), more: z.boolean() }),
    }),
    /** Give a chat another title: one line, so only the first line of `title` is kept. */
    rename: method({
      input: OnChat.extend({ title: z.string().min(1).max(CHAT_TITLE_MAX).regex(/\S/) }),
      output: z.object({}),
    }),
    /** Put a chat among the archived ones, or back. It stays readable either way. */
    archive: method({ input: OnChat.extend({ archived: z.boolean() }), output: z.object({}) }),
  },
  events: {
    message: event(ChatMessage.extend({ chat: ChatId })),
    /**
     * Text of the assistant message `id`, as it streams. Its `message` event follows, unless the
     * reply was given up as it was written: a view lets go of pieces no message has come for
     * once the agent is `idle`, and of any that come after their message.
     */
    delta: event(z.object({ chat: ChatId, id: MessageId, text: z.string() })),
    /** The agent's status, when it changes. */
    status: event(ChatStatus),
    /**
     * A chat as it now is: it was started, renamed or archived, a message was sent in it, or one
     * got no answer.
     */
    chat: event(ChatEntry),
  },
});
