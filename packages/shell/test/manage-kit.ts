// What the tests of Skills, MCP connections and Settings share: a page opened at an address over the
// stand-in gateway, and Settings' window, its sections and the forms they open.
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION } from "./build-kit.ts";

export async function open(
  gateway: Gateway,
  hash: string,
  width = 1440,
  height = 900,
): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  // Settings' old addresses open its window: nothing in it is measured until it has opened. One
  // that opens a section's form opens it over the window, which is then hidden behind it.
  if (/^#\/(settings|skills|mcps)/.test(hash) && !hash.endsWith("/add"))
    await opened(settings(page));
  return page;
}
/** The Settings window. */
export const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
export const row = (page: Page, name: string) =>
  settings(page).getByRole("listitem").filter({ hasText: name });
/** One of Settings' sections, chosen by its row. */
export const choose = (page: Page, name: string) =>
  settings(page)
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name })
    .click();
/** The forms a section opens over the window. */
export const addSkill = (page: Page) => page.getByRole("dialog", { name: "Add skill" });
export const connectForm = (page: Page) => page.getByRole("dialog", { name: "Connect an MCP" });
/** A dialog has finished opening: its own animations, as it grows to its size, are over. */
export const opened = (dialog: Locator) =>
  dialog.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).then(() => undefined),
  );
export const labels = (page: Page) =>
  connectForm(page).locator('[data-slot="field-label"]').allInnerTexts();
