// A message's bubbles, without a browser: the rule on texts of every shape.
import assert from "node:assert/strict";
import test from "node:test";
import { bubblesOf } from "../src/fixed/bubbles.ts";
import { SAID } from "./design/samples.ts";

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
    "a list right under a line, with no blank line, stays in its bubble",
    "Three folders:\n- **web**: pages\n- **cart**: pricing",
    ["Three folders:\n- **web**: pages\n- **cart**: pricing"],
  ],
  [
    "a list after a blank line starts a new bubble, as words do",
    "Three folders:\n\n- **web**: pages\n- **cart**: pricing",
    ["Three folders:", "- **web**: pages\n- **cart**: pricing"],
  ],
  [
    "a numbered list right under a line stays in its bubble",
    "Two steps:\n1. Pull.\n2. Run.",
    ["Two steps:\n1. Pull.\n2. Run."],
  ],
  [
    "a numbered list after a blank line starts a new bubble too",
    "Two steps:\n\n1. Pull.\n2. Run.",
    ["Two steps:", "1. Pull.\n2. Run."],
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
    "the long reply: a first line, two paragraphs, the line before the list, the list, the line after, the code",
    LONG_REPLY,
    [
      "It's a small shop demo: a storefront, a cart and a fake card service.",
      "The README is about 300 words. Most of it says how to run the demo and test it.",
      "The code is in three folders, one for each part:",
      "- **web**: the storefront's pages and styles\n- **cart**: pricing, coupons and the checkout session\n- **pay**: a stand-in for the card processor",
      "To run it, the README gives one command:",
      `${fence}sh\nnpm install && npm run dev\n${fence}`,
    ],
  ],
];
for (const [name, text, bubbles] of cases)
  test(name, () => assert.deepEqual(bubblesOf(text), bubbles));

/** Replies of many shapes, each with its bubbles. */
const SHAPES: [string, string, string[]][] = [
  [
    "numbered, tight",
    "Here are the steps:\n\n1. Install it\n2. Run it\n3. Open the page\n\nThat is all.",
    ["Here are the steps:", "1. Install it\n2. Run it\n3. Open the page", "That is all."],
  ],
  [
    "numbered, loose",
    "Three things:\n\n1. First\n\n2. Second\n\n10. Tenth\n\nDone.",
    ["Three things:", "1. First\n\n2. Second\n\n10. Tenth", "Done."],
  ],
  ["numbered with a bracket", "Options:\n\n1) One\n2) Two", ["Options:", "1) One\n2) Two"]],
  [
    "hyphen list",
    "The parts:\n\n- **web**: pages\n- **cart**: pricing\n\nAfter the list.",
    ["The parts:", "- **web**: pages\n- **cart**: pricing", "After the list."],
  ],
  ["star list", "The parts:\n\n* web\n* cart\n\nAfter.", ["The parts:", "* web\n* cart", "After."]],
  ["plus list", "The parts:\n\n+ web\n+ cart", ["The parts:", "+ web\n+ cart"]],
  [
    "nested list",
    "Plan:\n\n- one\n  - inner\n- two\n\nEnd.",
    ["Plan:", "- one\n  - inner\n- two", "End."],
  ],
  [
    "a list right under its line",
    "The parts:\n- web\n- cart\n\nAfter.",
    ["The parts:\n- web\n- cart", "After."],
  ],
  [
    "a numbered list right under its line",
    "Two steps:\n1. Pull.\n2. Run.",
    ["Two steps:\n1. Pull.\n2. Run."],
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
      "The code is in three folders, one for each part:",
      "- **web**: the storefront's pages and styles\n- **cart**: pricing, coupons and the checkout session\n- **pay**: a stand-in for the card processor",
      "To run it, the README gives one command:",
      "```sh\nnpm install && npm run dev\n```",
    ],
  ],
];
for (const [name, text, bubbles] of SHAPES)
  test(`${name}: its bubbles`, () => assert.deepEqual(bubblesOf(text), bubbles));
