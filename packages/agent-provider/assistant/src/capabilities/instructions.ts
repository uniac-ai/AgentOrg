/**
 * The agent's own words, as management composes them and its settings give them: told first,
 * before its skills and what its other capabilities add. Words that open with its template's
 * earlier words, as their own paragraph, are told its words now in their place.
 */
import type { Context } from "cordis";
import { MAX_INSTRUCTIONS } from "../settings.js";
import type { Capability } from "../substrate.js";

/** Where its words go among what a request is told: before everything else. */
export const WORDS_ORDER = -40;
/** The owner of the part that is its words: what its voice is read from. */
export const WORDS = "agent";

/** Its words, with its template's earlier words read as its words now. */
export function current(text: string, template: { now(): string; earlier?: string }) {
  const { earlier } = template;
  if (!earlier || !(text === earlier || text.startsWith(`${earlier}\n\n`))) return text;
  return `${template.now()}${text.slice(earlier.length)}`;
}

/** The `instructions` capability, mounted with `{ text }`. `template` is what its template says now. */
export const instructions = (template: {
  now(): string;
  earlier?: string;
}): Capability<{ text?: unknown } | undefined> => ({
  name: "instructions",
  title: "Instructions",
  inject: ["context"],
  apply(ctx: Context, args) {
    const text = current(typeof args?.text === "string" ? args.text : "", template);
    ctx.context.pass(
      (request) => void request.instructions.push({ owner: WORDS, text, max: MAX_INSTRUCTIONS }),
      { order: WORDS_ORDER },
    );
  },
});
