import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { workInstructions } from "../src/loop.ts";
import { HEARD_INSTRUCTIONS, MAIN_INSTRUCTIONS } from "../src/main.ts";
import { build, partsOf } from "../src/told.ts";
import { looperWith, sends, until } from "./support.ts";

/**
 * A saved copy of a text the model is told, in test/told: a change of words shows as a diff here.
 * With WRITE_TOLD=1 the copy is written instead, for a change that is meant.
 */
function matchesSaved(name: string, text: string) {
  // From dist/test, the sources' test folder.
  const file = new URL(`../../test/told/${name}`, import.meta.url);
  if (process.env.WRITE_TOLD === "1") writeFileSync(file, text);
  assert.equal(
    text,
    readFileSync(file, "utf8"),
    `${name} changed: if that is meant, run with WRITE_TOLD=1`,
  );
}

test("parts are joined in order by a blank line, an empty one left out, each cut to its size, saying what was cut", () => {
  assert.deepEqual(
    build([
      { owner: "a", text: "First." },
      { owner: "b", text: "" },
      { owner: "c", text: "Second, longer.", max: 7 },
    ]),
    { text: "First.\n\nSecond,", cut: [{ owner: "c", was: 15, kept: 7 }] },
  );
  // Never inside a character that takes two units.
  assert.equal(build([{ owner: "a", text: "ab😀c", max: 3 }]).text, "ab");
  assert.deepEqual(partsOf("Words."), [{ owner: "host", text: "Words." }]);
});

test("the texts the looper tells the model are the saved ones, word for word", () => {
  matchesSaved("worker.txt", workInstructions("Make note.txt and date.txt"));
  matchesSaved(
    "worker-beside-others.txt",
    workInstructions("Make note.txt and date.txt", ["Fix the tests", "Write the notes"]),
  );
  matchesSaved("front-desk.txt", MAIN_INSTRUCTIONS);
  matchesSaved("front-desk-heard.txt", HEARD_INSTRUCTIONS);
});

test("the main loop is told its words, then who it speaks as, as saved", async () => {
  const { looper, mains } = looperWith({ voice: "You are a test assistant. Keep replies short." });
  await looper.send("a", "Hi!");
  await until(() => mains.length === 1, "the main loop's request");
  matchesSaved("front-desk-voiced.txt", mains[0]?.instructions ?? "");
  await looper.close();
});

test("a worker's requests in one turn are told the same bytes, and the next turn reads them again", async () => {
  let version = 0;
  const { looper, asked, told, answer } = looperWith({
    instructions: () => `Version ${++version}.`,
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the first request");
  await looper.send("a", "Second.");
  answer("First.", sends("First done."));
  await until(() => asked.length === 2, "the second request, in the same turn");
  answer("Second.", sends("Second done."));
  await looper.settled();
  // The main loop asked the host again for the second message, so its words changed meanwhile.
  assert.ok(version > 1, "the host's words changed between the two requests");
  assert.equal(told[1]?.instructions, told[0]?.instructions);
  assert.equal(
    told[0]?.instructions,
    `Version ${told[0]?.instructions.match(/\d+/)?.[0]}.\n\n${workInstructions("Work")}`,
  );
  await looper.send("a", "Third.");
  await until(() => asked.length === 3, "the next turn's request");
  answer("Third.", sends("Third done."));
  await looper.settled();
  assert.notEqual(told[2]?.instructions, told[0]?.instructions);
});

test("a host's parts are told in order, each cut to its size, before the looper's own words", async () => {
  const { looper, asked, told, answer } = looperWith({
    instructions: [
      { owner: "agent", text: "You help with notes." },
      { owner: "skills", text: "## Skills\n- notes: keep notes", max: 9 },
    ],
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the request");
  answer("First.", sends("Done."));
  await looper.settled();
  assert.equal(
    told[0]?.instructions,
    `You help with notes.\n\n## Skills\n\n${workInstructions("Work")}`,
  );
});
