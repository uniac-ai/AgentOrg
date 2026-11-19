// Copy under the latest message waits while a message of the conversation is in hand, and shows
// when pointed at; once nothing is in hand, it shows. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { researchSays, SAID } from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat, opened as it now stands. */
async function conversation(gateway: Gateway): Promise<{ page: Page; thread: Locator }> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/chat/a-research`);
  const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  await thread.locator(".prose-chat").first().waitFor();
  await page.mouse.move(1, 1);
  return { page, thread };
}
/** The latest message's Copy. Its visibility changes over a short transition, so a change is waited for. */
const copyOf = (thread: Locator) =>
  thread
    .locator('[data-slot="message"]')
    .filter({ has: thread.page().locator(".prose-chat") })
    .last()
    .getByRole("button", { name: "Copy", includeHidden: true });
const seen = (copy: Locator) =>
  copy.evaluate((button) => getComputedStyle(button).visibility === "visible");

for (const end of ["answered", "closed"] as const)
  test(
    `while the message the receipt is for is in hand, Copy under the receipt waits and shows when pointed at; ${end}, it shows`,
    withGateway(async (gateway) => {
      researchSays(gateway, "receipt");
      gateway.progress("a-research", "v-u3", { state: "taken" });
      const { page, thread } = await conversation(gateway);
      await thread.locator('[data-slot="marker"][role="status"]').waitFor();
      const copy = copyOf(thread);
      assert.equal(await seen(copy), false, "not shown while it is in hand");
      await thread.getByText(SAID.receipt).hover();
      await copy.waitFor({ state: "visible" });
      await page.mouse.move(1, 1);
      await copy.waitFor({ state: "hidden" });
      gateway.progress("a-research", "v-u3", { state: end });
      await thread.locator('[data-slot="marker"][role="status"]').waitFor({ state: "detached" });
      await copy.waitFor({ state: "visible" });
      assert.equal(await seen(copy), true, `shown once ${end}`);
      await page.close();
    }),
  );

test(
  "with the agent at work in another conversation and nothing in hand here, Copy under the latest message shows",
  withGateway(async (gateway) => {
    researchSays(gateway, "oneLine");
    gateway.setChatStatus("a-research", { state: "working" });
    const { page, thread } = await conversation(gateway);
    assert.equal(await seen(copyOf(thread)), true);
    await page.close();
  }),
);
