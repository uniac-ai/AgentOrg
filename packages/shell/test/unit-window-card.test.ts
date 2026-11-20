// The unit window's card as the design draws it, in a real browser over the stand-in gateway: a
// fold on its head, drawn whole on a phone, and Change… opening with no field focused.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { designAgents, type UnitWindow, windowSays, windowState } from "./design/samples.ts";

withBrowser();

/** Research's computer in its unit window, at one of the design's states, opened as a person does. */
async function change(
  gateway: Gateway,
  state: UnitWindow,
  width = 1440,
  height = 900,
): Promise<{ page: Page; window: Locator }> {
  designAgents(gateway);
  windowSays(gateway, state);
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  await page
    .getByRole("button", { name: "Dismiss" })
    .click({ timeout: 3000 })
    .catch(() => {});
  await windowState(page, state, false);
  return { page, window: page.getByRole("dialog", { name: /'s computer$/ }) };
}

test(
  "the card folds to its head and opens again, its button named and marked for each",
  withGateway(async (gateway) => {
    const { page, window } = await change(gateway, "change-ready");
    const fold = window.getByRole("button", { name: "Fold Computer" });
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    const field = window.getByRole("textbox", { name: "Where its work happens" });
    await field.waitFor();
    await fold.click();
    const open = window.getByRole("button", { name: "Open Computer" });
    assert.equal(await open.getAttribute("aria-expanded"), "false");
    assert.equal(await field.count(), 0, "its body gone");
    assert.equal(await window.getByText("Computer", { exact: true }).count(), 1, "its head stays");
    await open.click();
    await field.waitFor();
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await page.close();
  }),
);

test(
  "on a phone, a card that can't be had is drawn whole: its last row is in view, and the card doesn't scroll",
  withGateway(async (gateway) => {
    const { page, window } = await change(gateway, "change-install", 390, 844);
    const seen = await window.evaluate((dialog) => {
      const card = dialog.querySelector(".bg-card") as HTMLElement;
      const rows = [...card.querySelectorAll("p, label, button, input, [role=combobox]")];
      const last = (rows.at(-1) as Element).getBoundingClientRect();
      return {
        cardScrolls: card.scrollHeight > card.clientHeight + 1,
        lastBottom: Math.round(last.bottom),
        screen: innerHeight,
        windowScrolls: dialog.scrollHeight > dialog.clientHeight + 1,
      };
    });
    assert.equal(seen.cardScrolls, false, "the card has no scroll of its own");
    assert.ok(
      seen.lastBottom <= seen.screen,
      `its last row in view: ${seen.lastBottom} of ${seen.screen}`,
    );
    assert.equal(seen.windowScrolls, false, "it fits, so nothing scrolls");
    await page.close();
  }),
);

test(
  "Change… opens with the keyboard inside the window, on no field, and nothing selected",
  withGateway(async (gateway) => {
    const { page } = await change(gateway, "change-ready");
    const seen = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return {
        inWindow: !!active.closest('[role="dialog"]'),
        field: active.matches("input, textarea, select, [role=combobox], [contenteditable=true]"),
        selected: String(getSelection()),
      };
    });
    assert.deepEqual(seen, { inWindow: true, field: false, selected: "" });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: /'s computer$/ }).waitFor({ state: "detached" });
    await page.close();
  }),
);
