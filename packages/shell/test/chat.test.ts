// The chat page in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, agent = "a-reviewer", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/${agent}/chat`);
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await page.getByText("Reviewed #482").first().waitFor();
  return page;
}
const input = (page: Page) => page.getByRole("textbox", { name: "Message" });

const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "Enter sends and empties the box, and Shift+Enter makes a new line",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("first line");
    await input(page).press("Shift+Enter");
    await input(page).pressSequentially("second line");
    assert.equal(await input(page).inputValue(), "first line\nsecond line");
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "not sent yet");
    await input(page).press("Enter");
    assert.equal(await input(page).inputValue(), "");
    await page.getByText(/first line/).waitFor();
    await page.close();
  }),
);

test(
  "a sent message shows at once, once, and stays where it is when the record has it",
  withGateway(async (gateway) => {
    gateway.delaySends(1200);
    const page = await open(gateway);
    await input(page).fill("slow to record");
    await input(page).press("Enter");
    const sent = page.getByText("slow to record");
    await sent.waitFor();
    await page.waitForTimeout(400);
    const before = await sent.boundingBox();
    await page.waitForTimeout(1200);
    assert.equal(await sent.count(), 1, "never twice");
    assert.deepEqual(await sent.boundingBox(), before);
    await page.close();
  }),
);

test(
  "a refused send goes, and its text is back in the box",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "A turn is running.");
    const page = await open(gateway);
    await input(page).fill("refuse this");
    await input(page).press("Enter");
    await page.getByRole("alert").getByText("A turn is running.").waitFor();
    assert.equal(await input(page).inputValue(), "refuse this");
    await page.close();
  }),
);

test(
  "a reply reveals word by word, then settles as one message with no spans",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.setChatStatus("a-reviewer", { state: "thinking" });
    await page.getByRole("status").getByText("Thinking").waitFor();
    gateway.delta("a-reviewer", "r1", "Three causes ");
    await page.locator("[data-sd-animate]").first().waitFor();
    const thinking = page.getByRole("status").filter({ hasText: "Thinking" });
    assert.equal(await thinking.count(), 0, "the first words take its place");
    gateway.delta("a-reviewer", "r1", "explain it.");
    await page.getByText("explain it.").waitFor();
    gateway.addMessage("a-reviewer", reply("r1", "Three causes explain it."));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await page.getByText("Three causes explain it.").waitFor();
    assert.equal(await page.getByText("Three causes explain it.").count(), 1);
    assert.equal(await page.locator("[data-sd-animate]").count(), 0);
    await page.close();
  }),
);

test(
  "a tool call is one row that ends in place, and opens for what went in and came back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const at = new Date().toISOString();
    const running = {
      id: "t1",
      role: "tool" as const,
      text: "github__get_issue",
      at,
      tool: { name: "github__get_issue", state: "running" as const, input: '{"n":1}' },
    };
    gateway.setChatStatus("a-reviewer", { state: "tool" });
    gateway.addMessage("a-reviewer", running);
    const row = page.getByRole("button", { name: /github__get_issue/ });
    await row.waitFor();
    const before = await row.boundingBox();
    gateway.addMessage("a-reviewer", {
      ...running,
      tool: { ...running.tool, state: "done", output: "the issue" },
    });
    await row.getByRole("img", { name: "done" }).or(page.getByLabel("done")).first().waitFor();
    assert.equal(await row.count(), 1);
    assert.deepEqual(await row.boundingBox(), before);
    await row.click();
    await page.getByText("→ the issue").waitFor();
    await page.close();
  }),
);

test(
  "Stop cancels, and Retry replaces the reply, or restores it when refused",
  withGateway(async (gateway) => {
    gateway.addMessage("a-reviewer", {
      id: "u1",
      role: "user",
      text: "Again",
      at: new Date().toISOString(),
    });
    gateway.addMessage("a-reviewer", reply("r2", "The old answer."));
    const page = await open(gateway);
    await page.getByText("The old answer.").waitFor();

    gateway.refuseNext("chat.retry", "busy", "A turn is running.");
    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByRole("alert").getByText("A turn is running.").waitFor();
    await page.getByText("The old answer.").waitFor();

    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByText("The old answer.").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Stop" }).waitFor();
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Send" }).waitFor();
    assert.ok(gateway.calls.some((c) => c.method === "cancel"));
    await page.close();
  }),
);

test(
  "a turn ending in a usage limit offers the plan's page",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.setChatStatus("a-reviewer", {
      state: "error",
      detail: { code: "usage_limit", message: "Limit." },
    });
    const notice = page.getByRole("alert");
    await notice.getByText("Usage limit reached").waitFor();
    await notice.getByRole("button", { name: "Manage usage" }).waitFor();
    await page.close();
  }),
);

test(
  "earlier messages load on asking, and the model isn't in the chat",
  withGateway(async (gateway) => {
    const chat = gateway.agents.get("a-reviewer");
    assert.ok(chat);
    const at = new Date(Date.now() - 86_400_000).toISOString();
    chat.chat.messages.unshift(
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `old${i}`,
        role: "assistant" as const,
        text: `Old note ${i}`,
        at,
      })),
    );
    const page = await open(gateway);
    assert.equal(await page.getByText("Old note 3", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await page.getByText("Old note 3", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.getByRole("combobox", { name: "Model" }).count(), 0);
    await page.close();
  }),
);

test(
  "a stopped agent's chat offers Start, and is reached from the agent's page",
  withGateway(async (gateway) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/a/a-weekly`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.waitForURL(/#\/a\/a-weekly\/chat$/);
    await page.getByText("Weekly report is stopped.").waitFor();
    await page.getByRole("button", { name: "Start" }).click();
    await input(page).waitFor();
    await page.close();
  }),
);

test(
  "the chat shows no scrollbar and doesn't overflow, wide or phone",
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      const page = await open(gateway, "a-reviewer", width);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
        for (const el of document.querySelectorAll<HTMLElement>("main, main *"))
          if (
            /auto|scroll/.test(getComputedStyle(el).overflowY) &&
            el.offsetWidth - el.clientWidth > 0
          )
            out.push(el.className);
        return out;
      });
      assert.deepEqual(bad, [], String(width));
      await page.close();
    }
  }),
);
