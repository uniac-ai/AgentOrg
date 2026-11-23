// A message's bubbles: its text split at its blank lines. A blank line always starts a new bubble,
// before a list too: a list right under words, with no blank line between, stays in their bubble,
// and after a blank line it starts its own, as words do. Whatever follows a list or code starts a
// new bubble. It runs on a message's whole text: a message is drawn once it has come whole.
//
// The blocks are the markdown library's own, as it draws them, so a blank line inside a code block
// splits nothing. Each block is one of three kinds:
// - a code block, which stays whole, as a bubble of its own;
// - a list, which stays in the bubble of the words right above it, with no blank line between;
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

/** The text of each of a message's bubbles, in order. */
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
    const joins = !!last && before === "words" && !blank && (kind === "list" || kind === "words");
    if (last && joins) last.push(block);
    else bubbles.push([block]);
    before = kind;
    blank = endsBlank(block);
  }
  return bubbles.map((parts) => parts.join("").trim()).filter(Boolean);
}
