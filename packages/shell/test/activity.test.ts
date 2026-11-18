// What an agent does, in one place: the Activity box on its Overview and the window it opens into,
// in a real browser over the stand-in gateway, with calls in the formats the tools really answer.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { computerWith } from "./design/samples.ts";
import { SESSION, standIn, type Work } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
type Entry = Work["entries"][number];
const answer = (exit: number | "running", seconds: number, session: string, text: string) =>
  `exit_code: ${exit}\nseconds: ${seconds}\nsession_id: ${session}\ntext:\n${text}`;
const page_ = (title: string) =>
  `### Ran Playwright code\n\`\`\`js\nawait page.click();\n\`\`\`\n### Page\n- Page URL: http://localhost:4173/checkout\n- Page Title: ${title}\n### Snapshot\n- [Snapshot](p.yml)`;
const DIFF =
  "Index: src/retry.ts\n===================================================================\n--- src/retry.ts\n+++ src/retry.ts\n@@ -1,2 +1,2 @@\n-  return session.pay(cart);\n+  return newSession().pay(cart);\n }\n";

let id = 0;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const call = (
  name: string,
  input: unknown,
  output: string | undefined,
  minutes: number,
  state: "done" | "refused" | "running" = "done",
): Entry => ({
  id: `e${++id}`,
  at: ago(minutes),
  call: {
    name,
    state,
    input: JSON.stringify(input),
    ...(output === undefined ? {} : { output }),
  },
});
const words = (text: string, minutes: number): Entry => ({
  id: `e${++id}`,
  at: ago(minutes),
  words: text,
});

/** One piece of work, its tools each under a slot of its own: more than one page of it is read. */
const task = (): Entry[] => [
  call("github__search_issues", { q: "is:open" }, '{"total_count":14}', 9),
  words("Reproducing it now.", 8.5),
  call(
    "net__web_search_exa",
    { query: "session retries" },
    "Title: Sessions\nURL: https://docs.example.com/s\nHighlights: x",
    8,
  ),
  call(
    "pc__exec_command",
    { cmd: "npm test", workdir: "shop" },
    answer(1, 9.2, "none", "FAIL retry.test\nTests 1 failed"),
    7,
  ),
  call("pc__read", { path: "shop/src/retry.ts" }, "1\tx", 6.5),
  call("pc__read", { path: "shop/src/session.ts" }, "1\ty", 6.4),
  call("pc__exec_command", { cmd: "npm run dev" }, answer("running", 3, "dev1", "Local: x"), 6),
  call("web2__browser_navigate", { url: "http://localhost:4173/checkout" }, page_("Checkout"), 5),
  call(
    "web2__browser_type",
    { target: "e14", text: "4000" },
    "### Ran Playwright code\n```js\nawait page.fill();\n```",
    4.5,
  ),
  call("web2__browser_click", { element: "Pay now", target: "e19" }, page_("Checkout"), 4),
  call(
    "pc__edit",
    { path: "shop/src/retry.ts", old_text: "x" },
    "old_text isn't in the file.",
    3.5,
    "refused",
  ),
  ...Array.from({ length: 20 }, (_, n) =>
    call("pc__read", { path: `shop/src/part${n}.ts` }, "1\tz", 3.4 - n * 0.01),
  ),
  call("pc__edit", { path: "shop/src/retry.ts", old_text: "y" }, DIFF, 3),
  call("pc__exec_command", { cmd: "npm run e2e" }, answer("running", 10, "e2e1", "RUN\n"), 2),
  call(
    "pc__write_stdin",
    { session_id: "e2e1" },
    answer("running", 5, "e2e1", "still going\n"),
    0.5,
  ),
];
/** Three calls of one piece of work, the last still going. */
const three = (minutes: number): Entry[] => [
  call("github__get_issue", { n: 1 }, "the issue", minutes + 2),
  call("github__get_pr", { n: 2 }, "the pull request", minutes + 1),
  call("github__list_files", { n: 2 }, undefined, minutes, "running"),
];

/** The page at `hash`; with `time`, its clock says that time until the test moves it. */
async function open(gateway: Gateway, hash: string, width = 1440, time?: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  if (time !== undefined) await page.clock.setFixedTime(time);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const box = (page: Page) => page.getByRole("main").getByRole("region", { name: "Activity" });
const lines = (where: ReturnType<typeof box>) =>
  where
    .locator("[data-call]")
    .evaluateAll((all) =>
      all.map((one) => (one as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    );

test(
  "Overview is an agent's last tab, and its Activity has the latest calls under their pieces of work, newest first",
  withGateway(async (gateway) => {
    const reviewer = gateway.agents.get("a-reviewer");
    assert.ok(reviewer);
    reviewer.works = [
      {
        id: "w1",
        title: "Review #482",
        state: "working",
        at: ago(0),
        entries: [...three(4), ...three(1)],
      },
      {
        id: "w2",
        title: "Which issues are oldest?",
        state: "idle",
        at: ago(130),
        entries: [
          call("github__search_issues", { q: "old" }, "[]", 132),
          words("Three are.", 131),
          call("github__get_issue", { n: 212 }, "#212", 130),
        ],
      },
      { id: "w3", title: "An older one", state: "idle", at: ago(3000), entries: three(3000) },
    ];
    const page = await open(gateway, "#/a/a-reviewer");
    const tabs = page.getByRole("main").getByRole("tablist");
    await tabs.getByRole("tab", { name: "Overview" }).waitFor();
    assert.deepEqual(await tabs.getByRole("tab").allInnerTexts(), ["Chats", "Overview"]);
    await tabs.getByRole("tab", { name: "Overview" }).click();
    assert.match(page.url(), /#\/team\/a-reviewer\/overview$/);
    const activity = box(page);
    await activity.getByRole("region", { name: "Review #482" }).waitFor();
    // Six calls at most, three of each, newest piece first; what was written and not sent isn't here.
    assert.deepEqual(
      await activity
        .getByRole("region")
        .evaluateAll((all) => all.map((one) => one.getAttribute("aria-label"))),
      ["Review #482", "Which issues are oldest?", "An older one"],
    );
    for (const [title, count] of [
      ["Review #482", 3],
      ["Which issues are oldest?", 2],
      ["An older one", 1],
    ] as const)
      assert.equal(
        await activity.getByRole("region", { name: title }).locator("[data-call]").count(),
        count,
        title,
      );
    assert.equal(await activity.getByText("Three are.").count(), 0);
    // Beside each title: a green dot and "Working" while it is worked on, else when it last did something.
    const working = activity.getByRole("region", { name: "Review #482" });
    await working.getByRole("img", { name: "Working" }).waitFor();
    assert.match(await working.locator("h3 + span").innerText(), /Working/);
    assert.equal(
      (
        await activity
          .getByRole("region", { name: "Which issues are oldest?" })
          .locator("h3 + span")
          .innerText()
      ).trim(),
      "2 h",
    );
    // A call still going turns.
    assert.equal(await working.locator(".animate-spin").count(), 1);
    await activity.getByRole("button", { name: "Expand" }).waitFor();
    await page.close();
  }),
);

test(
  "Expand opens all of it as the layer's window: every call in order with the words between, each opening to what it did",
  withGateway(async (gateway) => {
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.works = [
      {
        id: "w-task",
        title: "Why do checkouts fail?",
        state: "idle",
        at: ago(0.5),
        entries: task(),
      },
    ];
    const page = await open(gateway, "#/a/a-research/overview");
    await box(page).getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("region", { name: "Research's activity" });
    await window.getByText("Reproducing it now.").waitFor();
    // Every entry, the pages before the latest read too, in the order they happened, once each; a
    // poll is part of its command.
    assert.deepEqual(await lines(window as ReturnType<typeof box>), [
      "github__search_issues",
      "Searched the web for session retries 1",
      "npm test exit 1 9.2 s",
      "Read 2 files",
      "npm run dev",
      "Opened localhost:4173/checkout",
      "Typed in e14",
      "Clicked Pay now",
      "Couldn't edit retry.ts Refused",
      "Read 20 files",
      "Edited retry.ts +1 −1",
      "npm run e2e",
    ]);
    // A call opens to what it did.
    await window.getByRole("button", { name: /npm run e2e/ }).click();
    await window.getByText("still going", { exact: false }).waitFor();
    await window.getByRole("button", { name: /^Edited retry/ }).click();
    assert.match(await window.locator(".diff-code-insert").innerText(), /newSession/);
    await window.getByRole("button", { name: /^Searched the web/ }).click();
    assert.equal(
      await window.getByRole("link", { name: "Sessions" }).getAttribute("href"),
      "https://docs.example.com/s",
    );
    // It is for reading: nothing in it but the calls opening, and its own Close.
    await page.getByRole("button", { name: "Close Research's activity" }).click();
    await window.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "one window at a time: an agent's computer, opened from a chat, takes its activity's place",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal", false);
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.works = [
      { id: "w1", title: "Checkouts", state: "idle", at: ago(1), entries: three(1) },
    ];
    const page = await open(gateway, "#/a/a-research/overview");
    await box(page).getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("group", { name: "Window" });
    await window.getByRole("region", { name: "Research's activity" }).waitFor();
    // The chat beside it opens the agent's computer in the same place.
    await page.getByRole("button", { name: /^Chats/ }).click();
    const chats = page.getByRole("complementary", { name: "Chats" });
    await chats
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Research" })
      .first()
      .click();
    await chats.getByRole("button", { name: "Research's computer" }).click();
    await window.getByRole("region", { name: "Research's computer" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Research's activity" }).count(), 0);
    assert.equal(await window.count(), 1);
    await page.close();
  }),
);

test(
  "the box says when there is nothing yet, when it can't be read, and draws a call going when its work stopped as ended",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer/overview");
    await box(page).getByText("No activity", { exact: true }).waitFor();
    assert.equal(await box(page).getByRole("button", { name: "Expand" }).count(), 0);
    // A piece of work that stopped with a call still going: that call ended there.
    gateway.setWorks("a-reviewer", [
      { id: "w1", title: "Checkouts", state: "stopped", at: ago(5), entries: three(5) },
    ]);
    const piece = box(page).getByRole("region", { name: "Checkouts" });
    await piece.waitFor();
    assert.equal(await piece.locator("[data-call]").count(), 3);
    assert.equal(await piece.locator(".animate-spin").count(), 0);
    assert.equal(await piece.getByRole("img", { name: "Working" }).count(), 0);
    await page.close();
    // Its Work can't be read: it says so where the calls would be.
    gateway.refuseEvery("work.call", "unavailable", "Not now.");
    const late = await open(gateway, "#/a/a-reviewer/overview");
    await box(late).getByText("Can't be read right now", { exact: true }).waitFor();
    await late.close();
  }),
);

test(
  "the box follows its Work: a change there is drawn without the page being read again",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer/overview");
    await box(page).getByText("No activity", { exact: true }).waitFor();
    gateway.setWorks("a-reviewer", [
      { id: "w1", title: "A new one", state: "working", at: ago(0), entries: three(0) },
    ]);
    await box(page).getByRole("region", { name: "A new one" }).waitFor();
    await page.close();
  }),
);

test(
  "the box reads further back for its calls: words between them take none of its places, and a poll shows its command",
  withGateway(async (gateway) => {
    const reviewer = gateway.agents.get("a-reviewer");
    assert.ok(reviewer);
    reviewer.works = [
      {
        id: "w1",
        title: "Words between",
        state: "idle",
        at: ago(1),
        entries: [
          ...three(9),
          words("One.", 3),
          call("github__get_issue", { n: 9 }, "#9", 2),
          words("Two.", 1),
        ],
      },
      {
        id: "w2",
        title: "A long test",
        state: "working",
        at: ago(0),
        entries: [
          call("pc__exec_command", { cmd: "npm test" }, answer("running", 10, "t1", "RUN\n"), 6),
          ...[5, 4, 3].map((m) =>
            call("pc__write_stdin", { session_id: "t1" }, answer("running", 5, "t1", ""), m),
          ),
        ],
      },
    ];
    const page = await open(gateway, "#/a/a-reviewer/overview");
    const between = box(page).getByRole("region", { name: "Words between" });
    await between.locator("[data-call]").nth(2).waitFor();
    assert.deepEqual(await lines(between as ReturnType<typeof box>), [
      "github__get_pr",
      "github__list_files",
      "github__get_issue",
    ]);
    const long = box(page).getByRole("region", { name: "A long test" });
    await long.getByText("npm test").waitFor();
    assert.deepEqual(await lines(long as ReturnType<typeof box>), ["npm test"]);
    await page.close();
  }),
);

test(
  "the window follows its Work: what is new comes under what it had, once each",
  withGateway(async (gateway) => {
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    const first = three(30);
    research.works = [
      { id: "w1", title: "Checkouts", state: "working", at: ago(0), entries: first },
    ];
    const page = await open(gateway, "#/a/a-research/overview");
    await box(page).getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("region", { name: "Research's activity" });
    await window.locator("[data-call]").nth(2).waitFor();
    // More than its latest few at once: those in between are read too.
    const next = [...first, ...three(20), ...three(10)];
    gateway.setWorks("a-research", [
      { id: "w1", title: "Checkouts", state: "working", at: ago(0), entries: next },
    ]);
    await window.locator("[data-call]").nth(8).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await window.locator("[data-call]").count(), 9);
    await page.close();
  }),
);

test(
  "a command still going when its work stopped is drawn as ended",
  withGateway(async (gateway) => {
    const reviewer = gateway.agents.get("a-reviewer");
    assert.ok(reviewer);
    reviewer.works = [
      {
        id: "w1",
        title: "Stopped mid-way",
        state: "stopped",
        at: ago(2),
        entries: [
          call("pc__exec_command", { cmd: "npm run dev" }, answer("running", 3, "d1", "Local"), 2),
        ],
      },
    ];
    const page = await open(gateway, "#/a/a-reviewer/overview");
    const piece = box(page).getByRole("region", { name: "Stopped mid-way" });
    await piece.getByText("npm run dev").waitFor();
    assert.equal(await piece.locator(".animate-spin").count(), 0);
    await page.close();
  }),
);

test(
  "the window has every piece of work, the older ones read a page of pieces at a time",
  withGateway(async (gateway) => {
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.works = Array.from({ length: 14 }, (_, n) => ({
      id: `w${n}`,
      title: `Piece ${n + 1}`,
      state: "idle" as const,
      at: ago(n * 10),
      entries: three(n * 10),
    }));
    const page = await open(gateway, "#/a/a-research/overview");
    // The box has the newest, and asks for no older pieces.
    await box(page).getByRole("region", { name: "Piece 1" }).waitFor();
    const pieces = () =>
      gateway.calls.filter((call) => {
        const asked = (call.input as { arguments?: Record<string, unknown> }).arguments;
        return call.method === "call" && asked?.before !== undefined && asked.work === undefined;
      }).length;
    assert.equal(pieces(), 0);
    await box(page).getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("region", { name: "Research's activity" });
    await window.getByRole("region", { name: "Piece 14" }).waitFor();
    assert.deepEqual(
      await window
        .locator("section[aria-label^='Piece']")
        .evaluateAll((all) => all.map((one) => one.getAttribute("aria-label"))),
      Array.from({ length: 14 }, (_, n) => `Piece ${n + 1}`),
    );
    assert.equal(pieces(), 2, "two pages of pieces after the first");
    await page.close();
  }),
);

/** An ISO 8601 time so many seconds after `from`. */
const after = (from: number, seconds: number) => new Date(from + seconds * 1000).toISOString();
/** Waits until `where` says exactly `words`. */
const says = (where: Locator, words: string) => {
  const escaped = words.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  return where.filter({ hasText: new RegExp(`^${escaped}$`) }).waitFor();
};
/** How a piece of work stands, beside its title. */
const head = (where: Locator, title: string) =>
  where.getByRole("region", { name: title }).locator("h3 + span");

test(
  "a piece of work whose request is tried again says so in Working's place, counting down to now, in the box and the window, until it isn't",
  withGateway(async (gateway) => {
    const start = Date.now();
    const reviewer = gateway.agents.get("a-reviewer");
    assert.ok(reviewer);
    const retrying = { attempt: 3, of: 10, at: after(start, 12) };
    const triage = {
      id: "w2",
      title: "Triage",
      state: "working" as const,
      at: ago(0),
      entries: three(2),
    };
    reviewer.works = [
      {
        id: "w1",
        title: "Review #482",
        state: "working",
        at: ago(0),
        entries: three(1),
        retrying,
      },
      triage,
    ];
    const page = await open(gateway, "#/a/a-reviewer/overview", 1440, start);
    await says(head(box(page), "Review #482"), "Retrying in 12 s · attempt 3 of 10");
    // The same dot, and a piece not tried again says Working.
    await head(box(page), "Review #482").getByRole("img", { name: "Working" }).waitFor();
    await says(head(box(page), "Triage"), "Working");
    // It counts down by itself, and says "now" once the time has come.
    await page.clock.setFixedTime(start + 5_000);
    await says(head(box(page), "Review #482"), "Retrying in 7 s · attempt 3 of 10");
    await page.clock.setFixedTime(start + 12_000);
    await says(head(box(page), "Review #482"), "Retrying now · attempt 3 of 10");
    // The window says it on the same head.
    await box(page).getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("region", { name: "Reviewer's activity" });
    await says(head(window, "Review #482"), "Retrying now · attempt 3 of 10");
    await says(head(window, "Triage"), "Working");
    // No longer tried again: Working, in both.
    gateway.setWorks("a-reviewer", [
      { id: "w1", title: "Review #482", state: "working", at: ago(0), entries: three(1) },
      triage,
    ]);
    await says(head(box(page), "Review #482"), "Working");
    await says(head(window, "Review #482"), "Working");
    await page.close();
  }),
);

test(
  "the agent's own request tried again is said on its line, in Working's place, before a piece's, which is said on the piece; neither in its conversation",
  withGateway(async (gateway) => {
    const start = Date.now();
    const page = await open(gateway, "#/a/a-research", 1440, start);
    const line = page.getByRole("status", { name: "State" });
    // An Activity that says nothing of it, as an older one doesn't: Working, as it was.
    await says(line, "Working");
    gateway.setRetrying("a-research", { attempt: 1, of: 10, at: after(start, 12) });
    await says(line, "Retrying in 12 s · attempt 1 of 10");
    assert.match(
      (await line.locator("span").first().getAttribute("class")) ?? "",
      /bg-\[var\(--ok\)\] pulse/,
    );
    await page.clock.setFixedTime(start + 12_000);
    await says(line, "Retrying now · attempt 1 of 10");
    // Its conversation holds what was said, and nothing of this.
    await page.getByRole("button", { name: "Message" }).click();
    const chats = page.getByRole("complementary", { name: "Chats" });
    await chats.getByText("Why are checkouts failing?").waitFor();
    assert.equal(await chats.getByText(/Retrying/).count(), 0);
    // With a piece's too, each says its own: the line its own, though the piece's begins first.
    const checkouts = {
      id: "w1",
      title: "Checkouts",
      state: "working" as const,
      at: ago(0),
      entries: three(1),
    };
    gateway.setWorks("a-research", [
      { ...checkouts, retrying: { attempt: 3, of: 10, at: after(start, 20) } },
    ]);
    await page.getByRole("main").getByRole("tab", { name: "Overview" }).click();
    await says(head(box(page), "Checkouts"), "Retrying in 8 s · attempt 3 of 10");
    gateway.setRetrying("a-research", { attempt: 2, of: 10, at: after(start, 30) });
    await says(line, "Retrying in 18 s · attempt 2 of 10");
    await says(head(box(page), "Checkouts"), "Retrying in 8 s · attempt 3 of 10");
    // Its own no longer tried again: its line says the piece's, which the piece keeps.
    gateway.setRetrying("a-research");
    await says(line, "Retrying in 8 s · attempt 3 of 10");
    await says(head(box(page), "Checkouts"), "Retrying in 8 s · attempt 3 of 10");
    await page.close();
  }),
);

test(
  "with none of its own, the agent's line says the retry of the piece of work whose next try begins first, until none is; never its conversation",
  withGateway(async (gateway) => {
    const start = Date.now();
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    const piece = (id: string, title: string, retrying?: Work["retrying"]) => ({
      id,
      title,
      state: "working" as const,
      at: ago(0),
      entries: three(id === "w1" ? 1 : 2),
      ...(retrying ? { retrying } : {}),
    });
    const checkouts = { attempt: 2, of: 10, at: after(start, 20) };
    research.works = [piece("w1", "Checkouts", checkouts), piece("w2", "Logs")];
    // On the tab it opens on, where no piece of work is shown.
    const page = await open(gateway, "#/a/a-research", 1440, start);
    const line = page.getByRole("status", { name: "State" });
    await says(line, "Retrying in 20 s · attempt 2 of 10");
    assert.match(
      (await line.locator("span").first().getAttribute("class")) ?? "",
      /bg-\[var\(--ok\)\] pulse/,
    );
    // Two tried again: the one whose next try begins first, though it is listed after.
    gateway.setWorks("a-research", [
      piece("w1", "Checkouts", checkouts),
      piece("w2", "Logs", { attempt: 1, of: 10, at: after(start, 5) }),
    ]);
    await says(line, "Retrying in 5 s · attempt 1 of 10");
    await page.clock.setFixedTime(start + 5_000);
    await says(line, "Retrying now · attempt 1 of 10");
    // That one's retry ends: the other's.
    gateway.setWorks("a-research", [piece("w1", "Checkouts", checkouts), piece("w2", "Logs")]);
    await says(line, "Retrying in 15 s · attempt 2 of 10");
    // Its conversation holds what was said, and nothing of this.
    await page.getByRole("button", { name: "Message" }).click();
    const chats = page.getByRole("complementary", { name: "Chats" });
    await chats.getByText("Why are checkouts failing?").waitFor();
    assert.equal(await chats.getByText(/Retrying/).count(), 0);
    // None tried again while it still works: Working, with the same dot.
    gateway.setWorks("a-research", [piece("w1", "Checkouts"), piece("w2", "Logs")]);
    await says(line, "Working");
    assert.match(
      (await line.locator("span").first().getAttribute("class")) ?? "",
      /bg-\[var\(--ok\)\] pulse/,
    );
    await page.close();
  }),
);
