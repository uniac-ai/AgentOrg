// A tooltip and the window its trigger opens, in a real browser over the stand-in gateway: closing
// the window gives the keyboard back to the trigger without opening its tooltip, however it closes,
// and a tooltip still opens for the keyboard the person moves onto its trigger.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

async function open(gateway: Gateway): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/chat`);
  return page;
}
const settingsButton = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" });
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
/** The tooltips open now, once the page has drawn twice since focus came back. */
const tooltips = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            done(document.querySelectorAll('[data-slot="tooltip-content"]').length),
          ),
        ),
      ),
  );
/** Opens Settings from the left bar with the pointer, as a person does. */
async function openSettings(page: Page) {
  await settingsButton(page).click();
  await settings(page).waitFor();
}
/** The keyboard is back on the left bar's Settings button. */
const focusBack = (page: Page) =>
  page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Settings");

test(
  "Settings opened from the left bar and closed with Escape gives the keyboard back to its button, with no tooltip open",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    await page.keyboard.press("Escape");
    await settings(page).waitFor({ state: "detached" });
    await focusBack(page);
    assert.equal(await tooltips(page), 0);
    await page.close();
  }),
);

test(
  "Settings closed with its close button gives the keyboard back to its button, with no tooltip open",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    await settings(page).getByRole("button", { name: "Close" }).filter({ visible: true }).click();
    await settings(page).waitFor({ state: "detached" });
    await focusBack(page);
    assert.equal(await tooltips(page), 0);
    await page.close();
  }),
);

test(
  "moved onto a left bar button with Tab, the keyboard opens its tooltip",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await settingsButton(page).waitFor();
    // From the bar's first place, Tab moves the keyboard to the next.
    await page.getByRole("navigation", { name: "Main" }).getByRole("button").first().focus();
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await page
      .locator('[data-slot="tooltip-content"]')
      .filter({ hasText: label ?? "" })
      .waitFor();
    await page.close();
  }),
);
