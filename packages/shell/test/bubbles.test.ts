// A message's bubbles, without a browser: the rule on texts of every shape, and on every prefix
// of a long reply as it is written.
import assert from "node:assert/strict";
import test from "node:test";
import { bubblesOf } from "../src/fixed/bubbles.ts";
import { chunksOf, SAID } from "./design/samples.ts";

const fence = "```";
const LONG_REPLY = SAID.long;

const cases: [string, string, string[]][] = [
  [
    "a one-line answer is one bubble",
    "There's 212 GB free of 494 GB.",
    ["There's 212 GB free of 494 GB."],
  ],
  [
    "a paragraph starts a bubble",
    "First line.\n\nA paragraph of two sentences. Here.\n\nAnother.",
    ["First line.", "A paragraph of two sentences. Here.", "Another."],
  ],
  [
    "lines with no blank line between stay one bubble",
    "One line.\nThe next line.",
    ["One line.\nThe next line."],
  ],
  [
    "a list joins the line above it, with no blank line",
    "Three folders:\n- **web**: pages\n- **cart**: pricing",
    ["Three folders:\n- **web**: pages\n- **cart**: pricing"],
  ],
  [
    "a list joins the line above it, with a blank line",
    "Three folders:\n\n- **web**: pages\n- **cart**: pricing",
    ["Three folders:\n\n- **web**: pages\n- **cart**: pricing"],
  ],
  [
    "a numbered list joins too",
    "Two steps:\n\n1. Pull.\n2. Run.",
    ["Two steps:\n\n1. Pull.\n2. Run."],
  ],
  [
    "whatever follows a list starts a new bubble",
    "Folders:\n- web\n- cart\n\nThat's all of it.",
    ["Folders:\n- web\n- cart", "That's all of it."],
  ],
  [
    "a list first in a message is a bubble of its own",
    "- web\n- cart\n\nAfter it.",
    ["- web\n- cart", "After it."],
  ],
  [
    "a code block is a bubble of its own",
    `Run this:\n\n${fence}sh\nnpm run dev\n${fence}`,
    ["Run this:", `${fence}sh\nnpm run dev\n${fence}`],
  ],
  [
    "a code block with no blank line above is still its own",
    `Run this:\n${fence}sh\nnpm run dev\n${fence}\nThen open it.`,
    ["Run this:", `${fence}sh\nnpm run dev\n${fence}`, "Then open it."],
  ],
  [
    "a blank line inside a code block splits nothing",
    `${fence}\nnpm install\n\nnpm run dev\n${fence}`,
    [`${fence}\nnpm install\n\nnpm run dev\n${fence}`],
  ],
  [
    "a heading stays with the words under it, split only at a blank line",
    "# Notes\nThe first part.\n\nThe second.",
    ["# Notes\nThe first part.", "The second."],
  ],
  [
    "a table is a bubble like a paragraph",
    "Here:\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    ["Here:", "| a | b |\n| - | - |\n| 1 | 2 |"],
  ],
  ["an empty message has no bubble", "", []],
  [
    "the long reply: a first line, two paragraphs, the list with its line, the line after, the code",
    LONG_REPLY,
    [
      "It's a small shop demo: a storefront, a cart and a fake card service.",
      "The README is about 300 words. Most of it says how to run the demo and test it.",
      "The code is in three folders, one for each part:\n\n- **web**: the storefront's pages and styles\n- **cart**: pricing, coupons and the checkout session\n- **pay**: a stand-in for the card processor",
      "To run it, the README gives one command:",
      `${fence}sh\nnpm install && npm run dev\n${fence}`,
    ],
  ],
];
for (const [name, text, bubbles] of cases)
  test(name, () => assert.deepEqual(bubblesOf(text), bubbles));

test("as a reply is written, the bubbles before the last never change, and one is added at a time", () => {
  const chunks = chunksOf(LONG_REPLY);
  let was: string[] = [];
  for (let i = 1; i <= chunks.length; i++) {
    const now = bubblesOf(chunks.slice(0, i).join(""));
    assert.deepEqual(now.slice(0, was.length - 1), was.slice(0, -1), `kept, at chunk ${i}`);
    assert.ok(
      now.length >= was.length && now.length <= was.length + 1,
      `one at a time, at chunk ${i}: ${was.length} → ${now.length}`,
    );
    was = now;
  }
  assert.equal(was.length, 5, "written out, the whole reply's five");
});
