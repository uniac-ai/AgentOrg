/**
 * Compaction: when what a piece of work sends its model grows past the budget, its earlier steps
 * are summarized by the work's own model into a checkpoint, and its latest steps stay word for
 * word. Here is what the work's record keeps of a compaction, what a summary is given, and how the
 * model is sent it; what writes the summary is the host's `summarizer`. Following pi
 * (https://github.com/badlogic/pi-mono, MIT; see NOTICE): a summary is sent as pi sends it, with
 * the files read and changed.
 */
import { z } from "zod";
import type { Item } from "./types.js";

/** The code of a model's refusal of a request for its length: the loop compacts and asks again. */
export const CONTEXT_LENGTH = "context_length";
/** The line its work's Activity shows for a compaction. */
export const COMPACTION_LINE = "Earlier steps summarized to continue.";

/** A compaction as its work's record keeps it. */
export const Compacted = z.object({
  /** The summary, as the model wrote it. */
  summary: z.string(),
  /** The place in its work's order it summarizes up to: what stands after it is sent as it is. */
  upTo: z.number(),
  /** The files its calls read and didn't change, oldest first. */
  read: z.array(z.string()).optional(),
  /** The files its calls changed, oldest first. */
  changed: z.array(z.string()).optional(),
  /** The work's steps as they stood, as `status` answers with them. */
  steps: z.string().optional(),
});
export type Compacted = z.output<typeof Compacted>;

/** What a compaction summarizes, as `record.toCompact` gives it. */
export interface ToCompact {
  /** What came before the exchange the cut falls in, or all of it when it falls between two. */
  history: Item[];
  /** That exchange's part before the cut, when the cut falls inside one. */
  prefix: Item[];
  /** The work's latest compaction, which this one updates. */
  previous?: Compacted | undefined;
  /** The place of the last entry summarized. */
  upTo: number;
}

/** What the host says a call read and changed: paths, by the call's name and arguments. */
export type FilesOf = (call: {
  name: string;
  arguments: string;
}) => { read?: string[] | undefined; changed?: string[] | undefined } | undefined;

/**
 * What writes a work's summary: given what to summarize, a way to ask the work's model, and what
 * the host says of the files its calls read and changed.
 */
export type Summarize = (
  ask: (instructions: string, text: string) => Promise<string>,
  compacting: ToCompact,
  files?: FilesOf,
) => Promise<Compacted>;

/**
 * What writes summaries, as an agent's capability for them offers it: `summarize`, called on it
 * (as `ctx.summary.summarize(…)`).
 */
export interface Summarizer {
  summarize: Summarize;
}

/** A compaction as the model is sent it: a user message, with the file lists, and the work's steps. */
export function summaryItem({ summary, read = [], changed = [], steps }: Compacted): Item {
  const lists = [
    ...(read.length > 0 ? [`<read-files>\n${read.join("\n")}\n</read-files>`] : []),
    ...(changed.length > 0 ? [`<modified-files>\n${changed.join("\n")}\n</modified-files>`] : []),
  ];
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_BEGINS}:\n\n<summary>\n${summary}${lists.length > 0 ? `\n\n${lists.join("\n\n")}` : ""}\n</summary>${steps ? `\n\nYour steps at this point, kept with \`status\`:\n${steps}` : ""}`,
  };
}
/** How a compaction's message begins, which a worker is told is no one's message. */
export const SUMMARY_BEGINS =
  "The conversation history before this point was compacted into the following summary";
