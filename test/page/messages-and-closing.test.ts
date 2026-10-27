import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF, harness } from "./fake-service.ts";

test("reports and notes to the user wait under the asks until acknowledged or read", async () => {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAgent("store", { manager: "lead" });
  page.fake.addMessage("report", "lead", 30, { kind: "report", body: "The guide is done." });
  page.fake.addMessage("note", "lead", 10, { body: "Starting on the keys." });
  page.fake.addMessage("to-lead", "store", 5, { body: "Only for the lead." });
  await page.signIn();

  const before = await (await page.get("/")).text();
  assert.match(before, /Report from <a href="\/agents\/lead">Release lead<\/a>/);
  assert.match(before, /action="\/ui\/messages\/report\/ack"/);
  assert.match(before, /action="\/ui\/messages\/note\/read"/);
  assert.doesNotMatch(before, /Only for the lead\./);
  assert.match(before, /<title>\(2\) Decisions/);

  for (const path of ["/ui/messages/report/ack", "/ui/messages/note/read"]) {
    const response = await page.post(path, { csrf: CSRF });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
  }

  assert.deepEqual(
    page.fake.calls.map(([name, request, caller]) => [name, request, caller.channel]),
    [
      ["message_ack_as_user", { message: "report" }, "page"],
      ["message_read_as_user", { message: "note" }, "page"],
    ],
  );
  const after = await (await page.get("/")).text();
  assert.match(after, /Nothing is waiting on you/);
});

test("closing an agent takes a confirmation on the page, then confirms it closed", async () => {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAsk("open", "lead", 10);
  await page.signIn();

  const first = await (await page.get("/agents/lead")).text();
  assert.match(first, /href="\/agents\/lead\?close=confirm#close"/);
  assert.doesNotMatch(first, /action="\/ui\/agents\/lead\/close"/);

  const confirm = await (await page.get("/agents/lead?close=confirm")).text();
  assert.match(confirm, /action="\/ui\/agents\/lead\/close"/);
  assert.match(confirm, /withdraws its 1 open ask\. It\s+cannot be undone\./);

  const response = await page.post("/ui/agents/lead/close", { csrf: CSRF });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?closed=lead");
  assert.deepEqual(page.fake.calls, [
    ["agent_close_as_user", { agent: "lead" }, { channel: "page" }],
  ]);

  const after = await (await page.get("/?closed=lead")).text();
  assert.match(after, /Closed Release lead/);
  assert.match(after, /No agents yet/);
  assert.doesNotMatch(await (await page.get("/agents/lead")).text(), /id="close"/);
});

test("an agent with open agents under it names them instead of offering to close", async () => {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAgent("store", { manager: "lead", title: "Storage migration" });
  await page.signIn();

  const body = await (await page.get("/agents/lead?close=confirm")).text();
  assert.match(
    body,
    /Close the agents under it first: <a href="\/agents\/store">Storage migration<\/a>/,
  );
  assert.doesNotMatch(body, /action="\/ui\/agents\/lead\/close"/);

  const refused = await page.post("/ui/agents/lead/close", { csrf: CSRF });
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /still has open agents under it/);
});
