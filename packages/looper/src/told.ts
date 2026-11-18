/**
 * What the model is told, put together in one place: parts in a fixed order, each saying whose it
 * is and how much of it may be kept, joined by blank lines. A worker's is put together once a turn,
 * so every request of the turn begins with the same bytes.
 */
import { head } from "./types.js";

/** One part of what the model is told: whose it is, its words, and the most of them kept. */
export interface Part {
  owner: string;
  text: string;
  /**
   * The most characters kept of it, cut where a character ends, as `head` cuts; all of it with
   * none.
   */
  max?: number;
}

/** A part that was longer than it may be: whose, and its length before and after. */
export interface CutPart {
  owner: string;
  was: number;
  kept: number;
}

/** The parts in order, each cut to its `max`, an empty one left out, joined by a blank line. */
export function build(parts: readonly Part[]): { text: string; cut: CutPart[] } {
  const cut: CutPart[] = [];
  const texts: string[] = [];
  for (const { owner, text, max } of parts) {
    if (!text) continue;
    const kept = max === undefined ? text : head(text, max);
    if (kept !== text) cut.push({ owner, was: text.length, kept: kept.length });
    texts.push(kept);
  }
  return { text: texts.join("\n\n"), cut };
}

/** A host's instructions as parts: words alone are one part, the host's own. */
export const partsOf = (instructions: string | readonly Part[]): readonly Part[] =>
  typeof instructions === "string" ? [{ owner: "host", text: instructions }] : instructions;
