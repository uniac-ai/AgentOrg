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
 * with a `Refusal` when there is a code to show: `context_length` for one too long for the model,
 * which a piece of work's loop then compacts and asks once more. Text it writes while it answers
 * is given to the looper's `delta`, with the request's id.
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

/** The first `length` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function head(text: string, length: number): string {
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** How a cut text ends: with how many more characters it had. */
const CUT_NOTE = /… \((\d+) more characters\)$/;
/**
 * `text` cut to `most` characters, saying how many more there were; whole when it fits. A text
 * cut before counts what it left out then too.
 */
export function cut(text: string, most: number): string {
  if (text.length <= most) return text;
  const noted = CUT_NOTE.exec(text);
  const whole = noted ? text.slice(0, noted.index) : text;
  const kept = head(whole, most);
  return `${kept}… (${whole.length - kept.length + Number(noted?.[1] ?? 0)} more characters)`;
}

/** A string cut inside JSON keeps at least this many characters. */
const MIN_KEPT = 40;
/**
 * `json` with its long strings cut inside, until `measure` of it is at most `most`: every string
 * longer than one length is cut to it, the longest length that fits, so it stays JSON and its
 * short values, a path or a name, stay whole. A string is cut only where that makes it shorter.
 * Nothing when it isn't JSON, or is still over with every string cut to `MIN_KEPT`. Read back
 * and written again, a number past what JSON numbers here hold may change.
 */
export function cutInside(
  json: string,
  most: number,
  measure: (json: string) => number,
): string | undefined {
  try {
    let value: unknown = JSON.parse(json);
    /** Each string in it longer than what it may be cut to: its whole text, and how to put it back. */
    const strings: { text: string; put: (text: string) => void }[] = [];
    const find = (at: unknown, put: (text: string) => void) => {
      if (typeof at === "string") {
        if (at.length > MIN_KEPT) strings.push({ text: at, put });
      } else if (at && typeof at === "object")
        for (const key of Object.keys(at))
          find((at as Record<string, unknown>)[key], (text) => {
            (at as Record<string, unknown>)[key] = text;
          });
    };
    find(value, (text) => {
      value = text;
    });
    /** Its measure with every string cut to `length` where that makes it shorter. */
    const at = (length: number) => {
      for (const { text, put } of strings) {
        // Shorter by more than the note's "…" takes beyond one character, in bytes too.
        const cutTo = cut(text, length);
        put(cutTo.length + 2 < text.length ? cutTo : text);
      }
      return measure(JSON.stringify(value));
    };
    if (at(MIN_KEPT) > most) return undefined;
    let low = MIN_KEPT;
    let high = strings.reduce((longest, { text }) => Math.max(longest, text.length), MIN_KEPT);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (at(mid) <= most) low = mid;
      else high = mid - 1;
    }
    at(low);
    return JSON.stringify(value);
  } catch {
    // Nested too deep to walk or to write.
    return undefined;
  }
}

/** The code and message of anything a call or a turn can throw. */
export function codeOf(error: unknown): { code: string; message: string } {
  if (error instanceof Refusal) return { code: error.code, message: error.message };
  return { code: "failed", message: "The call failed." };
}
