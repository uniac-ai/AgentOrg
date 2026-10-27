import assert from "node:assert/strict";
import { test } from "node:test";
import { chain, inspection, tree, waitsOnUser } from "../../src/page/model.ts";
import { FakeService } from "./fake-service.ts";

test("an ask's chain holds the asks it carries up, each with theirs, and skips unknown ones", async () => {
  const fake = new FakeService();
  fake.addAgent("lead");
  fake.addAgent("store", { manager: "lead" });
  fake.addAgent("script", { manager: "store" });
  fake.addAsk("bottom", "script", 90);
  fake.addAsk("middle", "store", 60, { escalates: ["bottom"] });
  fake.addAsk("top", "lead", 30, { escalates: ["middle", "gone"] });

  const top = chain(await fake.ask_get({ ask: "top" }), fake.asks);

  const ids = (c: ReturnType<typeof chain>): unknown => [c.ask.id, c.carries.map(ids)];
  assert.deepEqual(ids(top), ["top", [["middle", [["bottom", []]]]]]);
});

test("the tree nests agents under their managers in the order listed", async () => {
  const fake = new FakeService();
  fake.addAgent("a");
  fake.addAgent("a1", { manager: "a" });
  fake.addAgent("b");
  fake.addAgent("a2", { manager: "a" });
  fake.addAgent("a1x", { manager: "a1" });
  fake.addAgent("orphan", { manager: "closed-and-unlisted" });
  const { agents } = await fake.agent_list({ include_closed: false });

  const shape = (nodes: ReturnType<typeof tree>): unknown =>
    nodes.map((node) => [node.summary.agent.id, shape(node.children)]);
  assert.deepEqual(shape(tree(agents)), [
    [
      "a",
      [
        ["a1", [["a1x", []]]],
        ["a2", []],
      ],
    ],
    ["b", []],
    ["orphan", []],
  ]);
});

test("a note waits on the user until read, a report until acknowledged", () => {
  const fake = new FakeService();
  fake.addAgent("lead");
  fake.addAgent("child", { manager: "lead" });
  fake.addMessage("note", "lead", 5);
  fake.addMessage("read-note", "lead", 5, { read_at: "2026-01-01T00:00:00Z" });
  fake.addMessage("report", "lead", 5, { kind: "report", read_at: "2026-01-01T00:00:00Z" });
  fake.addMessage("acked", "lead", 5, {
    kind: "report",
    read_at: "2026-01-01T00:00:00Z",
    acknowledged_at: "2026-01-01T00:00:00Z",
  });
  fake.addMessage("to-lead", "child", 5);

  const waiting = [...fake.messages.values()].filter(waitsOnUser).map((m) => m.id);
  assert.deepEqual(waiting, ["note", "report"]);
});

test("an inspected agent's open asks come oldest first, then the settled ones newest first", async () => {
  const fake = new FakeService();
  fake.addAgent("lead");
  fake.addAgent("store", { manager: "lead" });
  fake.addAgent("child", { manager: "store" });
  fake.addAgent("done", { manager: "store", state: "closed" });
  fake.addAsk("own-new", "store", 10);
  fake.addAsk("from-child", "child", 50);
  fake.addAsk("old-answered", "store", 300, { state: "answered" });
  fake.addAsk("new-withdrawn", "child", 100, { state: "withdrawn" });
  const { agents } = await fake.agent_list({ include_closed: true });

  const model = inspection(await fake.agent_get({ agent: "store" }), agents, false);

  assert.deepEqual(
    model.open.map((c) => c.ask.id),
    ["from-child", "own-new"],
  );
  assert.deepEqual(
    model.settled.map((c) => c.ask.id),
    ["new-withdrawn", "old-answered"],
  );
  assert.deepEqual(
    model.openChildren.map((a) => a.id),
    ["child"],
  );
});
