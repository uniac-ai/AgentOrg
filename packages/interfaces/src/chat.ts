import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const MessageId = z.string().min(1).max(128);

/** One message of a chat; `tool` messages tell what the agent did with its tools. */
export const ChatMessage = z.object({
  id: MessageId,
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().max(100_000),
  /** An ISO 8601 time. */
  at: z.string().max(64),
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
 * `chat@1`: a conversation with an agent. `send` starts a turn, whose messages, streaming text and
 * status arrive as events. Events are live only: `history` is the record, and `state` the status
 * now.
 */
export const chat = defineInterface({
  name: "chat",
  major: 1,
  kind: "rpc",
  methods: {
    send: method({
      input: z.object({ text: z.string().min(1).max(100_000).regex(/\S/) }),
      output: z.object({ messageId: MessageId }),
    }),
    /**
     * Messages before `before` (or the newest), oldest first; `more` when older ones remain. A
     * provider returns fewer than `limit` when a page would not fit one frame.
     */
    history: method({
      input: z.object({
        before: MessageId.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ messages: z.array(ChatMessage), more: z.boolean() }),
    }),
    /** Stop the current turn, if any. */
    cancel: method({ input: z.object({}), output: z.object({}) }),
    /** The status now, as the latest `status` event said; for a view opened mid-turn. */
    state: method({ input: z.object({}), output: ChatStatus }),
    /**
     * Run the last turn again from the record, without recording the person's message again;
     * `messageId` is that message's. Refused `busy` during a turn, and `nothing_to_retry` when no
     * message has been sent.
     */
    retry: method({ input: z.object({}), output: z.object({ messageId: MessageId }) }),
  },
  events: {
    message: event(ChatMessage),
    /** Text of the assistant message `id`, as it streams; its `message` event follows. */
    delta: event(z.object({ id: MessageId, text: z.string() })),
    status: event(ChatStatus),
  },
});
