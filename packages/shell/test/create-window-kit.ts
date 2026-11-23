// What the Create window's tests share: its parts by their names, and when it has finished opening.
import assert from "node:assert/strict";
import type { Locator, Page } from "@playwright/test";
import { newTemplate, panel } from "./build-kit.ts";

export const named = (page: Page, name: string | RegExp) =>
  panel(page).getByRole("button", { name });
export const chosen = (page: Page, name: string | RegExp) =>
  named(page, name).getAttribute("aria-current");
export const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  return box;
};

/** The Create window has finished opening: its own animations, as it grows to its size, are over. */
export const opened = (page: Page) =>
  panel(page).evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).then(() => undefined),
  );

/** The Create window has come to this width, as it does when what it can do opens or closes. */
export const wide = (page: Page, width: number) =>
  page.waitForFunction(
    (to) =>
      document.querySelector('[data-slot="dialog-content"]')?.getBoundingClientRect().width === to,
    width,
  );

/** New template's identity card, at the window's left. */
export const identity = (page: Page) =>
  panel(page).getByRole("complementary", { name: /as it will be$/ });

/** Opens New template from Settings, at rest once its stack is drawn and it has opened. */
export async function openTemplate(page: Page) {
  await newTemplate(page);
  await opened(page);
  return panel(page);
}
