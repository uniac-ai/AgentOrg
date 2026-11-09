// What a person reads, worked out from tool messages in the shapes the bundled tools really answer.
import assert from "node:assert/strict";
import test from "node:test";
import { type Call, lineOfRow, rowsOf, updatesOf } from "../src/fixed/calls.ts";
import type { ChatMessage } from "../src/fixed/data.ts";

const start = Date.parse("2026-11-09T10:00:00Z");
let n = 0;
const call = (
  name: string,
  input: unknown,
  output?: string,
  state: "done" | "running" | "refused" = "done",
  seconds = n * 10,
): ChatMessage => ({
  id: `m${++n}`,
  role: "tool",
  text: name,
  at: new Date(start + seconds * 1000).toISOString(),
  tool: { name, state, input: JSON.stringify(input), ...(output !== undefined ? { output } : {}) },
});
const answer = (exit: number | "running", seconds: number, session: string, text: string) =>
  `exit_code: ${exit}\nseconds: ${seconds}\nsession_id: ${session}\ntext:\n${text}`;
const one = (message: ChatMessage) => rowsOf([message])[0] as Call;
const PAGE =
  "### Ran Playwright code\n```js\nawait page.click();\n```\n### Page\n- Page URL: http://localhost:4173/checkout\n- Page Title: Checkout\n### Snapshot\n- [Snapshot](page-1.yml)";

test("a command reads as itself, under any slot, and how it ended", () => {
  const ran = one(
    call(
      "box_7__exec_command",
      { cmd: "npm ci", workdir: "app" },
      answer(0, 22.1, "none", "added 812"),
    ),
  );
  assert.equal(ran.kind, "command");
  assert.equal(lineOfRow(ran), "Ran npm ci");
  const bad = one(
    call("computer__exec_command", { cmd: "npm test" }, answer(1, 9.2, "none", "FAIL")),
  );
  assert.equal(lineOfRow(bad), "npm test failed, exit 1");
  const going = one(
    call("computer__exec_command", { cmd: "npm test" }, answer("running", 10, "ab", "RUN")),
  );
  assert.equal(going.state, "running");
  assert.equal(lineOfRow(going), "Running npm test");
  assert.equal(
    one(call("computer__exec_command", { cmd: "x" }, undefined, "running")).state,
    "running",
  );
});

test("polls join their command: output, the time since it began, and how it ended", () => {
  const rows = rowsOf([
    call("c__exec_command", { cmd: "npm test" }, answer("running", 10, "ab", "RUN"), "done", 0),
    call("c__write_stdin", { session_id: "ab" }, answer("running", 5, "ab", "one"), "done", 30),
    call("c__write_stdin", { session_id: "ab" }, answer(0, 3, "none", "two"), "done", 60),
  ]);
  assert.equal(rows.length, 1);
  const [row] = rows as [Extract<Call, { kind: "command" }>];
  assert.equal(row.output, "RUN\none\ntwo");
  assert.equal(row.state, "done");
  assert.equal(row.exit, 0);
  assert.equal(row.seconds, 63);
});

test("an interrupt is a stop, not a failure; input shows; an orphan poll still reads", () => {
  const rows = rowsOf([
    call("c__exec_command", { cmd: "npm run dev" }, answer("running", 3, "cd", "ready"), "done", 0),
    call(
      "c__write_stdin",
      { session_id: "cd", chars: "y" },
      answer("running", 1, "cd", ""),
      "done",
      5,
    ),
    call(
      "c__write_stdin",
      { session_id: "cd", chars: "\u0003" },
      answer(130, 0.2, "none", ""),
      "done",
      9,
    ),
  ]);
  const [row] = rows as [Extract<Call, { kind: "command" }>];
  assert.equal(lineOfRow(row), "Stopped npm run dev");
  assert.equal(row.output, "ready\n> y");
  assert.equal(
    lineOfRow(one(call("c__write_stdin", { session_id: "zz" }, answer("running", 5, "zz", "")))),
    "Checked a running command",
  );
});

test("reading folds together; an edit counts its diff from AgentExec's patch format", () => {
  const rows = rowsOf([
    call("c__list", { path: "src" }, "a.ts 12\n"),
    call("c__read", { path: "src/a.ts" }, "1\tx"),
    call("c__read", { path: "src/b.ts" }, "1\ty"),
    call("c__search", { pattern: "pay", path: "src" }, "src/a.ts:1:pay"),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(lineOfRow(rows[0] as Call), "Read 2 files, listed a folder, searched for pay");
  const diff =
    "===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
  const edit = one(call("c__edit", { path: "src/a.ts", old_text: "old", new_text: "new" }, diff));
  assert.deepEqual([edit.kind, lineOfRow(edit)], ["edit", "Edited a.ts"]);
  assert.deepEqual(
    [(edit as { added: number }).added, (edit as { removed: number }).removed],
    [1, 1],
  );
  const made = one(
    call(
      "c__edit",
      { path: "n.ts", old_text: "" },
      "--- n.ts\t\n+++ n.ts\t\n@@ -0,0 +1,1 @@\n+x\n",
    ),
  );
  assert.equal(lineOfRow(made), "Created n.ts");
  const refused = one(
    call(
      "c__edit",
      { path: "a.ts" },
      '{"error":{"code":"x","message":"Nothing matched."}}',
      "refused",
    ),
  );
  assert.equal(lineOfRow(refused), "Couldn't edit a.ts");
  assert.equal((refused as { output: string }).output, "Nothing matched.");
});

test("browser steps follow Playwright's real answers", () => {
  const byElement = one(call("b__browser_click", { element: "Pay now", target: "e19" }, PAGE));
  assert.equal(lineOfRow(byElement), "Clicked Pay now");
  assert.equal((byElement as { url?: string }).url, "http://localhost:4173/checkout");
  assert.equal((byElement as { snapshot?: string }).snapshot, undefined, "a link, not the page");
  assert.equal(lineOfRow(one(call("b__browser_click", { target: "#pay" }, PAGE))), "Clicked #pay");
  const typed = one(
    call(
      "b__browser_type",
      { target: "e14", text: "x" },
      "### Ran Playwright code\n```js\nawait page.fill();\n```",
    ),
  );
  assert.equal(lineOfRow(typed), "Typed in e14");
  assert.equal((typed as { url?: string }).url, undefined);
  const looked = one(
    call(
      "b__browser_snapshot",
      {},
      '### Page\n- Page URL: http://x/\n- Page Title: X\n### Snapshot\n```yaml\n- heading "X"\n```',
    ),
  );
  assert.equal((looked as { snapshot?: string }).snapshot, '- heading "X"');
});

test("web search reads as its query and results, separated as Exa separates them", () => {
  const found = one(
    call(
      "w__web_search_exa",
      { query: "retries", objective: "why" },
      "Title: One\nURL: https://a.example/1\nPublished: x\nAuthor: y\nHighlights: z\n---\nTitle: Two\nURL: https://b.example/2\nHighlights: z",
    ),
  );
  assert.equal(lineOfRow(found), "Searched the web for retries");
  assert.deepEqual((found as { results: unknown[] }).results, [
    { title: "One", url: "https://a.example/1" },
    { title: "Two", url: "https://b.example/2" },
  ]);
  assert.equal(
    lineOfRow(one(call("w__web_fetch_exa", { urls: ["https://a.example/1"] }, "# One\nURL: x"))),
    "Read a.example/1",
  );
});

test("a tool we don't know, or one that only shares a name, stays as it came", () => {
  assert.equal(one(call("github__search_issues", { q: "x" }, "{}")).kind, "other");
  assert.equal(one(call("notes__read", { id: 4 }, "text")).kind, "other", "no path");
  assert.equal(one(call("other__exec_command", { command: "ls" }, "ok")).kind, "other", "no cmd");
  assert.equal(
    one(call("other__exec_command", { cmd: "ls" }, "not the fixed answer")).kind,
    "other",
  );
  assert.equal(one(call("other__edit", { path: "x" }, "saved")).kind, "other", "no diff");
  assert.equal(one(call("b__browser_resize", { width: 1 }, "ok")).kind, "other", "not one we draw");
  const bad = {
    ...call("x__y", {}),
    tool: { name: "x__y", state: "done" as const, input: "not json" },
  };
  assert.equal(one(bad).kind, "other");
});

test("Updates reads coarser: a run of browser steps is one line, and what's said is its first", () => {
  const lines = updatesOf(
    rowsOf([
      {
        id: "s",
        role: "assistant",
        text: "**Found it.**\nMore.",
        at: new Date(start).toISOString(),
      },
      call("b__browser_navigate", { url: "http://x/a" }, PAGE),
      call("b__browser_click", { target: "e1" }, PAGE),
      call("b__browser_type", { target: "e2" }, "### Ran Playwright code"),
    ]),
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    ["Found it.", "Tried localhost:4173/checkout, 3 steps"],
  );
});
