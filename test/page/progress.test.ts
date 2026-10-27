import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, AgentSummary } from "../../src/page/types.ts";
import {
  isStale,
  recentlyChanged,
  rollups,
  STALE_AFTER_MS,
  total,
  totals,
} from "../../web/src/model/progress.ts";

type Status = NonNullable<AgentRecord["status"]>["state"];

const summary = (
  id: string,
  manager: string | null,
  status: Status | "pending" | "closed" | null,
  fields: Partial<AgentSummary> & { updated?: string } = {},
): AgentSummary => {
  const lifecycle = status === "pending" || status === "closed" ? status : "active";
  const state = lifecycle === "active" && status !== null ? status : undefined;
  return {
    agent: {
      id,
      title: id,
      manager,
      state: lifecycle,
      status: state
        ? {
            state,
            summary: "",
            links: [],
            blockers: [],
            updated_at: fields.updated ?? "2026-01-01T00:00:00Z",
          }
        : null,
    } as AgentRecord,
    asks_to_answer: 0,
    unread_messages: 0,
    attached_session: null,
    last_activity_at: "2026-01-01T00:00:00Z",
    ...fields,
  } as AgentSummary;
};

const ORG = [
  summary("lead", null, "waiting"),
  summary("store", "lead", "review"),
  summary("script", "store", "running"),
  summary("index", "store", "pending"),
  summary("audit", "store", "closed"),
  summary("backfill", "lead", "blocked"),
  summary("docs", null, "running"),
  summary("idle", null, null),
];

test("a manager's roll-up counts its whole subtree by state, closed agents included", () => {
  const counts = rollups(ORG);

  const lead = counts.get("lead");
  assert.ok(lead);
  assert.deepEqual(
    {
      review: lead.review,
      running: lead.running,
      pending: lead.pending,
      closed: lead.closed,
      blocked: lead.blocked,
    },
    { review: 1, running: 1, pending: 1, closed: 1, blocked: 1 },
  );
  assert.equal(total(lead), 5);
  assert.equal(total(counts.get("store") ?? lead), 3);
  assert.equal(total(counts.get("script") ?? lead), 0);
});

test("the organization's totals count every agent once", () => {
  const counts = totals(ORG);
  assert.equal(total(counts), ORG.length);
  assert.deepEqual([counts.running, counts.idle, counts.closed, counts.waiting], [2, 1, 1, 1]);
});

test("a running agent whose sessions have been quiet too long is stale; waiting ones are not", () => {
  const now = Date.parse("2026-01-01T00:00:00Z") + STALE_AFTER_MS + 1;
  assert.equal(isStale(summary("a", null, "running"), now), true);
  assert.equal(isStale(summary("b", null, "waiting"), now), false);
  assert.equal(
    isStale(summary("c", null, "running", { last_activity_at: new Date(now).toISOString() }), now),
    false,
  );
});

test("the agents whose status changed most recently come first, closed ones left out", () => {
  const recent = recentlyChanged(
    [
      summary("old", null, "running", { updated: "2026-01-01T01:00:00Z" }),
      summary("new", null, "review", { updated: "2026-01-01T03:00:00Z" }),
      summary("mid", null, "blocked", { updated: "2026-01-01T02:00:00Z" }),
      summary("none", null, null),
    ],
    2,
  );
  assert.deepEqual(
    recent.map((s) => s.agent.id),
    ["new", "mid"],
  );
});
