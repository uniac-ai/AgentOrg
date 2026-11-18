// A message's bubbles: its text split at its blank lines, as an agent is told it will be. A list
// stays in the bubble of the line above it, with or without a blank line between, and whatever
// follows a list starts a new bubble. It runs on the message's text, so a reply still being
// written is split as it will be once it is done.
//
// The blocks are the markdown library's own, as it draws them, so a blank line inside a code block
// splits nothing. Each block is one of three kinds:
// - a code block, which stays whole, as a bubble of its own;
// - a list, which joins the bubble of the words above it;
// - anything else (a paragraph, or a heading or a table if a message has one anyway), which starts
//   a bubble after a blank line, after a list or after code, and otherwise stays in the bubble it
//   follows, since nothing split it.
import { parseMarkdownIntoBlocks } from "streamdown";

type Kind = "code" | "list" | "words";
/** Whether a bubble is a code block, which is drawn whole, in the frame code has. */
export const isCode = (block: string) => /^ {0,3}(`{3,}|~{3,})/.test(block);
const kindOf = (block: string): Kind =>
  isCode(block) ? "code" : /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(block) ? "list" : "words";
/** A block that ends with a blank line. */
const endsBlank = (block: string) => /\n[ \t]*\n\s*$/.test(block);

/**
 * The text of each of a message's bubbles, in order. As a message is written, the bubbles before
 * the last never change and one is added at a time: so a bubble's place is what it is known by.
 */
export function bubblesOf(text: string): string[] {
  const bubbles: string[][] = [];
  let before: Kind | undefined;
  let blank = false;
  for (const block of parseMarkdownIntoBlocks(text)) {
    if (!block.trim()) {
      blank = true;
      continue;
    }
    const kind = kindOf(block);
    const last = bubbles.at(-1);
    const joins = !!last && before === "words" && (kind === "list" || (kind === "words" && !blank));
    if (last && joins) last.push(block);
    else bubbles.push([block]);
    before = kind;
    blank = endsBlank(block);
  }
  return bubbles.map((parts) => parts.join("").trim()).filter(Boolean);
}
