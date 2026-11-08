import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const MessageId = z.string().min(1).max(128);
const ChatModelId = z.string().min(1).max(128);

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
    /** The models this agent can use, and the one chosen; none chosen means the provider's default. */
    models: method({
      input: z.object({}),
      output: z.object({
        models: z.array(z.object({ id: ChatModelId, name: z.string().max(256) })),
        current: ChatModelId.optional(),
      }),
    }),
    /**
     * Choose the model for this agent's next requests, kept with the agent; with no `model`, go
     * back to the provider's default. Refused `unknown` when the model isn't one of `models`.
     */
    setModel: method({ input: z.object({ model: ChatModelId.optional() }), output: z.object({}) }),
  },
  events: {
    message: event(ChatMessage),
    /** Text of the assistant message `id`, as it streams; its `message` event follows. */
    delta: event(z.object({ id: MessageId, text: z.string() })),
    status: event(ChatStatus),
  },
});
