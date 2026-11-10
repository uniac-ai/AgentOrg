import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const MessageId = z.string().min(1).max(128);
const ChatModelId = z.string().min(1).max(128);
const ChatId = z.string().min(1).max(128);
/** One chat of an agent's, where a call names it. */
const OnChat = z.object({ chat: ChatId });

/**
 * A tool call a `tool` message stands for: its name, whether it is `running` or ended `done` or
 * `refused`, and its input (the call's JSON arguments) and output (its JSON result, or the
 * refusal), each as text, when there are any.
 */
export const ChatTool = z.object({
  name: z.string().min(1).max(128),
  state: z.enum(["running", "done", "refused"]),
  input: z.string().max(100_000).optional(),
  output: z.string().max(100_000).optional(),
});

/**
 * One message of a chat; `tool` messages tell what the agent did with its tools. A `tool` message
 * may carry `tool`, the call it stands for: it is sent as `running` when the call starts, and again
 * with the same id when it ends. Without `tool`, its `text` says it in one line.
 */
export const ChatMessage = z.object({
  id: MessageId,
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().max(100_000),
  /** An ISO 8601 time. */
  at: z.string().max(64),
  tool: ChatTool.optional(),
});
export const ChatState = z.enum(["idle", "thinking", "tool", "error"]);
/**
 * What the agent is doing. On `error`, `detail.code` is the refusal's code, such as the model's
 * `usage_limit` or `not_signed_in`, so a view can offer the right action.
 */
export const ChatStatus = z.object({
  state: ChatState,
  detail: z.object({ code: z.string(), message: z.string() }).optional(),
});

/**
 * One of an agent's chats, as a list shows it. Its `title` is its first message's first line until
 * it is renamed. `latest` is its newest reply, so a view can tell what is new without reading the
 * chat. `state` is what it was doing when this was said: why a turn failed is in its `status`.
 */
export const ChatEntry = z.object({
  id: ChatId,
  title: z.string().max(200),
  /** When it started: an ISO 8601 time. */
  at: z.string().max(64),
  latest: z.object({ id: MessageId, at: z.string().max(64) }).optional(),
  state: ChatState,
  archived: z.boolean(),
});

/**
 * `chat@1`: an agent's chats. A chat is the messages sent in it: `send` with no `chat` starts one,
 * and with one, goes on in it. A turn's messages, streaming text and status arrive as events, each
 * naming its chat. Events are live only: `history` is a chat's record, `state` its status now, and
 * `list` the chats. Whether chats run turns at once is the provider's to say: one that can't take
 * a message now refuses it `busy`. A call naming a chat the agent doesn't have is refused
 * `unknown`.
 */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Start a turn with this message, in `chat` or in a new chat, and say which. An archived chat
     * takes a message like any other, and stays archived. Refused `busy` when the provider can't
     * take it now.
     */
    send: method({
      input: z.object({
        chat: ChatId.optional(),
        text: z.string().min(1).max(100_000).regex(/\S/),
      }),
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
    /** Stop the chat's current turn, if any. */
    cancel: method({ input: OnChat, output: z.object({}) }),
    /** The chat's status now, as its latest `status` event said; for a view opened mid-turn. */
    state: method({ input: OnChat, output: ChatStatus }),
    /**
     * Run the chat's last turn again from the record, without recording the person's message
     * again; `messageId` is that message's. Refused `busy` when the provider can't take it now,
     * and `nothing_to_retry` when the record holds no message of the person's.
     */
    retry: method({ input: OnChat, output: z.object({ messageId: MessageId }) }),
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
      input: OnChat.extend({ title: z.string().min(1).max(200).regex(/\S/) }),
      output: z.object({}),
    }),
    /** Put a chat among the archived ones, or back. It stays readable either way. */
    archive: method({ input: OnChat.extend({ archived: z.boolean() }), output: z.object({}) }),
    /** The models this agent can use, and the one chosen; none chosen means the provider's default. */
    models: method({
      input: z.object({}),
      output: z.object({
        models: z.array(z.object({ id: ChatModelId, name: z.string().max(256) })),
        current: ChatModelId.optional(),
      }),
    }),
    /**
     * Choose the model for this agent's next requests, in every chat, kept with the agent; with no
     * `model`, go back to the provider's default. Refused `unknown` when the model isn't one of
     * `models`.
     */
    setModel: method({ input: z.object({ model: ChatModelId.optional() }), output: z.object({}) }),
  },
  events: {
    message: event(ChatMessage.extend({ chat: ChatId })),
    /** Text of the assistant message `id`, as it streams; its `message` event follows. */
    delta: event(z.object({ chat: ChatId, id: MessageId, text: z.string() })),
    status: event(ChatStatus.extend({ chat: ChatId })),
    /**
     * A chat as it now is: it was started, renamed or archived, or a message was sent in it. None
     * is sent when only its `state` changes: `status` says that.
     */
    chat: event(ChatEntry),
  },
});
