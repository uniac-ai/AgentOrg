// What the tests of the list of your conversations share: a page on it, the list on the Chat page and
// in the floating chat, its rows and tiles by name, the pins in the store, and a conversation's menu.
import assert from "node:assert/strict";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION } from "./build-kit.ts";

/** Where the pins are kept in the app's store. */
export const PINS = "ui/pinned-conversations";

export async function open(
  gateway: Gateway,
  hash = "#/chat",
  { width = 1440, locale = "en-US", touch = false, now = undefined as string | undefined } = {},
): Promise<Page> {
  const page = await browser().newPage({
    viewport: { width, height: 900 },
    locale,
    timezoneId: "UTC",
    hasTouch: touch,
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  if (now) await page.clock.setFixedTime(new Date(now));
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** The Chat page's list of your conversations. */
export const chatsOf = (page: Page) => page.getByRole("main").getByRole("list", { name: "Chats" });
/** The floating chat's. */
export const floating = (page: Page) =>
  page.getByRole("complementary", { name: "Chats" }).getByRole("list", { name: "Chats" });
export const rows = (list: Locator) => list.locator(":scope > li > button");
export const tiles = (list: Locator) =>
  list.getByRole("list", { name: "Pinned" }).getByRole("button");
/** One conversation of a list, row or tile, by its agent's name. */
export const one = (list: Locator, name: string) =>
  list.getByRole("button").filter({ has: list.page().getByText(name, { exact: true }) });
/** The agents the rows name, top to bottom: each row's face comes first, then its name. */
export const rowNames = async (list: Locator) =>
  (await rows(list).allInnerTexts()).map((text) => text.split("\n").filter(Boolean)[1]);
/** The agents the tiles name, in their order: each tile's face comes first, then its name. */
export const tileNames = async (list: Locator) =>
  (await tiles(list).allInnerTexts()).map((text) => text.split("\n").filter(Boolean).at(-1));
export const said = (id: string, text: string, at = new Date().toISOString()) => ({
  id,
  role: "assistant" as const,
  text,
  at,
});
/**
 * Waits for what the page or the store will come to, which arrives a call at a time; after 8 s it
 * fails with what it last read.
 */
export async function until<T>(read: () => Promise<T> | T, expected: T) {
  for (const stop = Date.now() + 8000; ; ) {
    const now = await read();
    try {
      assert.deepEqual(now, expected);
      return;
    } catch (error) {
      if (Date.now() > stop) throw error;
      await new Promise((done) => setTimeout(done, 40));
    }
  }
}
/**
 * Opens a conversation's menu by a right-click, which must list `first` and then Delete chat, and
 * presses one of the two: `first`, unless the other is asked for.
 */
export async function choose(
  page: Page,
  of: Locator,
  first: "Pin" | "Unpin",
  item: "Pin" | "Unpin" | "Delete chat" = first,
) {
  await of.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), [first, "Delete chat"]);
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await menu.waitFor({ state: "detached" });
}
