import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, AgentSummary } from "../../src/page/types.ts";
import { managers, organization } from "../../web/src/model/organization.ts";

const agent = (id: string, manager: string | null, state: AgentRecord["state"] = "active") =>
  ({ id, title: id, manager, state }) as AgentRecord;
const summary = (record: AgentRecord): AgentSummary =>
  ({ agent: record, asks_to_answer: 0, unread_messages: 0 }) as AgentSummary;

test("the organization nests open agents under their managers, in the order listed", () => {
  const agents = [
    agent("a", null),
    agent("a1", "a"),
    agent("b", null),
    agent("a2", "a"),
    agent("a1x", "a1"),
    agent("done", "a", "closed"),
    agent("orphan", "unlisted"),
  ].map(summary);

  const shape = (nodes: ReturnType<typeof organization>): unknown =>
    nodes.map((node) => [node.summary.agent.id, shape(node.children)]);
  assert.deepEqual(shape(organization(agents)), [
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

test("an agent's managers run from the user down, and a cycle ends the path", () => {
  const byId = new Map(
    [agent("a", null), agent("b", "a"), agent("c", "b"), agent("x", "y"), agent("y", "x")].map(
      (record) => [record.id, record],
    ),
  );
  assert.deepEqual(
    managers("c", byId).map((m) => m.id),
    ["a", "b"],
  );
  assert.deepEqual(
    managers("a", byId).map((m) => m.id),
    [],
  );
  assert.deepEqual(
    managers("x", byId).map((m) => m.id),
    ["x", "y"],
  );
});
