// The fixed pages in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(
  gateway: Gateway,
  hash = "#/",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const row = (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name });
const box = (locator: Locator) => locator.boundingBox();

const withGateway =
  (run: (gateway: Gateway) => Promise<void>, options?: Parameters<typeof standIn>[0]) =>
  async () => {
    const gateway = await standIn(options);
    try {
      await run(gateway);
    } finally {
      await gateway.close();
    }
  };

test(
  "Agents says what each agent is doing, from its status, its chat and its connections",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await row(page, "Research").getByText("Using github__search_issues").waitFor();
    assert.match(
      await row(page, "Research").innerText(),
      /Using github__search_issues[\s\S]*6 min/,
    );
    assert.match(await row(page, "Reviewer").innerText(), /Reviewed #482 with 3 comments\s+12 min/);
    await row(page, "Triage").getByText("linear is down, so its tools are left out").waitFor();
    await row(page, "Weekly report").getByRole("img", { name: "Stopped" }).waitFor();
    await row(page, "Broken").getByText("Its program exited.").waitFor();
    await page.getByRole("img", { name: "2 with a problem" }).first().waitFor();
    await page.close();
  }),
);

test(
  "a row follows its agent's events, and keeps its box and place",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const research = row(page, "Research");
    await research.getByText("Using github__search_issues").waitFor();
    const before = await box(research);
    gateway.setChatStatus("a-research", { state: "thinking" });
    await research.getByText("Thinking").waitFor();
    assert.deepEqual(await box(research), before);
    gateway.setChatStatus("a-research", {
      state: "error",
      detail: { code: "usage_limit", message: "You've reached your plan's limit." },
    });
    await research.getByText("You've reached your plan's limit.").waitFor();
    await research.getByRole("img", { name: "Has a problem" }).waitFor();
    gateway.setChatStatus("a-research", { state: "idle" });
    gateway.addMessage("a-research", {
      id: "m9",
      role: "assistant",
      text: "Three causes explain it.",
      at: new Date().toISOString(),
    });
    await research.getByText("Three causes explain it.").waitFor();
    assert.deepEqual(await box(research), before);
    await page.close();
  }),
);

test(
  "no page shows a scrollbar or overflows sideways, wide or phone",
  withGateway(async (gateway) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ])
      for (const hash of ["#/"]) {
        const page = await open(gateway, hash, viewport);
        await page.getByRole("main").getByText(/./).first().waitFor();
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
        assert.deepEqual(bad, [], `${viewport.width} ${hash}`);
        await page.close();
      }
  }),
);

test(
  "with no `agents` slot the older pages stay",
  withGateway(
    async (gateway) => {
      const page = await open(gateway);
      await page.locator("nav.sidebar").waitFor();
      assert.equal(await page.getByRole("button", { name: "Create" }).count(), 0);
      await page.close();
    },
    { older: true },
  ),
);

test(
  "with no management bound the older pages stay",
  withGateway(
    async (gateway) => {
      const page = await open(gateway);
      await page.locator("nav.sidebar").waitFor();
      assert.equal(await page.getByRole("button", { name: "Create" }).count(), 0);
      await page.close();
    },
    { unbound: true },
  ),
);
