// An agent's computer as a window in the layer: opened from Expand or from a chat, beside the
// chat, one at a time. Over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { computer } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
/** An agent given a computer with a browser and a terminal. */
const withComputer = (gateway: Gateway, agent: string) =>
  computer(
    gateway,
    [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
    ],
    agent,
  );
async function open(gateway: Gateway, hash: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    withComputer(gateway, "a-research");
    withComputer(gateway, "a-reviewer");
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Wait for something the stand-in comes to hold. */
async function until(held: () => boolean, what: string) {
  for (const end = Date.now() + 4000; !held() && Date.now() < end; )
    await new Promise((done) => setTimeout(done, 25));
  assert.ok(held(), what);
}
const layerWindow = (page: Page) => page.getByRole("group", { name: "Window" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 100) / 100);
};
/** Research's first chat, open in the panel. */
async function researchChat(page: Page) {
  await page.getByRole("main").getByRole("tab", { name: "Chats" }).click();
  await page
    .getByRole("main")
    .getByRole("list", { name: "Chats with Research" })
    .getByRole("button")
    .first()
    .click();
  await panel(page).getByRole("button", { name: "Research's page" }).waitFor();
  // Once what was said in it is read.
  await panel(page).getByRole("log").locator(":scope > *").first().waitFor();
}

test(
  "Expand opens the computer as a window in the layer, in the room the chat leaves, and its own Close closes it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame.getByRole("button", { name: "Expand" }).click();
    const win = layerWindow(page);
    await win.getByRole("heading", { name: "Research's computer" }).waitFor();
    // From the inset to one gap short of the collapsed chat.
    assert.deepEqual(await boxOf(win), [20, 20, 1440 - 20 - 20 - 64 - 12, 860]);
    // There it is as large as it gets, says whose it is, and has its own Close.
    assert.equal(await win.getByRole("button", { name: "Expand" }).count(), 0);
    await win.getByRole("button", { name: "Close Research's computer" }).waitFor();
    // The window picked there is the one in front on its page too.
    await win
      .getByRole("navigation", { name: "Dock" })
      .getByRole("button", { name: "Terminal" })
      .click();
    await win
      .getByRole("group", { name: "Terminal" })
      .getByRole("tablist")
      .waitFor({ state: "attached" });
    await frame.getByRole("group", { name: "Terminal" }).waitFor();
    // One frame of a computer is live at a time: under its window, the page's opens nothing.
    assert.equal(await frame.getByRole("tablist").count(), 0);
    await until(() => gateway.live.terminal.sockets.size === 1, "one terminal view, the window's");
    assert.equal(gateway.live.screens.size, 0, "the page's browser view is closed");
    // Opening the chat leaves it one gap short of the panel, and moves nothing of the chat.
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).waitFor();
    assert.deepEqual(await boxOf(win), [20, 20, 1440 - 20 - 20 - 420 - 12, 860]);
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    await win.getByRole("button", { name: "Close Research's computer" }).click();
    await win.waitFor({ state: "detached" });
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    // Closed, the page's frame is live again.
    await frame.getByRole("button", { name: "Expand" }).waitFor();
    await until(() => gateway.live.terminal.sockets.size === 1, "the page's terminal view is open");
    await page.close();
  }),
);

test(
  "a chat shows its agent's computer beside it and takes it away again; another agent's takes its place",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    await researchChat(page);
    const button = panel(page).getByRole("button", { name: "Research's computer" });
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    const said = await panel(page).innerText();
    await button.click();
    await layerWindow(page).getByRole("heading", { name: "Research's computer" }).waitFor();
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await panel(page).innerText(), said, "the chat stays as it is");
    await button.click();
    await layerWindow(page).waitFor({ state: "detached" });
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    // An agent with no computer has no such button.
    gateway.addChat("a-triage", { id: "c-route", title: "Route today's issues", said: [] });
    await page.goto(`${gateway.url}/#/a/a-triage`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats with Triage" })
      .getByRole("button")
      .first()
      .click();
    await panel(page).getByRole("button", { name: "Triage's page" }).waitFor();
    assert.equal(
      await panel(page)
        .getByRole("button", { name: /computer$/ })
        .count(),
      0,
    );
    // One window at a time: Reviewer's, opened from its chat, takes Research's place.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.goto(`${gateway.url}/#/a/a-research`);
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await layerWindow(page).getByRole("heading", { name: "Research's computer" }).waitFor();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("list")
      .getByRole("button", { name: /Reviewer/ })
      .first()
      .click();
    await panel(page).getByRole("button", { name: "Reviewer's computer" }).click();
    await layerWindow(page).getByRole("heading", { name: "Reviewer's computer" }).waitFor();
    assert.equal(await layerWindow(page).count(), 1);
    assert.equal(await layerWindow(page).getByRole("heading").count(), 1);
    await page.close();
  }),
);

test(
  "where the open chat leaves a window too little room they overlap, the one opened last on top; on a phone each takes the screen",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research", 1000);
    /** Which of the two is on top in the middle of the chat. */
    const onTop = () =>
      page.evaluate(() => {
        const at = document.elementFromPoint(1000 - 20 - 210, 450);
        return at?.closest('aside[aria-label="Chats"]')
          ? "chat"
          : at?.closest('[role="group"][aria-label="Window"]')
            ? "window"
            : "neither";
      });
    await researchChat(page);
    await panel(page).getByRole("button", { name: "Research's computer" }).click();
    const win = layerWindow(page);
    await win.getByRole("heading", { name: "Research's computer" }).waitFor();
    // The window runs to the inset, under or over the chat.
    assert.deepEqual(await boxOf(win), [20, 20, 960, 860]);
    assert.equal(await onTop(), "window");
    // It takes the keyboard when it opens, and its Close gives it back to what opened it.
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.equal(await focused(), "Window");
    // Its Close gives the chat back; collapsed and opened again over a window, the chat is on top.
    await win.getByRole("button", { name: "Close Research's computer" }).click();
    await win.waitFor({ state: "detached" });
    assert.equal(await focused(), "Research's computer");
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("main").getByRole("tab", { name: "Computer" }).click();
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await win.getByRole("navigation", { name: "Dock" }).waitFor();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).waitFor();
    assert.equal(await onTop(), "chat");
    await page.close();

    const phone = await open(gateway, "#/a/a-research", 390, 844);
    await phone.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await layerWindow(phone).getByRole("navigation", { name: "Dock" }).waitFor();
    assert.deepEqual(await boxOf(layerWindow(phone)), [0, 0, 390, 844]);
    await layerWindow(phone).getByRole("button", { name: "Close Research's computer" }).click();
    await layerWindow(phone).waitFor({ state: "detached" });
    await phone.close();
  }),
);
