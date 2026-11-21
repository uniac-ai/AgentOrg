// What the Settings window's tests share: a page opened at an address over the stand-in gateway,
// the window, its sections, the places of the bar under it, and when a window has opened.
import assert from "node:assert/strict";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway } from "./build-kit.ts";
import { SESSION, standIn } from "./stand-in.ts";

export const WIDE = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

export async function open(
  gateway: Gateway,
  hash = "#/",
  viewport = WIDE,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const page = await browser().newPage({ viewport, reducedMotion });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
export const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
export const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
export const sections = (page: Page) =>
  settings(page).getByRole("navigation", { name: "Settings" });
export const choose = (page: Page, name: string) =>
  sections(page).getByRole("button", { name, exact: true }).click();
/** The rows marked as the section chosen. */
export const marked = (page: Page) =>
  sections(page).locator('[aria-current="true"]').allInnerTexts();
/**
 * A place of the bar, by its markup: under the open window the bar is out of the reach of what a
 * screen reader is told, but still there.
 */
export const place = (page: Page, name: string) =>
  page.locator(`nav[aria-label="Main"] button[aria-label^="${name}"]`);
/** A window has finished opening: nothing in it is measured before. */
export const opened = (window: Locator) =>
  window.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
export const openSettings = async (page: Page) => {
  await place(page, "Settings").click();
  await opened(settings(page));
};
/** A part's box as [x, y, width, height]. */
export const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height] as [number, number, number, number];
};
