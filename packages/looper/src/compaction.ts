/**
 * Compaction: when what a piece of work sends its model grows past the budget, its earlier steps
 * are summarized by the work's own model into a checkpoint, and its latest steps stay word for
 * word. Adapted from pi (https://github.com/badlogic/pi-mono, MIT; see NOTICE): its prompts are used
 * as written, the conversation is written out for the summary as pi writes it, each later summary
 * updates the one before, and the files read and changed are carried from one to the next.
 */
import { z } from "zod";
import { head, type Item } from "./types.js";

/** A summary keeps at most this many characters. */
const MAX_SUMMARY = 16_000;
/** What a summary request is given of the conversation, at most, in characters. */
export const SUMMARY_INPUT = 160_000;
/** A call's arguments and its output, written out for a summary, keep this many characters. */
const CALL_CHARS = 2_000;
/** Each list of files keeps its newest paths within this many characters. */
const FILES_CHARS = 900;
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

// pi's prompts, as written.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/** `text` cut to `CALL_CHARS`, saying how much more there was. */
const cut = (text: string) =>
  text.length > CALL_CHARS
    ? `${head(text, CALL_CHARS)}\n\n[... ${text.length - CALL_CHARS} more characters truncated]`
    : text;

/**
 * A conversation written out as one text, so the model reads it as something to
 * summarize and not to go on with: each call's arguments and output cut to `CALL_CHARS`. Past
 * `SUMMARY_INPUT` its oldest parts are left out, and it begins by saying so.
 */
export function serialize(items: Item[]): string {
  const parts: string[] = [];
  const calls: string[] = [];
  const flush = () => {
    if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.splice(0).join("; ")}`);
  };
  for (const item of items) {
    if (item.type === "function_call") {
      calls.push(`${item.name}(${cut(argumentsOf(item.arguments))})`);
      continue;
    }
    flush();
    if (item.type === "message") {
      if (item.content)
        parts.push(`[${item.role === "user" ? "User" : "Assistant"}]: ${item.content}`);
    } else if (item.output) parts.push(`[Tool result]: ${cut(item.output)}`);
  }
  flush();
  let total = parts.reduce((sum, part) => sum + part.length + 2, 0);
  if (total > SUMMARY_INPUT) {
    // Room is kept for the line that says so.
    let gone = 0;
    for (; parts.length > 1 && total > SUMMARY_INPUT - 100; gone++)
      total -= (parts.shift() as string).length + 2;
    parts.unshift(`[... ${gone} earlier parts of the conversation left out]`);
  }
  return head(parts.join("\n\n"), SUMMARY_INPUT);
}
/** A call's arguments as they are written out: `name=value` for each, or as they are if not an object. */
function argumentsOf(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return Object.entries(parsed)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(", ");
  } catch {}
  return args;
}

/** What the host says a call read and changed: paths, by the call's name and arguments. */
export type FilesOf = (call: {
  name: string;
  arguments: string;
}) => { read?: string[] | undefined; changed?: string[] | undefined } | undefined;

/**
 * The files the calls summarized read and changed, with those the previous compaction kept: one
 * changed is not among those read, and each list keeps its newest that fit `FILES_CHARS`.
 */
function filesOf(compacting: ToCompact, files?: FilesOf) {
  let read = compacting.previous?.read ?? [];
  let changed = compacting.previous?.changed ?? [];
  const newest = (list: string[], paths: string[] = []) => [
    ...list.filter((path) => !paths.includes(path)),
    ...paths,
  ];
  for (const item of [...compacting.history, ...compacting.prefix])
    if (item.type === "function_call") {
      const named = files?.(item);
      read = newest(read, named?.read);
      changed = newest(changed, named?.changed);
    }
  const kept = (list: string[]) => {
    const out: string[] = [];
    let left = FILES_CHARS;
    for (const path of [...list].reverse())
      if (path.length + 1 <= left) {
        left -= path.length + 1;
        out.unshift(path);
      }
    return out;
  };
  return { read: kept(read.filter((path) => !changed.includes(path))), changed: kept(changed) };
}

/**
 * Summarize what `compacting` names, asking the work's model with `ask` (its instructions and one
 * user message, no tools): the history with the first or the update prompt, and an exchange cut
 * inside with the turn-prefix prompt, after it. Past `MAX_SUMMARY` the history gives way, so the
 * exchange the latest steps belong to stays. It rejects when a summary comes back empty.
 */
export async function summarize(
  ask: (instructions: string, text: string) => Promise<string>,
  compacting: ToCompact,
  files?: FilesOf,
): Promise<Compacted> {
  const { history, prefix, previous } = compacting;
  const { read, changed } = filesOf(compacting, files);
  const written = async (text: string) => {
    const summary = (await ask(SUMMARIZATION_SYSTEM_PROMPT, text)).trim();
    if (summary === "") throw new Error("The model gave no summary.");
    return summary;
  };
  let summary = previous?.summary ?? "";
  if (history.length > 0)
    summary = await written(
      `<conversation>\n${serialize(history)}\n</conversation>\n\n${
        previous ? `<previous-summary>\n${previous.summary}\n</previous-summary>\n\n` : ""
      }${previous ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT}`,
    );
  if (prefix.length > 0) {
    const turn = head(
      await written(
        `# Conversation\n${serialize(prefix)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
      ),
      MAX_SUMMARY,
    );
    const before = summary ? `\n\n---\n\n**Turn Context (split turn):**\n\n` : "";
    const room = MAX_SUMMARY - turn.length - before.length;
    summary = room > 0 && summary ? `${head(summary, room)}${before}${turn}` : turn;
  }
  return {
    summary: head(summary, MAX_SUMMARY),
    upTo: compacting.upTo,
    ...(read.length > 0 ? { read } : {}),
    ...(changed.length > 0 ? { changed } : {}),
  };
}

/** A compaction as the model is sent it: a user message, with the file lists. */
export function summaryItem({ summary, read = [], changed = [] }: Compacted): Item {
  const lists = [
    ...(read.length > 0 ? [`<read-files>\n${read.join("\n")}\n</read-files>`] : []),
    ...(changed.length > 0 ? [`<modified-files>\n${changed.join("\n")}\n</modified-files>`] : []),
  ];
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_BEGINS}:\n\n<summary>\n${summary}${lists.length > 0 ? `\n\n${lists.join("\n\n")}` : ""}\n</summary>`,
  };
}
/** How a compaction's message begins, which a worker is told is no one's message. */
export const SUMMARY_BEGINS =
  "The conversation history before this point was compacted into the following summary";
