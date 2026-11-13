import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { Pictures } from "./picture.js";

const RequestId = z.string().min(1).max(128);
/** A model's id, as whoever offers the model names it. */
export const ModelId = z.string().min(1).max(128);
const CallId = z.string().min(1).max(256);
/** A function tool's name, as the Responses API takes it. */
const ToolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Text = z.string().max(200_000);

/** What was said; a person's words may have pictures with them. */
const Message = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  content: Text,
  images: Pictures.optional(),
});
const FunctionCall = z.object({
  type: z.literal("function_call"),
  callId: CallId,
  /** Loose, unlike a tool's: a call naming no offered tool is answered as such, not refused. */
  name: z.string().min(1).max(256),
  /** The arguments as the model wrote them: JSON text, meant to fit the tool's parameters. */
  arguments: Text,
});
/** What a call gave back: its text, and the pictures it gave with it. */
const FunctionCallOutput = z.object({
  type: z.literal("function_call_output"),
  callId: CallId,
  output: Text,
  images: Pictures.optional(),
});

/** One item of a conversation: what was said, a function the model called, and its output. */
export const Item = z.discriminatedUnion("type", [Message, FunctionCall, FunctionCallOutput]);
/** What a response produces: the assistant's text and the functions it calls. */
export const OutputItem = z.discriminatedUnion("type", [
  Message.extend({ role: z.literal("assistant") }),
  FunctionCall,
]);
/**
 * A function the model may call; `parameters` is the JSON Schema of its arguments. With
 * `streamed`, a provider may send a call's arguments as `delta` events while the model writes
 * them; it sends no other function's.
 */
export const Tool = z.object({
  name: ToolName,
  description: z.string().max(1024).optional(),
  parameters: z.record(z.string(), z.json()),
  streamed: z.literal(true).optional(),
});

/**
 * `llm.session@1`: model inference. Each `respond` is one stateless request: the caller sends the
 * whole conversation every time, and keeps it. Text, and the arguments of a call of a `streamed`
 * function, stream as `delta` events for the request.
 * The request is one frame on the wire (at most 1 MiB), so a caller trims what it sends. A
 * caller carries nothing of a model's reasoning; a provider may keep it and put it back itself.
 *
 * A provider refuses with these codes, so a caller can show the right thing:
 * - `not_signed_in`: the provider has no usable sign-in;
 * - `usage_limit`: the account's usage limit is reached; the message says where to manage it;
 * - `unavailable`: the service is unavailable for now; try again later;
 * - `ineligible`: the account isn't eligible;
 * - `unsupported`: the request asked for something the service doesn't support;
 * - `context_length`: the request is longer than the model takes;
 * - `failed`: anything else, with a diagnostic message.
 */
export const llmSession = defineInterface({
  name: "llm.session",
  major: 1,
  kind: "rpc",
  methods: {
    /** The models offered: `id` goes back as `model`, `name` is for people. */
    models: method({
      input: z.object({}),
      output: z.object({
        models: z.array(z.object({ id: ModelId, name: z.string().max(256) })),
      }),
    }),
    /** One response to the whole conversation in `input`; the provider's default model if none. */
    respond: method({
      input: z.object({
        requestId: RequestId,
        model: ModelId.optional(),
        instructions: Text,
        input: z.array(Item).max(10_000),
        tools: z.array(Tool).max(128).optional(),
      }),
      output: z.object({
        output: z.array(OutputItem),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative(),
            outputTokens: z.number().int().nonnegative(),
          })
          .optional(),
      }),
    }),
    /**
     * Stop the caller's own response to `requestId`, if it is still running; its `respond` is
     * refused.
     */
    cancel: method({ input: z.object({ requestId: RequestId }), output: z.object({}) }),
  },
  events: {
    /**
     * Text of a response, as it streams, to the consumer whose request it answers only: of its
     * reply, or, with `call`, of the arguments of a call of a `streamed` function, whose `callId`
     * that is in the output `respond` gives. Joined in order, a call's pieces are its arguments,
     * none of them sent twice. A provider may send none, and doesn't try again a response it has
     * sent any of: those words may be with their reader.
     */
    delta: event(
      z.object({
        requestId: RequestId,
        text: z.string(),
        call: z.object({ id: CallId, name: FunctionCall.shape.name }).optional(),
      }),
    ),
  },
});
