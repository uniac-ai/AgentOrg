import assert from "node:assert/strict";
import { test } from "node:test";
import { openapiDocument } from "../../src/api/openapi.ts";
import type { AskRecord, Inbox, MessageRecord } from "../../src/page/types.ts";
import { harness } from "./harness.ts";

const WRITES = [
  "/ui/api/asks/ask_x/answer",
  "/ui/api/messages/msg_x/read",
  "/ui/api/messages/msg_x/ack",
  "/ui/api/agents/agt_x/close",
];

test("every write without the page session's CSRF token is refused before the service", async () => {
  const { post, calls, csrf } = await harness();
  for (const path of WRITES) {
    for (const token of ["", "wrong", `${csrf}x`]) {
      const response = await post(path, { choice: "Keep" }, { "X-CSRF-Token": token });
      assert.equal(response.status, 403, `${path} with ${JSON.stringify(token)}`);
    }
  }
  assert.deepEqual(calls, []);
});

test("an answer reaches the service as the user's, on the page channel", async () => {
  const { post, calls, organization } = await harness();
  const { lead, ask } = await organization();
  const toUser = await ask(lead.session.id, "Ship tonight?");

  const response = await post(`/ui/api/asks/${toUser.id}/answer`, {
    choice: "Delete",
    words: "Back it up first.",
  });

  assert.equal(response.status, 200);
  const answered = (await response.json()) as AskRecord;
  assert.deepEqual(
    [answered.state, answered.answer?.choice, answered.answer?.by, answered.answer?.channel],
    ["answered", "Delete", null, "page"],
  );
  assert.deepEqual(calls, [
    [
      "ask_answer_as_user",
      { ask: toUser.id, choice: "Delete", words: "Back it up first." },
      { channel: "page" },
    ],
  ]);
});

test("stepping in on an ask addressed to an agent is recorded as the user's answer", async () => {
  const { post, service, organization } = await harness();
  const { store, ask } = await organization();
  const toLead = await ask(store.session.id, "Delete the files?");

  assert.equal((await post(`/ui/api/asks/${toLead.id}/answer`, { choice: "Keep" })).status, 200);

  const recorded = await service.ask_get({ ask: toLead.id }, { channel: "api" });
  assert.notEqual(recorded.to, null);
  assert.deepEqual([recorded.answer?.by, recorded.answer?.channel], [null, "page"]);
});

test("refusals come back as the API's error codes", async () => {
  const { post, organization } = await harness();
  const { lead, ask } = await organization();
  const open = await ask(lead.session.id, "Ship tonight?");

  const notAnOption = await post(`/ui/api/asks/${open.id}/answer`, { choice: "Maybe" });
  assert.equal(notAnOption.status, 422);
  assert.equal(((await notAnOption.json()) as { code: string }).code, "invalid");

  const empty = await post(`/ui/api/asks/${open.id}/answer`, {});
  assert.equal(empty.status, 422);

  assert.equal((await post(`/ui/api/asks/${open.id}/answer`, { choice: "Keep" })).status, 200);
  const again = await post(`/ui/api/asks/${open.id}/answer`, { choice: "Keep" });
  assert.equal(again.status, 409);

  assert.equal((await post("/ui/api/asks/ask_missing/answer", { choice: "Keep" })).status, 404);
});

test("the inbox holds the asks and messages waiting on the user, oldest first", async () => {
  const { get, post, organization } = await harness();
  const { lead, store, ask, send } = await organization();
  const lower = await ask(store.session.id, "Delete the files?");
  const carried = await ask(lead.session.id, "May the files go?", [lower.id]);
  const report = await send(lead.session.id, "report", "Phase one is done.");
  const note = await send(lead.session.id, "note", "Starting phase two.");
  await send(store.session.id, "note", "Only for the lead.");

  const inbox = (await (await get("/ui/api/inbox")).json()) as Inbox;

  assert.deepEqual(
    inbox.asks.map((a) => a.id),
    [carried.id],
  );
  assert.deepEqual(
    inbox.messages.map((m: MessageRecord) => m.id),
    [report.id, note.id],
  );

  assert.equal((await post(`/ui/api/messages/${report.id}/ack`)).status, 200);
  assert.equal((await post(`/ui/api/messages/${note.id}/read`)).status, 200);
  const after = (await (await get("/ui/api/inbox")).json()) as Inbox;
  assert.deepEqual(after.messages, []);
});

test("closing an agent waits until the agents under it are closed", async () => {
  const { post, organization } = await harness();
  const { lead, child } = await organization();

  const refused = await post(`/ui/api/agents/${lead.agent.id}/close`);
  assert.equal(refused.status, 409);

  assert.equal((await post(`/ui/api/agents/${child.id}/close`)).status, 200);
  assert.equal((await post(`/ui/api/agents/${lead.agent.id}/close`)).status, 200);
});

test("reads return the record: agents, one agent, asks in a state, and activity", async () => {
  const { get, organization } = await harness();
  const { lead, store, ask } = await organization();
  await ask(store.session.id, "Delete the files?");

  const agents = (await (await get("/ui/api/agents")).json()) as {
    agents: { agent: { id: string } }[];
  };
  assert.equal(agents.agents.length, 2);
  const detail = (await (await get(`/ui/api/agents/${lead.agent.id}`)).json()) as {
    addressed_asks: unknown[];
  };
  assert.equal(detail.addressed_asks.length, 1);
  const all = (await (await get("/ui/api/asks?state=all")).json()) as { asks: unknown[] };
  assert.equal(all.asks.length, 1);
  assert.equal((await get("/ui/api/asks?state=nonsense")).status, 422);
  const activity = (await (await get("/ui/api/activity?limit=2")).json()) as { entries: unknown[] };
  assert.equal(activity.entries.length, 2);
  assert.equal((await get("/ui/api/agents/agt_missing")).status, 404);
});

test("the page's routes stay out of the public contract", () => {
  const paths = Object.keys((openapiDocument() as { paths: Record<string, unknown> }).paths);
  assert.ok(paths.every((path) => path.startsWith("/api/")));
  assert.ok(!paths.some((path) => path.includes("as_user")));
});
