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

/**
 * Replies of many shapes, each with its bubbles once written out, as they were before anything was
 * held back while a message is written.
 */
const SHAPES: [string, string, string[]][] = [
  [
    "numbered, tight",
    "Here are the steps:\n\n1. Install it\n2. Run it\n3. Open the page\n\nThat is all.",
    ["Here are the steps:\n\n1. Install it\n2. Run it\n3. Open the page", "That is all."],
  ],
  [
    "numbered, loose",
    "Three things:\n\n1. First\n\n2. Second\n\n10. Tenth\n\nDone.",
    ["Three things:\n\n1. First\n\n2. Second\n\n10. Tenth", "Done."],
  ],
  ["numbered with a bracket", "Options:\n\n1) One\n2) Two", ["Options:\n\n1) One\n2) Two"]],
  [
    "hyphen list",
    "The parts:\n\n- **web**: pages\n- **cart**: pricing\n\nAfter the list.",
    ["The parts:\n\n- **web**: pages\n- **cart**: pricing", "After the list."],
  ],
  ["star list", "The parts:\n\n* web\n* cart\n\nAfter.", ["The parts:\n\n* web\n* cart", "After."]],
  ["plus list", "The parts:\n\n+ web\n+ cart", ["The parts:\n\n+ web\n+ cart"]],
  [
    "nested list",
    "Plan:\n\n- one\n  - inner\n- two\n\nEnd.",
    ["Plan:\n\n- one\n  - inner\n- two", "End."],
  ],
  [
    "bold start",
    "First line.\n\n**Bold**: the rest of it.\n\nLast.",
    ["First line.", "**Bold**: the rest of it.", "Last."],
  ],
  [
    "italic start",
    "First line.\n\n*really* so.\n\nLast.",
    ["First line.", "*really* so.", "Last."],
  ],
  ["a year", "First line.\n\n2024 was good.\n\n42", ["First line.", "2024 was good.", "42"]],
  [
    "a negative number",
    "First line.\n\n-5 degrees outside.",
    ["First line.", "-5 degrees outside."],
  ],
  [
    "code fence",
    "Run this:\n\n```sh\nnpm install\n\nnpm test\n```\n\nThen look.",
    ["Run this:", "```sh\nnpm install\n\nnpm test\n```", "Then look."],
  ],
  ["tilde fence", "Run this:\n\n~~~\nx\n~~~\n\nDone.", ["Run this:", "~~~\nx\n~~~", "Done."]],
  [
    "heading",
    "Intro.\n\n## A heading\n\nWords under it.",
    ["Intro.", "## A heading", "Words under it."],
  ],
  ["rule line", "Above.\n\n---\n\nBelow.", ["Above.", "---", "Below."]],
  [
    "quote",
    "He said:\n\n> a quoted line\n> and more\n\nAfter.",
    ["He said:", "> a quoted line\n> and more", "After."],
  ],
  [
    "table",
    "Numbers:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.",
    ["Numbers:", "| a | b |\n|---|---|\n| 1 | 2 |", "After."],
  ],
  [
    "link and code",
    "See [the docs](https://example.com) and `npm test`.\n\nNext.",
    ["See [the docs](https://example.com) and `npm test`.", "Next."],
  ],
  ["list first", "- one\n- two\n\nThen words.", ["- one\n- two", "Then words."]],
  [
    "the design's long reply",
    "It's a small shop demo: a storefront, a cart and a fake card service.\n\nThe README is about 300 words. Most of it says how to run the demo and test it.\n\nThe code is in three folders, one for each part:\n\n- **web**: the storefront's pages and styles\n- **cart**: pricing, coupons and the checkout session\n- **pay**: a stand-in for the card processor\n\nTo run it, the README gives one command:\n\n```sh\nnpm install && npm run dev\n```",
    [
      "It's a small shop demo: a storefront, a cart and a fake card service.",
      "The README is about 300 words. Most of it says how to run the demo and test it.",
      "The code is in three folders, one for each part:\n\n- **web**: the storefront's pages and styles\n- **cart**: pricing, coupons and the checkout session\n- **pay**: a stand-in for the card processor",
      "To run it, the README gives one command:",
      "```sh\nnpm install && npm run dev\n```",
    ],
  ],
];
for (const [name, text, written] of SHAPES)
  test(`${name}: as it is written, a character at a time, no bubble drawn goes, splits or merges; written out, its bubbles are as before`, () => {
    let before: string[] = [];
    for (let n = 1; n <= text.length; n++) {
      const now = bubblesOf(text.slice(0, n), true);
      const at = JSON.stringify(text.slice(0, n));
      assert.ok(now.length >= before.length, `none goes, at ${at}`);
      assert.deepEqual(
        now.slice(0, before.length - 1),
        before.slice(0, -1),
        `those before the last are the same, at ${at}`,
      );
      const last = before.at(-1);
      if (last !== undefined)
        assert.ok(
          (now[before.length - 1] ?? "").startsWith(last),
          `the last only gains words, at ${at}`,
        );
      before = now;
    }
    assert.deepEqual(bubblesOf(text), written);
  });

test("while written, a last paragraph that is only a number or a list's mark isn't drawn until the next piece says what it is; settled, it is", () => {
  assert.deepEqual(bubblesOf("Here are the steps:\n\n1", true), ["Here are the steps:"]);
  assert.deepEqual(bubblesOf("Here are the steps:\n\n1.", true), ["Here are the steps:\n\n1."]);
  assert.deepEqual(bubblesOf("First line.\n\n*", true), ["First line."]);
  assert.deepEqual(bubblesOf("First line.\n\n*r", true), ["First line.", "*r"]);
  assert.deepEqual(bubblesOf("-", true), []);
  assert.deepEqual(bubblesOf("First line.\n\n42", true), ["First line."]);
  assert.deepEqual(bubblesOf("First line.\n\n42"), ["First line.", "42"]);
});
