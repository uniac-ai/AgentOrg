/**
 * The agent's Work: what each of its pieces of work did, read through one operation, `work`, which
 * a view of it and an agent both call, and the capability that holds it, which says when that
 * changed. It answers while the agent is stopped too: what its work did is still there to read.
 */
import type { Activity, ActivityPage, capability, tools } from "@agentorg/interfaces";
import { cut, cutInside, type WorkEntry } from "@agentorg/looper";
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

/**
 * A call's input, its arguments as JSON, cut to `SHOWN`: JSON still, with its short values, a
 * path or a name, whole, when it is JSON and can be cut so; otherwise as text.
 */
const cutInput = (input: string) =>
  input.length <= SHOWN
    ? input
    : (cutInside(input, SHOWN, (json) => json.length) ?? cut(input, SHOWN));
/** An entry as an answer carries it: each text it says cut to `SHOWN`. */
function shown(entry: WorkEntry): WorkEntry {
  if ("call" in entry) {
    const { output, ...call } = entry.call;
    return {
      ...entry,
      call: {
        ...call,
        input: cutInput(call.input),
        ...(output === undefined ? {} : { output: cut(output, SHOWN) }),
      },
    };
  }
  if ("words" in entry) return { ...entry, words: cut(entry.words, SHOWN) };
  return { ...entry, line: cut(entry.line, SHOWN) };
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
