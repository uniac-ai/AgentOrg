// What the chat's tests share: a signed-in page on an agent's page or with Reviewer's chat open,
// the box and what the person said, a reply as the stand-in sends it, and waits on what it sees.
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { browser, type Gateway } from "./build-kit.ts";
import { SESSION, standIn } from "./stand-in.ts";

export const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });

/** A signed-in page on an agent's page, with nothing open in the chat. */
export async function visit(gateway: Gateway, agent: string, width = 1440): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/${agent}`);
  return page;
}
/** A signed-in page with Reviewer's chat open in the panel. */
export async function open(gateway: Gateway, width = 1440): Promise<Page> {
  const page = await visit(gateway, "a-reviewer", width);
  await page.getByRole("button", { name: /^Chats/ }).click();
  await panel(page)
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: "Reviewer" })
    .click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
  await panel(page).locator(".prose-chat, .whitespace-pre-wrap").first().waitFor();
  return page;
}
export const input = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
/** What the person said, in the thread: a chat's title may say the same words. */
export const mine = (page: Page, text: string | RegExp) =>
  panel(page).locator(".whitespace-pre-wrap", { hasText: text });

/**
 * Nothing is shown under what the person said last while its work runs: no row, no word that it is
 * being worked on, and no problem. The conversation's end shows the agent typing, and nothing else.
 */
export async function nothingUnder(page: Page, text: string) {
  const items = panel(page).locator('[data-slot="message-scroller-item"]');
  await page
    .getByRole("main")
    .getByRole("status", { name: "State" })
    .getByText("Working")
    .waitFor();
  await panel(page).getByRole("status", { name: "Reviewer is typing" }).waitFor();
  await page.waitForTimeout(300);
  const count = await items.count();
  assert.equal((await items.nth(count - 2).innerText()).trim(), text);
  assert.equal(
    await panel(page).locator('[data-slot="message"][data-align="end"] [role="status"]').count(),
    0,
  );
  assert.equal(await panel(page).getByRole("status").count(), 1, "the sign alone");
  assert.equal(await panel(page).getByRole("alert").count(), 0);
}

export const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Waits for what the stand-in will see, which nothing on the page shows. */
export async function until(seen: () => boolean) {
  for (let i = 0; i < 100 && !seen(); i++) await new Promise((done) => setTimeout(done, 20));
  assert.ok(seen(), "it never happened");
}
export const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});
