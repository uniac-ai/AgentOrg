/** The web app's models: the organization from the core's views, progress, the feed and causes. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActorRecord, CallRecord, ViewRecord } from "../../src/human/types.ts";
import { causes, feed } from "../../web/src/model/activity.ts";
import {
  actors,
  flatten,
  managers,
  type Organization,
  tree,
} from "../../web/src/model/organization.ts";
import {
  isStale,
  recentlyChanged,
  rollups,
  STALE_AFTER_MS,
  total,
  totals,
} from "../../web/src/model/progress.ts";

type State = "running" | "waiting" | "blocked" | "review" | "closed" | null;

const actor = (
  id: string,
  manager: string | null,
  state: State = null,
  updated = "2026-01-01T00:00:00Z",
) =>
  ({
    id,
    name: id,
    manager,
    created_at: "2026-01-01T00:00:00Z",
    closed_at: state === "closed" ? "2026-01-02T00:00:00Z" : null,
    status:
      state === null || state === "closed" ? null : { state, summary: "", updated_at: updated },
  }) as ActorRecord;

const call = (id: string, cause: string | null = null, settled_at: string | null = null) =>
  ({ id, cause, settled_at, created_at: "2026-01-01T00:00:00Z" }) as CallRecord;

/** The organization as the walk down the root's reports gives it. */
function walked(all: ActorRecord[]): Organization {
  const view = (of: ActorRecord) =>
    ({
      actor: of,
      reports: all.filter((each) => each.manager === of.id && each.closed_at === null),
      pending: [],
      open_calls: [],
      history: [],
    }) as unknown as ViewRecord;
  return { root: "root", views: Object.fromEntries(all.map((each) => [each.id, view(each)])) };
}

const ORG = [
  actor("root", null),
  actor("lead", "root", "waiting"),
  actor("store", "lead", "review"),
  actor("script", "store", "running"),
  actor("audit", "store", "closed"),
  actor("backfill", "lead", "blocked"),
  actor("docs", "root", "running"),
];

test("the organization nests each open actor under its manager, below the root", () => {
  const organization = walked(ORG);
  const shape = (nodes: ReturnType<typeof tree>): unknown =>
    nodes.map((node) => [node.view.actor.id, shape(node.children)]);
  assert.deepEqual(shape(tree(organization)), [
    [
      "lead",
      [
        ["store", [["script", []]]],
        ["backfill", []],
      ],
    ],
    ["docs", []],
  ]);
  assert.deepEqual(
    flatten(tree(organization, "store")).map((each) => each.id),
    ["script"],
  );
  assert.deepEqual(tree(organization, "missing"), []);
});

test("an actor's managers run from below the root down, and a cycle ends the path", () => {
  const known = actors(walked(ORG));
  assert.deepEqual(
    managers("script", known).map((each) => each.id),
    ["lead", "store"],
  );
  assert.deepEqual(managers("lead", known), []);
  const cycle = new Map([
    ["x", actor("x", "y")],
    ["y", actor("y", "x")],
  ]);
  assert.deepEqual(
    managers("x", cycle).map((each) => each.id),
    ["x", "y"],
  );
});

test("a manager's roll-up counts its whole subtree by state, and totals count each actor once", () => {
  const all = ORG.filter((each) => each.id !== "root");
  const counts = rollups(all);
  const lead = counts.get("lead");
  assert.ok(lead);
  assert.deepEqual(
    [lead.review, lead.running, lead.closed, lead.blocked, total(lead)],
    [1, 1, 1, 1, 4],
  );
  assert.equal(total(counts.get("script") ?? lead), 0);
  const everyone = totals(all);
  assert.equal(total(everyone), all.length);
  assert.deepEqual([everyone.running, everyone.waiting, everyone.idle], [2, 1, 0]);
});

test("a running actor quiet too long is stale, and the latest status changes come first", () => {
  const now = Date.parse("2026-01-01T00:00:00Z") + STALE_AFTER_MS + 1;
  assert.equal(isStale(actor("a", null, "running"), now), true);
  assert.equal(isStale(actor("b", null, "waiting"), now), false);
  assert.equal(isStale(actor("c", null, "running", new Date(now).toISOString()), now), false);
  const recent = recentlyChanged(
    [
      actor("old", null, "running", "2026-01-01T01:00:00Z"),
      actor("new", null, "review", "2026-01-01T03:00:00Z"),
      actor("mid", null, "blocked", "2026-01-01T02:00:00Z"),
      actor("none", null),
    ],
    2,
  );
  assert.deepEqual(
    recent.map((each) => each.id),
    ["new", "mid"],
  );
});

test("the feed is the settled calls, newest first, and causes run down the known calls", () => {
  const first = call("c1", null, "2026-01-01T01:00:00Z");
  const second = call("c2", "c1", "2026-01-01T02:00:00Z");
  const view = { history: [first, second] } as unknown as ViewRecord;
  assert.deepEqual(
    feed(view).map((entry) => entry.call.id),
    ["c2", "c1"],
  );
  const top = call("c3", "c2");
  const known = new Map([first, second, top].map((each) => [each.id, each]));
  assert.deepEqual(
    causes(top, known).map((each) => each.id),
    ["c2", "c1"],
  );
  assert.deepEqual(causes(call("c4", "unknown"), known), []);
});
