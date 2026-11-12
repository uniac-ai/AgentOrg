import assert from "node:assert/strict";
import test from "node:test";
import { looperWith, until } from "./support.ts";

test("a message from anyone other than the person says who it is from, to its worker and the main loop", async () => {
  const { looper, asked, numbered, mains, answer } = looperWith({
    speaker: (thread) => (thread === "maker" ? "act_1f2e" : undefined),
  });
  await looper.send("person", "Hi.");
  await until(() => asked.length === 1, "the person's request");
  assert.deepEqual(numbered[0], ["[1] Hi."]);
  await looper.send("maker", "Check the logs.");
  await until(() => asked.length === 2, "the maker's request");
  assert.deepEqual(numbered[1], ["[1] (from act_1f2e) Check the logs."]);
  assert.deepEqual(mains[1]?.input.slice(1), ["(from act_1f2e) Check the logs."]);
  // Said to that work in its turn, the main loop hears of it with who it is from too.
  await looper.send("maker", "Stop.");
  await until(() => mains.length === 3, "the main loop to hear of it");
  assert.equal(mains[2]?.input.at(-1), "(from act_1f2e) Stop.");
  answer("Hi.");
  answer("(from act_1f2e) Check the logs.");
  // Its worker reads it after what it sent.
  await until(() => asked.length === 3, "the request that reads it");
  answer("(from act_1f2e) Stop.");
  await looper.settled();
});

test("in a thread of anyone but the person the main loop is told only of the work that follows it; the person's is told of all", async () => {
  const { looper, asked, mains, answer } = looperWith({
    speaker: (thread) => (thread === "maker" ? "act_1f2e" : undefined),
  });
  await looper.send("person", "Write the report.");
  await until(() => asked.length === 1, "the person's work");
  await looper.send("maker", "Check the logs.");
  await until(() => asked.length === 2, "the maker's work");
  // The maker's thread is told of no work but its own: here, none yet.
  assert.equal(mains[1]?.input[0], "There is no work.");
  // A thread of the person's is told of both.
  await looper.send("again", "What is going on?");
  await until(() => mains.length === 3, "the main loop on the person's other thread");
  assert.match(mains[2]?.input[0] ?? "", /- person: .*\n- maker: |- maker: .*\n- person: /);
  answer("Write the report.");
  answer("(from act_1f2e) Check the logs.");
  await until(() => asked.length === 3, "the third work");
  answer("What is going on?");
  await looper.settled();
});
