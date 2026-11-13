/**
 * The agent's Work: what each of its pieces of work did, read through one operation, `work`, which
 * a view of it and an agent both call, and the capability that holds it, which says when that
 * changed. It answers while the agent is stopped too: what its work did is still there to read.
 */
import type { Activity, ActivityPage, capability, tools } from "@agentorg/interfaces";
import type { WorkEntry } from "@agentorg/looper";
import { type Export, Refused } from "@agentorg/sdk";
import type { z } from "zod";

/** The view a page draws of it. */
export const ACTIVITY = "activity";
/** With no `work`: at most this many pieces of work, each with this many of its latest entries. */
const WORKS = 6;
const LATEST = 3;
/** At most this many entries of one piece of work in a page of it. */
const PAGE_MAX = 20;
/** What one entry says keeps this many characters. */
const SHOWN = 2_000;
/** A string of a call's input is kept at least this long, and what its cut says is at most this long. */
const MIN_KEPT = 40;
const CUT_SAYS = 30;
/** An answer is at most this many characters, so another agent's loop takes it whole. */
const BUDGET = 28_000;

export const WORK_TOOL = {
  name: "work",
  description:
    "What this agent's pieces of work are doing and did. With no arguments: its pieces of work, most recently active first, with their latest entries; with `before` and no `work`, those last active before that piece of work. With `work`: that piece of work's entries before `before`, as many as `limit`.",
  inputSchema: {
    type: "object",
    properties: {
      work: { type: "string", description: "A piece of work's id." },
      before: {
        type: "string",
        description:
          "With `work`, an entry's id: those before it. Without, a piece of work's id: those last active before it.",
      },
      limit: { type: "number", description: `How many entries, at most ${PAGE_MAX}.` },
    },
  },
};

type Works = z.input<typeof Activity>["works"];
/** What the agent's chats give of its work. */
interface Source {
  works(limit: number, entries: number, before?: string): Promise<Works>;
  entries(
    work: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ entries: WorkEntry[]; more: boolean }>;
}

/** `text` cut to `most` characters, saying how many more there were. */
export const cut = (text: string, most = SHOWN) => {
  if (text.length <= most) return text;
  // Never half of a surrogate pair.
  const kept = text.slice(0, most).replace(/[\uD800-\uDBFF]$/, "");
  return `${kept}… (${text.length - kept.length} more characters)`;
};
/**
 * A call's input, its arguments as JSON, cut to `SHOWN`: while it is longer, the string with the
 * most kept is cut further, from its whole text, as far as needed, so what it says stays JSON and
 * keeps its short values, a path or a name. One that isn't JSON, or can't be cut so, is cut as
 * text. Read back and written again, a number past what JSON numbers here hold may change.
 */
function cutInput(input: string): string {
  if (input.length <= SHOWN) return input;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return cut(input);
  }
  /** Each string in it long enough that cutting it saves room: its whole text, how much of it is kept, and how to put it back cut. */
  const strings: { text: string; kept: number; put: (text: string) => void }[] = [];
  const find = (at: unknown, put: (text: string) => void) => {
    if (typeof at === "string") {
      if (at.length > MIN_KEPT + CUT_SAYS) strings.push({ text: at, kept: at.length, put });
    } else if (at && typeof at === "object")
      for (const key of Object.keys(at))
        find((at as Record<string, unknown>)[key], (text) => {
          (at as Record<string, unknown>)[key] = text;
        });
  };
  find(value, (text) => {
    value = text;
  });
  // Cut as far as each may be, it still doesn't fit: cut as text.
  for (const one of strings) one.put(cut(one.text, MIN_KEPT));
  if (JSON.stringify(value).length > SHOWN) return cut(input);
  for (const one of strings) one.put(one.text);
  for (let now = JSON.stringify(value); now.length > SHOWN; now = JSON.stringify(value)) {
    const most = strings.reduce((best, one) => (one.kept > best.kept ? one : best));
    // The most kept whose written form, escapes and all, takes off what is over.
    const over = now.length - SHOWN;
    const written = (kept: number) => JSON.stringify(cut(most.text, kept)).length;
    const room = written(most.kept) - over;
    let low = MIN_KEPT;
    let high = most.kept - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (written(mid) <= room) low = mid;
      else high = mid - 1;
    }
    most.kept = low;
    most.put(cut(most.text, most.kept));
  }
  return JSON.stringify(value);
}
/** An entry as an answer carries it: each text it says cut to `SHOWN`. */
function shown(entry: WorkEntry): WorkEntry {
  if ("call" in entry) {
    const { output, ...call } = entry.call;
    return {
      ...entry,
      call: {
        ...call,
        input: cutInput(call.input),
        ...(output === undefined ? {} : { output: cut(output) }),
      },
    };
  }
  if ("words" in entry) return { ...entry, words: cut(entry.words) };
  return { ...entry, line: cut(entry.line) };
}
/** Whether an answer is within what another agent's loop takes whole. */
export const fits = (answer: object) => JSON.stringify(answer).length <= BUDGET;

/**
 * The answer with no `work`: its oldest entries go first, then its least recently active pieces
 * of work. `more` says whether pieces of work remain after those it gives.
 */
function activity(all: Works, more: boolean): z.input<typeof Activity> {
  const answer = { works: all.map((one) => ({ ...one, entries: one.entries.map(shown) })), more };
  while (!fits(answer)) {
    const fullest = answer.works.reduce((most, one) =>
      one.entries.length > most.entries.length ? one : most,
    );
    if (fullest.entries.length > 0) {
      fullest.entries.shift();
      fullest.more = true;
    } else {
      answer.works.pop();
      answer.more = true;
    }
  }
  return answer;
}
/** A page of one piece of work: its oldest entries go first. */
function page(
  work: string,
  from: { entries: WorkEntry[]; more: boolean },
): z.input<typeof ActivityPage> {
  const answer = { work, entries: from.entries.map(shown), more: from.more };
  while (answer.entries.length > 0 && !fits(answer)) {
    answer.entries.shift();
    answer.more = true;
  }
  return answer;
}

/** Serve the capability and its operation from `source`. */
export function serveWork(
  exports: { capability: Export<typeof capability>; tools: Export<typeof tools> },
  source: Source,
) {
  exports.capability.implement({
    state: () => ({ state: "connected", surfaces: [] }),
    live: () => {
      throw new Refused("unknown", "Work has no live surface.");
    },
  });
  exports.tools.implement({
    list: () => ({ tools: [WORK_TOOL] }),
    async call({ name, arguments: args }) {
      if (name !== WORK_TOOL.name)
        throw new Refused("unknown", `There is no tool named ${name.slice(0, 64)}.`);
      const { work, before, limit } = args as Record<string, unknown>;
      if (
        (work !== undefined && typeof work !== "string") ||
        (before !== undefined && typeof before !== "string")
      )
        return { output: "Give `work` and `before`, if any, as text.", failed: true as const };
      const most =
        typeof limit === "number" && Number.isInteger(limit) && limit > 0
          ? Math.min(limit, PAGE_MAX)
          : PAGE_MAX;
      try {
        if (work === undefined) {
          // One more than it gives, to know whether more remain.
          const found = await source.works(WORKS + 1, LATEST, before);
          return {
            output: JSON.stringify(activity(found.slice(0, WORKS), found.length > WORKS)),
          };
        }
        return { output: JSON.stringify(page(work, await source.entries(work, before, most))) };
      } catch (error) {
        if (error instanceof Refused && error.code === "unknown")
          return { output: "There is no such piece of work.", failed: true as const };
        throw error;
      }
    },
    stop: () => ({}),
  });
}
