// Who to message, from Chat's head, in a real browser over the stand-in gateway: "Chats" with a
// line under it and a compose icon at its end, which opens a "To" picker over the agents; a pick
// opens that agent's conversation, or its empty one, which its first message makes.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { noted } from "./design/samples.ts";

withBrowser();

async function open(gateway: Gateway, width = 1440, hash = "#/chat"): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await noted(gateway);
  return page;
}
const list = (page: Page) => page.getByRole("main").getByRole("region", { name: "Chats" });
const compose = (page: Page) => list(page).getByRole("button", { name: "Message", exact: true });
const picker = (page: Page) => page.getByRole("dialog", { name: "Message" });
const conversation = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name: `Conversation with ${name}` });
/** The names the picker offers now, top to bottom. */
const offered = (page: Page) =>
  picker(page)
    .getByRole("option")
    .evaluateAll((options) => options.map((one) => one.textContent?.trim()));

test(
  'Chat\'s head is "Chats" with a compose icon, "Message", at its end, and a line the column\'s width under it, wide and on a phone',
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      // On a phone the page opens on the list.
      const page = await open(gateway, width);
      await compose(page).waitFor();
      const seen = await list(page).evaluate((section) => {
        const head = section.querySelector("header") as Element;
        const icon = head.querySelector('button[aria-label="Message"]');
        const s = getComputedStyle(head);
        const h = head.getBoundingClientRect();
        return {
          words: head.querySelector("h1")?.textContent,
          line: `${s.borderBottomWidth} ${s.borderBottomStyle}`,
          // Across the column, inside the line at its side.
          across: h.width === (section as HTMLElement).clientWidth,
          end: icon ? Math.round(h.right - icon.getBoundingClientRect().right) : null,
          icon: !!icon?.querySelector("svg.lucide-square-pen"),
        };
      });
      assert.deepEqual(
        seen,
        { words: "Chats", line: "1px solid", across: true, end: 8, icon: true },
        `at ${width}`,
      );
      await page.close();
    }
  }),
);

test(
  'the compose icon opens the picker: "To", "Name", and every agent in Team\'s order, each with its face; typing keeps the names that hold it',
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await compose(page).click();
    await picker(page).waitFor();
    const input = picker(page).getByRole("combobox");
    assert.equal(await input.getAttribute("placeholder"), "Name");
    assert.equal(await input.evaluate((e) => e === document.activeElement), true, "the keyboard");
    assert.equal(
      await picker(page).evaluate((root) =>
        root.querySelector('[data-slot="command-input-wrapper"]')?.textContent?.trim(),
      ),
      "To",
    );
    assert.deepEqual(await offered(page), [
      "RResearch",
      "RReviewer",
      "TTriage",
      "WRWeekly report",
      "BBroken",
    ]);
    await input.fill("re");
    assert.deepEqual(await offered(page), ["RResearch", "RReviewer", "WRWeekly report"]);
    await input.fill("tri");
    assert.deepEqual(await offered(page), ["TTriage"]);
    await page.keyboard.press("Escape");
    await picker(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "picking an agent with a conversation opens it; picking one without opens its empty conversation, and its first message makes it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await conversation(page, "Research").waitFor();
    await compose(page).click();
    await picker(page).getByRole("option", { name: "Reviewer" }).click();
    await picker(page).waitFor({ state: "detached" });
    await conversation(page, "Reviewer").locator(".prose-chat").first().waitFor();
    assert.equal(new URL(page.url()).hash, "#/chat/a-reviewer");

    await compose(page).click();
    await picker(page).getByRole("combobox").fill("Tri");
    await page.keyboard.press("Enter");
    const triage = conversation(page, "Triage");
    const box = triage.getByRole("textbox", { name: "Message" });
    await box.waitFor();
    assert.equal(await triage.locator('[data-slot="message-scroller-item"]').count(), 0, "empty");
    assert.equal(
      await list(page).getByRole("button").filter({ hasText: "Triage" }).count(),
      0,
      "no row before its first message",
    );
    await box.fill("Route today's issues.");
    await box.press("Enter");
    await list(page).getByRole("button").filter({ hasText: "Triage" }).waitFor();
    await page.close();
  }),
);

test(
  'on a phone with "No chats", the compose icon is the way to a conversation',
  withGateway(async (gateway) => {
    gateway.noChats();
    const page = await open(gateway, 390);
    await conversation(page, "Research").getByRole("button", { name: "All chats" }).click();
    await list(page).getByText("No chats", { exact: true }).waitFor();
    await compose(page).click();
    await picker(page).getByRole("option", { name: "Reviewer" }).click();
    const reviewer = conversation(page, "Reviewer");
    await reviewer.getByRole("textbox", { name: "Message" }).waitFor();
    assert.equal(await list(page).count(), 0, "the conversation alone");
    await page.close();
  }),
);
