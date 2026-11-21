/**
 * Memory: a few short lines an agent keeps for itself. It writes them through one function, is
 * told them in every turn as a section of its instructions, and keeps them in its own store, so
 * they outlast a conversation being shortened, a restart, and the plugin being unloaded. The same
 * agent's other plugins reach the lines through the service `memory`.
 *
 * What the model sees is in the README: one function, and one section while there are lines.
 */
import type { AgentPlugin } from "assistant/plugins";
import type { Context } from "cordis";

/** One thing remembered: `id` names it for a later change, `at` is the day it was last written. */
export type Line = { id: string; text: string; at: string };

/**
 * What memory offers the agent's other plugins: its lines, read and changed as the model changes
 * them. A change that can't be made is refused with why, as an error, and changes nothing: words
 * that are empty, lines that would hold more than memory does, an id no line has, or a store that
 * didn't keep it.
 */
export interface Memory {
  /** The lines, oldest first. */
  read(): readonly Readonly<Line>[];
  /** Add a line: it gives the line, with the id it was given. */
  add(text: string): Promise<Readonly<Line>>;
  replace(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
}

declare module "cordis" {
  interface Context {
    memory: Memory;
  }
}

/** The most characters the lines hold together, as the agent is told them. */
export const MEMORY_MAX = 2_000;
/** Where the lines are kept in the plugin's own store. */
const KEY = "lines";
const USAGE = "Give add with text, replace with id and text, or remove with id.";

/** What is kept: the lines, and the number the next new line takes, so no id is used twice. */
type Kept = { lines: Line[]; next: number };

/** The lines as the agent is told them, one to a line: each with its id and its day. */
const told = (lines: Line[]) =>
  lines.map(({ id, text, at }) => `- [${id}] ${text} (${at})`).join("\n");

export const memory: AgentPlugin = {
  name: "memory",
  inject: ["tools", "prompt", "store"],
  provide: "memory",
  async apply(ctx: Context) {
    // Lines that can't be read fail its load, so the agent runs without memory and says why,
    // until a later turn reads them: memory that went on without them would write new lines over
    // them. Said plainly, with nothing of where the agent's files are.
    const stored = await ctx.store.get({ key: KEY }).catch(() => {
      throw new Error("Its lines couldn't be read.");
    });
    let kept = (stored.value as Kept | undefined) ?? { lines: [], next: 1 };
    const today = () => new Date().toISOString().slice(0, 10);
    /** A line's words as they are kept: on one line, trimmed. */
    const words = (text: string) => {
      const said = text.replace(/\s+/g, " ").trim();
      if (!said) throw new Error("A line needs words.");
      return said;
    };
    const has = (now: Kept, id: string) => {
      if (!now.lines.some((line) => line.id === id)) throw new Error(`There is no line ${id}.`);
    };
    /**
     * One change at a time, in the order asked, each kept in the store before it counts. An
     * agent has several pieces of work at once, and a change the store didn't keep would be told
     * now and gone at the agent's next start.
     */
    let last: Promise<unknown> = Promise.resolve();
    const change = <T>(make: (now: Kept) => { after: Kept; gives: T }): Promise<T> => {
      const done = last.then(async () => {
        const { after, gives } = make(kept);
        const size = told(after.lines).length;
        if (size > MEMORY_MAX && size > told(kept.lines).length)
          throw new Error(
            `Memory holds at most ${MEMORY_MAX} characters, and this would make ${size}: replace or remove a line first.`,
          );
        await ctx.store.set({ key: KEY, value: after }).catch(() => {
          throw new Error("Memory couldn't be saved, so nothing changed.");
        });
        kept = after;
        return gives;
      });
      last = done.catch(() => {});
      return done;
    };
    const service: Memory = {
      read: () => kept.lines,
      add: (text) =>
        change((now) => {
          const line = { id: String(now.next), text: words(text), at: today() };
          return { after: { lines: [...now.lines, line], next: now.next + 1 }, gives: line };
        }),
      replace: (id, text) =>
        change((now) => {
          has(now, id);
          const line = { id, text: words(text), at: today() };
          const lines = now.lines.map((one) => (one.id === id ? line : one));
          return { after: { ...now, lines }, gives: undefined };
        }),
      remove: (id) =>
        change((now) => {
          has(now, id);
          const lines = now.lines.filter((one) => one.id !== id);
          return { after: { ...now, lines }, gives: undefined };
        }),
    };
    ctx.provide("memory", service);

    ctx.tools.register({
      name: "edit",
      description:
        "Change what you remember: add a line, replace a line by its id, or remove a line by its id.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"] },
          id: { type: "string", description: "The line's id, to replace or remove it." },
          text: { type: "string", description: "The line's words, to add it or replace it." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async run(input) {
        const asked = (input ?? {}) as { action?: unknown; id?: unknown; text?: unknown };
        const { action, text } = asked;
        // A model may give a line's id as the number it reads.
        const id = typeof asked.id === "number" ? String(asked.id) : asked.id;
        try {
          if (action === "add" && typeof text === "string")
            return { output: `Kept as line ${(await service.add(text)).id}.`, ok: true };
          if (action === "replace" && typeof id === "string" && typeof text === "string") {
            await service.replace(id, text);
            return { output: `Line ${id} replaced.`, ok: true };
          }
          if (action === "remove" && typeof id === "string") {
            await service.remove(id);
            return { output: `Line ${id} removed.`, ok: true };
          }
          return { output: USAGE, ok: false };
        } catch (error) {
          return { output: error instanceof Error ? error.message : String(error), ok: false };
        }
      },
    });

    ctx.prompt.section({
      name: "lines",
      order: 500,
      text: () =>
        kept.lines.length === 0 ? undefined : `## What you remember\n${told(kept.lines)}`,
    });
  },
};
