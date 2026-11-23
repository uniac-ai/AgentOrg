// The search, in a real browser over the stand-in gateway: a place at the top of the bar, above
// Chat, and its key anywhere, ⌘K on a Mac and Ctrl K elsewhere, and none while the service is out
// of reach; a terminal keeps Ctrl K itself; your conversations by their agent's name or last words,
// then agents by name; "No results" when nothing holds what is typed; a pick opens it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { computerWith, noted } from "./design/samples.ts";

withBrowser();

async function open(
  gateway: Gateway,
  width = 1440,
  hash = "#/team",
  on: "mac" | "linux" = "linux",
): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  // The platform the page is told it is on, as a Mac or a Linux PC tells it.
  await page.addInitScript((mac) => {
    Object.defineProperty(navigator, "platform", {
      get: () => (mac ? "MacIntel" : "Linux x86_64"),
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({ platform: mac ? "macOS" : "Linux" }),
    });
  }, on === "mac");
  await page.goto(`${gateway.url}/${hash}`);
  await noted(gateway);
  await page.getByRole("main").waitFor();
  return page;
}
const bar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const place = (page: Page) => bar(page).getByRole("button", { name: "Search" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Search" });
/** What the search lists now: each group's heading, then each row's words, in order. */
const listed = (page: Page) =>
  dialog(page).evaluate((root) =>
    [...root.querySelectorAll("[cmdk-group-heading], [cmdk-item], [cmdk-empty]")].map((one) =>
      one.matches("[cmdk-item]")
        ? (() => {
            // Its words, after its face: a conversation's agent, or an agent's name.
            const words = one.querySelector(":scope > span:last-child");
            return (words?.querySelector("span") ?? words)?.textContent ?? "";
          })()
        : `# ${one.textContent}`,
    ),
  );

test(
  "Search is the first of the frame's places, at the end of the strip along the top, wide; on a phone it is first along the foot, with its label under it",
  withGateway(async (gateway) => {
    let page = await open(gateway);
    assert.deepEqual(
      await bar(page)
        .getByRole("button")
        .evaluateAll((places) => places.map((one) => one.getAttribute("aria-label"))),
      ["Search", "Chat", "Team", "Settings"],
    );
    const [search, chat] = await Promise.all(
      ["Search", "Chat"].map((name) =>
        bar(page)
          .getByRole("button", { name, exact: true })
          .evaluate((e) => e.getBoundingClientRect().toJSON()),
      ),
    );
    assert.ok(search && chat && search.bottom <= 52 && search.bottom < chat.top, "above Chat");
    assert.equal(search.right, 300 - 10, "at the strip's end");
    assert.equal(await place(page).getAttribute("aria-haspopup"), "dialog");
    await page.close();
    page = await open(gateway, 390);
    assert.equal(await bar(page).getByRole("button").first().innerText(), "Search");
    await page.close();
  }),
);

test(
  "pressed, it opens the search: with nothing typed, your conversations, newest first; nothing is drawn for ⌘K",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await place(page).click();
    await dialog(page).waitFor();
    const field = dialog(page).getByRole("combobox");
    assert.equal(await field.getAttribute("placeholder"), "Search");
    assert.equal(await field.evaluate((e) => e === document.activeElement), true, "the keyboard");
    assert.deepEqual(await listed(page), ["# Chats", "Research", "Reviewer"]);
    assert.equal(await page.getByText(/⌘|Ctrl/).count(), 0, "no hint for the keys");
    await page.close();
  }),
);

/** Waits the page's own while, then says whether the search is open. */
const opened = async (page: Page) => {
  await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
  return (await dialog(page).count()) > 0;
};
/** Research's page with a terminal of your own in front, the keyboard in it. */
async function inTerminal(gateway: Gateway, on: "mac" | "linux") {
  computerWith(gateway, "terminal");
  const page = await open(gateway, 1440, "#/a/a-research", on);
  const pane = page.getByRole("group", { name: "Terminal" });
  await pane.getByRole("button", { name: "New terminal" }).click();
  await pane.locator(".xterm").click();
  return page;
}

test(
  "on a Mac, ⌘K opens it from anywhere, even with the keyboard in a box; Ctrl K is left to what has the keyboard",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, "#/chat", "mac");
    // Found by its element: while the search is open, the page behind it is hidden from roles.
    const box = page.locator('main textarea[aria-label="Message"]').last();
    await box.click();
    await page.keyboard.press("Control+k");
    assert.equal(await opened(page), false, "Ctrl K opens nothing");
    await page.keyboard.press("Meta+k");
    await dialog(page).waitFor();
    assert.equal(await box.inputValue(), "", "nothing typed in the box");
    await page.close();
  }),
);

test(
  "on a Mac, Ctrl K in a terminal is the terminal's, and ⌘K there still opens the search",
  withGateway(async (gateway) => {
    const page = await inTerminal(gateway, "mac");
    await page.keyboard.press("Control+k");
    assert.equal(await opened(page), false);
    await page.keyboard.press("Meta+k");
    await dialog(page).waitFor();
    await page.close();
  }),
);

test(
  "elsewhere, Ctrl K opens it from a box, but not from a terminal, whose own key it is; ⌘K opens nothing",
  withGateway(async (gateway) => {
    let page = await open(gateway, 1440, "#/chat", "linux");
    await page.locator('main textarea[aria-label="Message"]').last().click();
    await page.keyboard.press("Meta+k");
    assert.equal(await opened(page), false, "⌘K opens nothing");
    await page.keyboard.press("Control+k");
    await dialog(page).waitFor();
    await page.close();
    // xterm takes Ctrl K at its own text area, and the window never hears it. Should it ever let
    // the key through, this fails, and the listener needs to leave a terminal's key alone.
    page = await inTerminal(gateway, "linux");
    await page.keyboard.press("Control+k");
    assert.equal(await opened(page), false, "the terminal's own");
    await page.close();
  }),
);

test(
  "out of reach of the service, the key opens nothing over the notice",
  withGateway(async (gateway) => {
    for (const on of ["mac", "linux"] as const) {
      const page = await open(gateway, 1440, "#/chat", on);
      gateway.goAway();
      await page.getByRole("status").filter({ hasText: "You're offline" }).waitFor();
      await page.keyboard.press(on === "mac" ? "Meta+k" : "Control+k");
      assert.equal(await opened(page), false, on);
      gateway.goAway(false);
      await page.close();
    }
  }),
);

test(
  'a word finds conversations by their agent\'s name or their last words, under "Chats", then agents by their name, under "Team"; nothing found says "No results"',
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await place(page).click();
    const field = dialog(page).getByRole("combobox");
    await field.fill("re");
    assert.deepEqual(await listed(page), [
      "# Chats",
      "Research",
      "Reviewer",
      "# Team",
      "Research",
      "Reviewer",
      "Weekly report",
    ]);
    // Words of a conversation's last message ("You: Why are checkouts failing?"), which no
    // agent's name holds.
    await field.fill("checkouts");
    assert.deepEqual(await listed(page), ["# Chats", "Research"]);
    await field.fill("zzz");
    assert.deepEqual(await listed(page), ["# No results"]);
    await page.close();
  }),
);

test(
  "a conversation picked opens on Chat, and an agent picked opens on Team; closed, it starts empty again",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await place(page).click();
    await dialog(page).getByRole("combobox").fill("Rev");
    await dialog(page).getByRole("option").first().click();
    await dialog(page).waitFor({ state: "detached" });
    await page
      .getByRole("main")
      .getByRole("region", { name: "Conversation with Reviewer" })
      .waitFor();
    assert.equal(new URL(page.url()).hash, "#/chat/a-reviewer");
    await place(page).click();
    assert.equal(await dialog(page).getByRole("combobox").inputValue(), "", "empty again");
    await dialog(page).getByRole("combobox").fill("Tri");
    await dialog(page).getByRole("group", { name: "Team" }).getByRole("option").click();
    await page.getByRole("main").getByRole("heading", { name: "Triage" }).waitFor();
    assert.equal(new URL(page.url()).hash, "#/team/a-triage");
    await page.close();
  }),
);
