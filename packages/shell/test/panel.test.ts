// The chat panel in a real browser: sessions per agent, and what's new across pages and restarts.
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

async function open(gateway: Gateway, hash = "#/", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await toggle(page).waitFor();
  return page;
}
const toggle = (page: Page) => page.getByRole("button", { name: /^Chats/ });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });
const main = (page: Page) => page.getByRole("main");
const box = (locator: Locator) => locator.boundingBox();
const startChat = async (page: Page, name: string) => {
  await main(page)
    .getByRole("button", { name: `Chat with ${name}` })
    .click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
};
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};

test(
  "the chat button sits at the foot on the right; its panel is beside the page, over it or on all of it, and closes by its own Close",
  withGateway(async (gateway) => {
    let page = await open(gateway);
    const before = await box(toggle(page));
    assert.ok(before);
    assert.ok(1440 - (before.x + before.width) < 40 && 900 - (before.y + before.height) < 40);
    const width = (await box(main(page)))?.width as number;
    await toggle(page).click();
    await panel(page).waitFor();
    assert.equal(await toggle(page).count(), 0, "open, the panel stands for the button");
    assert.ok(((await box(main(page)))?.width as number) < width, "beside the page");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await page.getByRole("tab", { name: "Skills" }).waitFor();
    await panel(page).waitFor();
    await panel(page).getByRole("button", { name: "Close" }).click();
    await panel(page).waitFor({ state: "detached" });
    assert.deepEqual(await box(toggle(page)), before, "back where it was");
    await page.close();

    page = await open(gateway, "#/", 900);
    const tablet = (await box(main(page)))?.width;
    await toggle(page).click();
    await panel(page).waitFor();
    assert.equal((await box(main(page)))?.width, tablet, "over the page");
    await page.close();

    page = await open(gateway, "#/", 390);
    await toggle(page).click();
    assert.equal(Math.round((await box(panel(page)))?.width as number), 390);
    await page.close();
  }),
);

test(
  "Chat adds the agent's session and opens it; the list shows it, and it stays across a reload",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await startChat(page, "Reviewer");
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("button", { name: /Reviewer/ })
      .waitFor();
    assert.deepEqual(gateway.notes.get("ui/chats"), {
      sessions: [{ agent: "a-reviewer", read: "m3" }],
    });
    await page.reload();
    await toggle(page).click();
    await panel(page)
      .getByRole("button", { name: /Reviewer/ })
      .waitFor();
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 0, "already seen");
    await page.close();
  }),
);

test(
  "a reply landing while you're elsewhere shows as new, across a restart, until it's opened",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await startChat(page, "Reviewer");
    await panel(page).getByRole("button", { name: "Close" }).click();
    await panel(page).waitFor({ state: "detached" });
    gateway.addMessage("a-reviewer", reply("r9", "All clear on #482."));
    await page.getByRole("button", { name: "Chats, 1 new" }).waitFor();

    await page.reload();
    await page.getByRole("button", { name: "Chats, 1 new" }).waitFor();
    await toggle(page).click();
    const session = panel(page).getByRole("button", { name: /Reviewer/ });
    await session.getByRole("img", { name: "New" }).waitFor();
    await session.getByText("All clear on #482.").waitFor();
    await session.click();
    await panel(page).getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Chats", exact: true }).waitFor();
    assert.deepEqual(gateway.notes.get("ui/chats"), {
      sessions: [{ agent: "a-reviewer", read: "r9" }],
    });
    await page.close();
  }),
);

test(
  "what arrives in the open session is read as it comes; sessions show what's happening",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await startChat(page, "Reviewer");
    gateway.addMessage("a-reviewer", reply("r9", "Looking now."));
    await panel(page).getByText("Looking now.").waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("button", { name: /new$/ }).count(), 0);
    await panel(page).getByRole("button", { name: "All chats" }).click();
    gateway.setChatStatus("a-reviewer", { state: "thinking" });
    await panel(page)
      .getByRole("button", { name: /Reviewer/ })
      .getByText("Working")
      .waitFor();
    await page.close();
  }),
);

test(
  "half-typed text waits in its session, and removing a session keeps the agent",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await startChat(page, "Reviewer");
    const input = panel(page).getByRole("textbox", { name: "Message" });
    await input.fill("half a thought");
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("button", { name: /Reviewer/ })
      .click();
    assert.equal(
      await panel(page).getByRole("textbox", { name: "Message" }).inputValue(),
      "half a thought",
    );
    await panel(page).getByRole("button", { name: "Reviewer chat options" }).click();
    await page.getByRole("menuitem", { name: "Remove from Chats" }).click();
    await panel(page).getByText("Start one with Chat on an agent.").waitFor();
    assert.ok(gateway.agents.has("a-reviewer"));
    assert.deepEqual(gateway.notes.get("ui/chats"), { sessions: [] });
    await page.close();
  }),
);

test(
  "the panel stays open across pages, and a deleted agent's session goes",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await startChat(page, "Reviewer");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
    gateway.agents.delete("a-reviewer");
    gateway.changed();
    await panel(page).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Message"]'));
    await page.waitForTimeout(100);
    assert.deepEqual(gateway.notes.get("ui/chats"), { sessions: [] });
    await page.close();
  }),
);
