// How tool use is drawn, in a real browser, over the stand-in gateway with answers in real formats.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const answer = (exit: number | "running", seconds: number, session: string, text: string) =>
  `exit_code: ${exit}\nseconds: ${seconds}\nsession_id: ${session}\ntext:\n${text}`;
const page_ = (title: string) =>
  `### Ran Playwright code\n\`\`\`js\nawait page.click();\n\`\`\`\n### Page\n- Page URL: http://localhost:4173/checkout\n- Page Title: ${title}\n### Snapshot\n- [Snapshot](p.yml)`;
const DIFF =
  "Index: src/retry.ts\n===================================================================\n--- src/retry.ts\n+++ src/retry.ts\n@@ -1,2 +1,2 @@\n-  return session.pay(cart);\n+  return newSession().pay(cart);\n }\n";

let id = 0;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const tool = (
  name: string,
  input: unknown,
  output: string,
  minutes: number,
  state: "done" | "refused" = "done",
): Agent["chat"]["messages"][number] => ({
  id: `t${++id}`,
  role: "tool",
  text: name,
  at: ago(minutes),
  tool: { name, state, input: JSON.stringify(input), output },
});
const said = (text: string, minutes: number): Agent["chat"]["messages"][number] => ({
  id: `s${++id}`,
  role: "assistant",
  text,
  at: ago(minutes),
});

/** One task: a slot name of its own on every tool. */
const task = () => [
  { id: `u${++id}`, role: "user" as const, text: "Why do checkouts fail?", at: ago(9) },
  tool("github__search_issues", { q: "is:open" }, '{"total_count":14}', 9),
  said("Reproducing it now.", 8.5),
  tool(
    "net__web_search_exa",
    { query: "session retries" },
    "Title: Sessions\nURL: https://docs.example.com/s\nHighlights: x",
    8,
  ),
  tool(
    "pc__exec_command",
    { cmd: "npm test", workdir: "shop" },
    answer(1, 9.2, "none", "FAIL retry.test\nTests 1 failed"),
    7,
  ),
  tool("pc__read", { path: "shop/src/retry.ts" }, "1\tx", 6.5),
  tool("pc__read", { path: "shop/src/session.ts" }, "1\ty", 6.4),
  tool(
    "pc__exec_command",
    { cmd: "npm run dev" },
    answer("running", 3, "dev1", "Local: http://localhost:4173/"),
    6,
  ),
  tool("web2__browser_navigate", { url: "http://localhost:4173/checkout" }, page_("Checkout"), 5),
  tool(
    "web2__browser_type",
    { target: "e14", text: "4000" },
    "### Ran Playwright code\n```js\nawait page.fill();\n```",
    4.5,
  ),
  tool("web2__browser_click", { element: "Pay now", target: "e19" }, page_("Checkout"), 4),
  tool(
    "pc__edit",
    { path: "shop/src/retry.ts", old_text: "x" },
    "old_text isn't in the file.",
    3.5,
    "refused",
  ),
  tool("pc__edit", { path: "shop/src/retry.ts", old_text: "y" }, DIFF, 3),
  tool("pc__exec_command", { cmd: "npm run e2e" }, answer("running", 10, "e2e1", "RUN\n"), 2),
  tool(
    "pc__write_stdin",
    { session_id: "e2e1" },
    answer("running", 5, "e2e1", "still going\n"),
    0.5,
  ),
];

async function open(
  gateway: Gateway,
  hash: string,
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withTask = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.chat.messages = task();
    research.chat.status = { state: "idle" };
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const openChat = async (page: Page) => {
  await page.getByRole("main").getByRole("button", { name: "Chat", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Chats" });
  await panel.getByRole("button", { name: /npm test/ }).waitFor();
  return panel;
};

test(
  "a call in the chat is one line saying what it did, and opens to the detail",
  withTask(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const chat = await openChat(page);
    const buttons = chat.getByRole("button");
    const names = (await buttons.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    for (const line of [
      "github__search_issues",
      "Searched the web for session retries 1",
      "npm test exit 1 9.2 s",
      "Read 2 files",
      "npm run dev",
      "Opened localhost:4173/checkout",
      "Clicked Pay now",
      "Couldn't edit retry.ts Refused",
      "Edited retry.ts +1 −1",
      "npm run e2e",
    ])
      assert.ok(names.includes(line), `missing "${line}" in ${JSON.stringify(names)}`);
    assert.equal(
      names.some((n) => n.includes("write_stdin")),
      false,
      "a poll is part of its command",
    );

    await chat.getByRole("button", { name: /npm run e2e/ }).click();
    await chat.getByText("still going", { exact: false }).waitFor();
    await chat.getByRole("button", { name: /^Edited retry/ }).click();
    const added = chat.locator(".diff-code-insert");
    assert.match(await added.innerText(), /newSession/);
    await chat.getByRole("button", { name: /github__search_issues/ }).click();
    await chat.getByText('"total_count":14', { exact: false }).waitFor();
    await chat.getByRole("button", { name: /^Searched the web/ }).click();
    assert.equal(
      await chat.getByRole("link", { name: "Sessions" }).getAttribute("href"),
      "https://docs.example.com/s",
    );
    await chat.getByText("Typed in e14").waitFor();
    await page.close();
  }),
);

test(
  "the frames show what ran, what's still running, what changed, and the task in lines",
  withTask(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const computer = page.getByRole("region", { name: "Computer" });
    await computer.getByText("npm test").waitFor();
    const text = await computer.innerText();
    assert.match(text, /exit 1/);
    assert.match(text, /Tests 1 failed/);
    assert.match(text, /npm run e2e[\s\S]*checked \d+ s ago[\s\S]*still going/);
    assert.match(text, /npm run dev[\s\S]*checked 6 min ago/);
    const files = page.getByRole("region", { name: "Changed files" });
    assert.match(await files.innerText(), /shop\/src\/retry\.ts\s+\+1 −1/);

    await files.getByRole("button", { name: /retry\.ts/ }).click();
    const diff = page.getByRole("dialog", { name: "shop/src/retry.ts" });
    assert.match(await diff.locator(".diff-code-delete").innerText(), /session\.pay/);
    await page.keyboard.press("Escape");
    await diff.waitFor({ state: "detached" });
    await computer.getByRole("button", { name: /exit 1/ }).click();
    const output = page.getByRole("dialog", { name: "npm test" });
    await output.getByText("in shop · Exit 1 · 9.2 s").waitFor();
    await page.keyboard.press("Escape");
    await output.waitFor({ state: "detached" });

    const browserFrame = page.getByRole("region", { name: "Browser" });
    assert.deepEqual((await browserFrame.innerText()).split("\n").slice(1), [
      "localhost:4173/checkout",
      "Checkout",
      "Opened localhost:4173/checkout",
      "Typed in e14",
      "Clicked Pay now",
    ]);

    assert.equal(await page.getByRole("region", { name: "Updates" }).count(), 0);
    assert.equal(await computer.getByRole("list").count(), 0, "changed files are their own list");
    await page.close();
  }),
);

test(
  "a frame with nothing to show stays dashed, and frames keep their size as work arrives",
  withTask(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const browserFrame = page.getByRole("region", { name: "Browser" });
    await browserFrame.waitFor();
    assert.match((await browserFrame.getAttribute("class")) ?? "", /border-dashed/);
    await page.close();

    const live = await open(gateway, "#/a/a-research");
    const frames = ["Computer", "Browser", "Changed files"].map((name) =>
      live.getByRole("region", { name }),
    );
    await frames[0]?.getByText("npm test").waitFor();
    const before = await Promise.all(frames.map((f) => f.boundingBox()));
    gateway.addMessage(
      "a-research",
      tool("pc__exec_command", { cmd: "npm run lint" }, answer(0, 1.1, "none", "ok"), 0),
    );
    await frames[0]?.getByText("npm run lint").waitFor();
    assert.deepEqual(await Promise.all(frames.map((f) => f.boundingBox())), before);
    await live.close();
  }),
);

test(
  "'Built from' names the units, and at phone width nothing runs off the side",
  withTask(async (gateway) => {
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    const common = {
      provider: "units",
      needs: {},
      status: { state: "connected" as const },
      values: {},
    };
    research.units = [
      { ...common, instance: "i1", unit: "computer", title: "Computer" },
      { ...common, instance: "i2", unit: "web", title: "Web" },
    ];
    const page = await open(gateway, "#/a/a-research", { width: 390, height: 844 });
    await page
      .getByRole("main")
      .getByRole("button", { name: /Built from/ })
      .getByText("Computer, Web")
      .waitFor();
    const computer = page.getByRole("region", { name: "Computer" });
    await computer.getByText("npm test").waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    const box = await computer.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    await page.close();
  }),
);

test(
  "the Now line says what stopped it and offers what can be done",
  withTask(async (gateway) => {
    const page = await open(gateway, "#/a/a-broken");
    const now = page.getByRole("status", { name: "Now" });
    await now.getByText("Its program exited.").waitFor();
    await now.getByRole("button", { name: "Start" }).click();
    await page.waitForTimeout(300);
    assert.ok(gateway.calls.some((c) => c.method === "start" && c.input.agent === "a-broken"));
    await page.close();

    const research = await open(gateway, "#/a/a-research");
    const line = research.getByRole("status", { name: "Now" });
    await line.waitFor();
    // A problem with nothing to do about it is said, with no control.
    gateway.failChat("a-research", {
      code: "unavailable",
      message: "ChatGPT plan usage is unavailable right now.",
    });
    await line.getByText("ChatGPT plan usage is unavailable right now.").waitFor();
    assert.equal(await line.getByRole("button").count(), 0);

    gateway.failChat("a-research", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    const opened = research.context().waitForEvent("page");
    await line.getByRole("button", { name: "Manage usage" }).click();
    assert.match((await opened).url(), /chatgpt\.com\/settings\/usage|about:blank/);
    // At work again, its line says so and offers nothing; the problem is said again if that fails.
    gateway.setChatStatus("a-research", { state: "working" });
    await line.getByRole("button").waitFor({ state: "detached" });
    gateway.failChat("a-research", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await line.getByRole("button", { name: "Manage usage" }).waitFor();

    // Its chat's next reply ends the problem.
    gateway.addMessage("a-research", {
      id: "after",
      role: "assistant",
      text: "Back.",
      at: new Date().toISOString(),
    });
    await line.getByRole("button").waitFor({ state: "detached" });
    await research.close();
  }),
);
