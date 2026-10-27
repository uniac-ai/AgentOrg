import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF, harness } from "./fake-service.ts";

/** A signed-in page with one agent under the user, its child, and an ask from each. */
async function withAsks() {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAgent("store", { manager: "lead", title: "Storage migration" });
  page.fake.addAsk("to-user", "lead", 30, { labels: ["Keep", "Delete"], title: "Keep the files?" });
  page.fake.addAsk("to-lead", "store", 60, { labels: ["Index", "Scan"] });
  await page.signIn();
  return page;
}

test("an answer reaches the service as the user's, on the page channel", async () => {
  const page = await withAsks();

  const response = await page.post("/ui/asks/to-user/answer", {
    csrf: CSRF,
    back: "/",
    choice: "Delete",
    words: "  Back them up first.  ",
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?answered=to-user");
  assert.deepEqual(page.fake.calls, [
    [
      "ask_answer_as_user",
      { ask: "to-user", choice: "Delete", words: "Back them up first." },
      { channel: "page" },
    ],
  ]);
});

test("the page then confirms what was recorded and no longer lists the ask", async () => {
  const page = await withAsks();
  await page.post("/ui/asks/to-user/answer", { csrf: CSRF, back: "/", choice: "Delete" });

  const body = await (await page.get("/?answered=to-user")).text();

  assert.match(body, /class="settled"/);
  assert.match(body, /Answered: Delete/);
  assert.doesNotMatch(body, /id="ask-to-user"/);
  assert.match(body, /Nothing is waiting on you/);
});

test("stepping in on another agent's ask is marked, and returns to that agent's page", async () => {
  const page = await withAsks();
  const inspected = await (await page.get("/agents/lead")).text();
  assert.match(
    inspected,
    /You are stepping in for Release lead\. The answer is recorded as yours\./,
  );
  assert.match(inspected, /Answer for Release lead/);

  const response = await page.post("/ui/asks/to-lead/answer", {
    csrf: CSRF,
    back: "/agents/lead",
    choice: "Index",
  });

  assert.equal(response.headers.get("location"), "/agents/lead?answered=to-lead");
  const after = await (await page.get("/agents/lead?answered=to-lead")).text();
  assert.match(after, /You stepped in: Index/);
});

test("a note alone is an answer", async () => {
  const page = await withAsks();
  await page.post("/ui/asks/to-user/answer", { csrf: CSRF, words: "Neither; ask me tomorrow." });
  assert.deepEqual(page.fake.calls[0]?.[1], {
    ask: "to-user",
    choice: undefined,
    words: "Neither; ask me tomorrow.",
  });
});

test("a form without the page session's CSRF token is refused before the service", async () => {
  const page = await withAsks();
  page.fake.addMessage("report", "lead", 5, { kind: "report" });
  const forms = [
    "/ui/asks/to-user/answer",
    "/ui/messages/report/ack",
    "/ui/messages/report/read",
    "/ui/agents/store/close",
  ];

  for (const path of forms) {
    for (const csrf of [undefined, "", "csrf_2", `${CSRF}x`]) {
      const fields: Record<string, string> = { choice: "Keep" };
      if (csrf !== undefined) fields.csrf = csrf;
      const response = await page.post(path, fields);
      assert.equal(response.status, 403, `${path} with ${csrf}`);
    }
  }
  assert.deepEqual(page.fake.calls, []);
});

test("a form without a page session is refused before the service", async () => {
  const page = await withAsks();
  const signedOut = await page.app.request("/ui/asks/to-user/answer", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: CSRF, choice: "Keep" }).toString(),
  });
  assert.equal(signedOut.status, 401);
  assert.deepEqual(page.fake.calls, []);
});

test("an empty answer is refused on its ask", async () => {
  const page = await withAsks();

  const response = await page.post("/ui/asks/to-user/answer", { csrf: CSRF, words: "   " });

  assert.equal(response.status, 422);
  const body = await response.text();
  assert.match(body, /Choose an option or write a note\./);
  assert.match(body, /id="ask-to-user"/);
  assert.deepEqual(page.fake.calls, []);
});

test("a refused answer keeps what the user entered, on the page it came from", async () => {
  const page = await withAsks();

  const refused = await page.post("/ui/asks/to-lead/answer", {
    csrf: CSRF,
    back: "/agents/lead",
    choice: "Archive",
    words: "My <b>note</b>",
  });

  assert.equal(refused.status, 422);
  const body = await refused.text();
  assert.match(body, /&#39;Archive&#39; is not one of the ask&#39;s options/);
  assert.match(body, />My &lt;b&gt;note&lt;\/b&gt;<\/textarea>/);
  assert.match(body, /<title>Agent lead|<title>Release lead/);

  const tooLong = await page.post("/ui/asks/to-user/answer", {
    csrf: CSRF,
    choice: "Keep",
    words: "x".repeat(4001),
  });
  assert.equal(tooLong.status, 422);
  assert.match(await tooLong.text(), /value="Keep" checked/);
});

test("an ask answered meanwhile shows the answer on record", async () => {
  const page = await withAsks();
  const ask = await page.fake.ask_get({ ask: "to-user" });
  page.fake.asks.set("to-user", {
    ...ask,
    state: "answered",
    answer: {
      choice: "Keep",
      words: "Keep them.",
      by: null,
      channel: "session",
      answered_at: ask.opened_at,
    },
  });

  const response = await page.post("/ui/asks/to-user/answer", { csrf: CSRF, choice: "Delete" });
  const body = await (await page.get(response.headers.get("location") ?? "/")).text();

  assert.equal(response.status, 303);
  assert.match(body, /Answered in the session: Keep/);
  assert.match(body, /Keep them\./);
});

test("a form returns only to the page's own paths", async () => {
  const page = await withAsks();
  const response = await page.post("/ui/asks/to-user/answer", {
    csrf: CSRF,
    back: "https://elsewhere.example/agents/x",
    choice: "Keep",
  });
  assert.equal(response.headers.get("location"), "/?answered=to-user");
});

test("an unknown ask is not found", async () => {
  const page = await withAsks();
  const response = await page.post("/ui/asks/nope/answer", { csrf: CSRF, choice: "Keep" });
  assert.equal(response.status, 404);
});
