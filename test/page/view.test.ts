import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityView } from "../../src/page/types.ts";
import { harness } from "./harness.ts";

const FACT_FIELDS = [
  "agent",
  "manager",
  "children",
  "asks_to_answer",
  "own_asks",
  "inbox",
] as const;

test("an agent's page view lists the same items its session_context gives the agent", async () => {
  const { service, get, organization } = await harness();
  const { lead, child, store, ask, send } = await organization();
  const below = await service.agent_create(
    { session: store.session.id, title: "Script", purpose: "Copy in batches." },
    { channel: "mcp", client: "claude-code", clientSessionId: "c" },
  );
  const script = await service.session_attach(
    { agent: below.id },
    { channel: "mcp", client: "codex", clientSessionId: "s" },
  );
  await ask(script.session.id, "Batch size 500?");
  await ask(store.session.id, "Delete the files?");
  await send(script.session.id, "report", "Dry run done.");
  await ask(lead.session.id, "Ship tonight?");

  const facts = await service.session_context(
    { client: "claude-code", client_session_id: "c" },
    { channel: "mcp" },
  );
  const view = (await (await get(`/ui/api/view/${child.id}`)).json()) as EntityView;

  assert.ok(facts.facts);
  for (const field of FACT_FIELDS) {
    assert.deepEqual(view[field], facts.facts[field], field);
  }
  assert.equal(view.asks_to_answer.length, 1);
  assert.equal(view.own_asks.length, 1);
  assert.equal(view.inbox.length, 1);
  assert.deepEqual(
    view.children.map((agent) => agent.id),
    [below.id],
  );
});

test("the user's view has the same structure: no manager, the top agents as reports", async () => {
  const { get, post, organization } = await harness();
  const { lead, ask, send } = await organization();
  const toUser = await ask(lead.session.id, "Ship tonight?");
  const report = await send(lead.session.id, "report", "Phase one is done.");

  const view = (await (await get("/ui/api/view/user")).json()) as EntityView;

  assert.equal(view.agent, null);
  assert.equal(view.manager, null);
  assert.deepEqual(
    view.children.map((agent) => agent.id),
    [lead.agent.id],
  );
  assert.deepEqual(
    view.asks_to_answer.map((a) => a.id),
    [toUser.id],
  );
  assert.deepEqual(
    view.inbox.map((m) => m.id),
    [report.id],
  );
  assert.deepEqual(view.own_asks, []);

  assert.equal((await post(`/ui/api/messages/${report.id}/ack`)).status, 200);
  const after = (await (await get("/ui/api/view/user")).json()) as EntityView;
  assert.deepEqual(after.inbox, []);
  assert.deepEqual(
    after.history.messages.map((m) => [m.id, m.acknowledged_at !== null]),
    [[report.id, true]],
  );
  assert.deepEqual(
    after.history.asks.map((a) => a.id),
    [toUser.id],
  );
});

test("an unknown entity is not found", async () => {
  const { get } = await harness();
  assert.equal((await get("/ui/api/view/agt_missing")).status, 404);
});
