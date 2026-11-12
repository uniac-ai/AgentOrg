/**
 * What the looper is given and what it gives back, in its own words. Whoever hosts it maps its own
 * world onto these: the looper names no interface, no chat and no agent.
 */
import { z } from "zod";

/** A JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What one text of a model request can hold, and one name in it. */
const Text = z.string().max(200_000);
const Name = z.string().min(1).max(256);
/** A picture, of a kind a model reads: its media type, and its bytes in base64. */
const Picture = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(1),
});
export type Picture = z.output<typeof Picture>;
const Pictures = z.array(Picture).optional();
/** One item of a conversation as a model reads it: something said, a function call, or its output. */
export const Item = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    content: Text,
    images: Pictures,
  }),
  z.object({ type: z.literal("function_call"), callId: Name, name: Name, arguments: Text }),
  z.object({
    type: z.literal("function_call_output"),
    callId: Name,
    output: Text,
    images: Pictures,
  }),
]);
export type Item = z.output<typeof Item>;
/** What a model gives back: something it says, or a function it calls. */
export type OutputItem = Exclude<Item, { type: "function_call_output" }>;

/** A function the model may call, as a request describes it. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** The JSON Schema of its arguments. */
  parameters: Record<string, Json>;
  /** Its arguments stream as the model writes them: a call of it has a reader as it is written. */
  streamed?: true;
}
/** How a function call ended, as the model and the record see it. */
export interface Outcome {
  output: string;
  /** The pictures it gave with its output. */
  images?: Picture[];
  ok: boolean;
  /** Why it didn't, when `ok` is false. */
  code?: string;
}
/**
 * A function the model may call, with the way to run it. `run` gets the call's arguments, parsed;
 * what it throws is the call's output, as a refusal: with its code when it is a `Refusal`.
 */
export interface Tool extends ToolSpec {
  /** `group` names the turn the call is made in, the same for all of one turn's calls. */
  run(input: unknown, group: string): Promise<Outcome>;
}

/**
 * The model: one stateless answer to a whole conversation. A request that can't be answered rejects,
 * with a `Refusal` when there is a code to show. Text it writes while it answers is given to the
 * looper's `delta`, with the request's id.
 */
export interface Model {
  respond(request: {
    requestId: string;
    model?: string;
    instructions: string;
    input: Item[];
    tools: ToolSpec[];
  }): Promise<{ output: OutputItem[] }>;
  /** Stop the answer to `requestId`, if it is still being made; its `respond` then rejects. */
  cancel(request: { requestId: string }): Promise<unknown>;
}

/** Where the looper keeps its records: values by key, listed in key order a page at a time. */
export interface Store {
  get(input: { key: string }): Promise<{ value?: Json | undefined }>;
  set(input: { key: string; value: Json }): Promise<unknown>;
  delete(input: { key: string }): Promise<unknown>;
  list(input: {
    prefix?: string;
    after?: string;
    limit?: number;
  }): Promise<{ keys: string[]; next: string | null }>;
}

/** Where the looper says what an operator may want to know; nothing a thread shows. */
export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A function call a model's streamed text belongs to: its call id, and the function's name. */
export interface Call {
  id: string;
  name: string;
}

/** A message as it is said in a thread: what a person said, or a reply. */
export interface Shown {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** An ISO 8601 time. */
  at: string;
  /** The pictures the person sent with it. */
  images?: Picture[];
}

/** What a loop is doing. On `error`, `detail.code` is the refusal's code. */
export type Status =
  | { state: "idle" | "thinking" | "tool" }
  | { state: "error"; detail: { code: string; message: string } };

/**
 * Something refused, with a stable code a host can show or map. A host that refuses for a reason of
 * its own can keep that reason as the `cause`.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** The code and message of anything a call or a turn can throw. */
export function codeOf(error: unknown): { code: string; message: string } {
  if (error instanceof Refusal) return { code: error.code, message: error.message };
  return { code: "failed", message: "The call failed." };
}
