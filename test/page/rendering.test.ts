import assert from "node:assert/strict";
import { test } from "node:test";
import { ago } from "../../src/page/views.tsx";
import { CSRF, harness } from "./fake-service.ts";

const before = (body: string, ...needles: string[]) => {
  const at = needles.map((needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, needle);
    return index;
  });
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
  );
};

test("waiting on you lists the user's asks oldest first, each with the chain it carries up", async () => {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAgent("docs", { title: "Docs lead" });
  page.fake.addAgent("store", { manager: "lead", title: "Storage migration" });
  page.fake.addAsk("child", "store", 90, { title: "Delete the JSON files?" });
  page.fake.addAsk("carried", "lead", 30, { escalates: ["child"], title: "Keep the files?" });
  page.fake.addAsk("older", "docs", 60, { labels: ["Now", "Later"], recommendation: "Later" });
  await page.signIn();

  const body = await (await page.get("/")).text();

  before(body, 'id="ask-older"', 'id="ask-carried"');
  assert.doesNotMatch(body, /id="ask-child"/);
  assert.match(
    body,
    /<ol class="chain" aria-label="Carried up"><li><a href="\/agents\/store">Storage migration<\/a> asked <a href="\/agents\/lead">Release lead<\/a>/,
  );
  assert.match(body, /<span class="chain-ask">Delete the JSON files\?<\/span>/);
  assert.match(body, /Asked by <a href="\/agents\/lead">Release lead<\/a>/);
  assert.match(body, /<title>\(2\) Decisions · agentorg<\/title>/);
  const older = body.slice(body.indexOf('id="ask-older"'), body.indexOf('id="ask-carried"'));
  assert.match(older, new RegExp(`<input type="hidden" name="csrf" value="${CSRF}"/>`));
  const labels = [...older.matchAll(/<label class="option">([\s\S]*?)<\/label>/g)].map((m) => m[1]);
  assert.deepEqual(
    labels.map((label) => label?.includes("Recommended")),
    [false, true],
  );
});

test("the organization shows the open agents as a tree, with what waits on each", async () => {
  const page = harness();
  page.fake.addAgent("lead", {
    title: "Release lead",
    status: {
      state: "waiting",
      summary: "On track.",
      links: [{ label: "PR", url: "https://example.com/pr/1" }],
    },
  });
  page.fake.addAgent("store", { manager: "lead", title: "Storage migration", state: "pending" });
  page.fake.addAgent("gone", { manager: "lead", title: "Finished work", state: "closed" });
  page.fake.addAsk("to-lead", "store", 10);
  page.fake.addMessage("m1", "store", 5);
  page.fake.addMessage("m2", "store", 4);
  await page.signIn();

  const body = await (await page.get("/")).text();
  const organization = body.slice(body.indexOf("Organization"));

  before(
    organization,
    "Release lead",
    '<span class="badge state-waiting">Waiting</span>',
    "<ul>",
    "Storage migration",
  );
  assert.match(organization, /<span class="badge state-pending">Pending<\/span>/);
  assert.match(organization, /No session has attached yet/);
  assert.match(organization, /1 ask to answer · 2 unread messages/);
  assert.match(
    organization,
    /<a href="https:\/\/example.com\/pr\/1" target="_blank" rel="noreferrer">PR<\/a>/,
  );
  assert.doesNotMatch(organization, /Finished work/);
  assert.match(organization, /Organization <span class="count">2<\/span>/);
});

test("text from agents is escaped everywhere it shows", async () => {
  const page = harness();
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
  page.fake.addAgent("lead", {
    title: `${evil} lead`,
    purpose: evil,
    status: {
      summary: evil,
      blockers: [evil],
      links: [
        { label: evil, url: "javascript:alert(1)" },
        { label: "ok", url: `https://example.com/"><script>` },
      ],
    },
  });
  page.fake.addAsk("ask", "lead", 5, { title: evil, context: evil, labels: [evil, "B"] });
  page.fake.addMessage("note", "lead", 5, { body: evil });
  await page.signIn();

  for (const path of ["/", "/agents/lead"]) {
    const body = await (await page.get(path)).text();
    assert.doesNotMatch(body, /<script>|<img/, path);
    assert.doesNotMatch(body, /href="javascript:/, path);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, path);
  }
});

test("with nothing open the page says so", async () => {
  const page = harness();
  await page.signIn();

  const body = await (await page.get("/")).text();

  assert.match(body, /Nothing is waiting on you/);
  assert.match(body, /No agents yet/);
  assert.match(body, /<title>Decisions · agentorg<\/title>/);
});

test("an inspected agent shows its asks both ways, its messages and its sessions", async () => {
  const page = harness();
  page.fake.addAgent("lead", { title: "Release lead" });
  page.fake.addAgent("store", {
    manager: "lead",
    title: "Storage migration",
    created_at_attach: true,
  });
  page.fake.addAgent("script", { manager: "store", title: "Migration script" });
  page.fake.addAsk("own", "store", 20, { title: "Own question?" });
  page.fake.addAsk("from-child", "script", 40, { title: "Child question?" });
  page.fake.addAsk("done", "store", 200, {
    state: "answered",
    answer: {
      choice: "Yes",
      words: null,
      by: "lead",
      channel: "agent",
      answered_at: "2026-01-01T00:00:00Z",
    },
  });
  page.fake.addMessage("up", "store", 30, { kind: "report", body: "Copy done." });
  page.fake.addMessage("down", "script", 15, {
    body: "Batch size 500.",
    read_at: "2026-01-01T00:00:00Z",
  });
  page.fake.sessions.push({
    id: "ses_1",
    agent: "store",
    client: "claude-code",
    client_session_id: null,
    machine: "laptop",
    attached_at: "2026-01-01T00:00:00Z",
    detached_at: null,
  });
  await page.signIn();

  const body = await (await page.get("/agents/store")).text();

  assert.match(
    body,
    /<nav class="meta" aria-label="Managers"><a href="\/">You<\/a> › <a href="\/agents\/lead">Release lead<\/a><\/nav>/,
  );
  before(body, 'id="ask-from-child"', 'id="ask-own"', 'id="ask-done"');
  assert.match(body, /From <a href="\/agents\/script">Migration script<\/a>/);
  assert.match(body, /To <a href="\/agents\/lead">Release lead<\/a>/);
  assert.match(body, /Answered by Release lead: Yes/);
  assert.match(body, /Report<\/span>[\s\S]*?unread[\s\S]*?Copy done\./);
  assert.match(body, /Note<\/span>[\s\S]*?· read<\/p>/);
  assert.match(body, /<td>claude-code<\/td><td>laptop<\/td>/);
  assert.match(body, /<td>Attached<\/td>/);
  assert.match(body, /By its own session as it attached/);
  assert.match(body, /Agents under it/);
});

test("an unknown agent is not found", async () => {
  const page = harness();
  await page.signIn();
  assert.equal((await page.get("/agents/nope")).status, 404);
});

test("times read as how long ago", () => {
  const now = new Date("2026-01-03T12:00:00Z");
  assert.equal(ago("2026-01-03T11:59:30Z", now), "just now");
  assert.equal(ago("2026-01-03T11:48:00Z", now), "12 min ago");
  assert.equal(ago("2026-01-03T07:00:00Z", now), "5 h ago");
  assert.equal(ago("2025-12-30T12:00:00Z", now), "4 days ago");
});
