import assert from "node:assert/strict";
import test from "node:test";
import { held, idle, looperWith, newWork, says, sends, stops, until } from "./support.ts";

test("a turn's calls are made under one group and the next turn's under another; a turn that ends by itself stops nothing", async () => {
  const { tool, groups, finish, calls } = held();
  finish();
  const stopping: string[] = [];
  const { looper, asked, answer } = looperWith({
    tools: [tool],
    stopGroup: async (group) => void stopping.push(group),
  });
  await looper.send("a", "First.");
  await until(() => asked.length === 1, "the first turn's request");
  answer("First.", calls(2));
  await until(() => asked.length === 2, "the request after its calls");
  answer("First.", sends("Done."));
  await looper.settled();
  await looper.send("a", "Second.");
  await until(() => asked.length === 3, "the next turn's request");
  answer("Second.", calls(1));
  await until(() => asked.length === 4, "the request after its call");
  answer("Second.", sends("Done again."));
  await looper.settled();
  assert.equal(groups.length, 3);
  assert.equal(groups[0], groups[1]);
  assert.notEqual(groups[2], groups[0]);
  assert.deepEqual(stopping, []);
});

test("a stop said by message asks to end what the stopped turn's calls left running, by its group; the call then ends", async () => {
  const { tool, groups, finish, calls } = held();
  const stopping: string[] = [];
  const { looper, asked, said, answer } = looperWith({
    tools: [tool],
    routing: (text) => (text === "Stop." ? [...says("Stopped."), ...stops("a")] : newWork()),
    // What the provider does with it: what the call started ends, and so the call does.
    stopGroup: async (group) => {
      stopping.push(group);
      finish();
    },
  });
  await looper.send("a", "Run it.");
  await until(() => asked.length === 1, "the request");
  answer("Run it.", calls(1));
  await until(() => groups.length === 1, "the call");
  await looper.send("a", "Stop.");
  await until(() => said.length === 3, "the thread to be told");
  await looper.settled();
  // Asked at the stop, and again once the call that was running is back.
  assert.deepEqual(stopping, [groups[0], groups[0]]);
  assert.deepEqual(looper.state("a"), { state: "idle" });
  // The turn asks nothing more once its call has ended.
  await idle();
  assert.equal(asked.length, 1);
});

test("the agent's own stop asks for each turn it cuts, and a stop that fails stops all the same", async () => {
  const { tool, groups, finish, calls } = held();
  const stopping: string[] = [];
  const { looper, asked, answer } = looperWith({
    tools: [tool],
    stopGroup: async (group) => {
      stopping.push(group);
      finish();
      throw new Error("The provider has gone.");
    },
  });
  await looper.send("a", "Run one.");
  await looper.send("b", "Run another.");
  await until(() => asked.length === 2, "both requests");
  answer("Run one.", calls(1));
  answer("Run another.", calls(1));
  await until(() => groups.length === 2, "both calls");
  assert.notEqual(groups[0], groups[1]);
  await looper.stop();
  await idle();
  assert.deepEqual([...stopping].sort(), [...groups, ...groups].sort());
  assert.deepEqual(looper.state("a"), { state: "idle" });
  assert.deepEqual(looper.state("b"), { state: "idle" });
});

test("a call on its way at a stop is asked again once it is back, for what it started after the stop", async () => {
  const { tool, groups, finish, calls } = held();
  const stopping: string[] = [];
  const { looper, asked, answer } = looperWith({
    tools: [tool],
    // The provider has started nothing of the call yet: the first stop ends nothing.
    stopGroup: async (group) => void stopping.push(group),
  });
  await looper.send("a", "Run it.");
  await until(() => asked.length === 1, "the request");
  answer("Run it.", calls(1));
  await until(() => groups.length === 1, "the call");
  const stopped = looper.stop();
  await until(() => stopping.length === 1, "the stop");
  finish();
  await stopped;
  await idle();
  assert.deepEqual(stopping, [groups[0], groups[0]]);
});

test("closing leaves what a turn's calls started running", async () => {
  const { tool, groups, finish, calls } = held();
  const stopping: string[] = [];
  const { looper, asked, answer } = looperWith({
    tools: [tool],
    stopGroup: async (group) => void stopping.push(group),
  });
  await looper.send("a", "Run it.");
  await until(() => asked.length === 1, "the request");
  answer("Run it.", calls(1));
  await until(() => groups.length === 1, "the call");
  await looper.close();
  // Nor once the call that was running is back.
  finish();
  await idle();
  assert.deepEqual(stopping, []);
});
