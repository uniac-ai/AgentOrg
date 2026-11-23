// What is selected keeps its colour under the pointer, in a real browser over the stand-in gateway:
// the open chat's row, the chosen agent's row on Team, and the left bar's current place, in both
// themes. What isn't selected takes the hover colour.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

const THEMES = ["dark", "light"] as const;
async function open(gateway: Gateway, hash: string, theme: (typeof THEMES)[number]) {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  if (theme === "light")
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
  return page;
}
/** A token's colour as a background, in the page's theme. */
const token = (page: Page, name: string) =>
  page.evaluate((one) => {
    const probe = document.createElement("i");
    probe.style.background = `var(${one})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);
const colour = (part: Locator) => part.evaluate((e) => getComputedStyle(e).backgroundColor);
/** What a part shows, and what it shows under the pointer; the pointer is moved away first. */
async function pointed(page: Page, part: Locator) {
  await page.mouse.move(1439, 899);
  const at = await colour(part);
  await part.hover();
  return [at, await colour(part)];
}

test(
  "the open chat's row keeps the selected colour under the pointer, and another row takes the hover colour, in both themes",
  withGateway(async (gateway) => {
    for (const theme of THEMES) {
      const page = await open(gateway, "#/chat", theme);
      const rows = page
        .getByRole("main")
        .getByRole("region", { name: "Chats" })
        .getByRole("list", { name: "Chats" })
        // The rows themselves: each has buttons of its own beside it.
        .locator(":scope > li > button");
      const selected = rows.and(page.locator('[aria-current="true"]'));
      await selected.waitFor();
      const [chosen, over] = [await token(page, "--selected"), await token(page, "--hover")];
      assert.deepEqual(await pointed(page, selected), [chosen, chosen], theme);
      const other = rows.and(page.locator(":not([aria-current])")).first();
      assert.deepEqual(await pointed(page, other), ["rgba(0, 0, 0, 0)", over], theme);
      await page.close();
    }
  }),
);

test(
  "the chosen agent's row on Team keeps the selected colour under the pointer, and another row takes the hover colour, in both themes",
  withGateway(async (gateway) => {
    for (const theme of THEMES) {
      const page = await open(gateway, "#/team", theme);
      const rows = page.getByRole("main").getByRole("list", { name: "Agents" }).getByRole("button");
      const selected = rows.and(page.locator('[aria-current="true"]'));
      await selected.waitFor();
      const [chosen, over] = [await token(page, "--selected"), await token(page, "--hover")];
      assert.deepEqual(await pointed(page, selected), [chosen, chosen], theme);
      const other = rows.and(page.locator(":not([aria-current])")).first();
      assert.deepEqual(await pointed(page, other), ["rgba(0, 0, 0, 0)", over], theme);
      await page.close();
    }
  }),
);

test(
  "the left bar's current place keeps the selected colour under the pointer, and another place takes the hover colour, in both themes",
  withGateway(async (gateway) => {
    for (const theme of THEMES) {
      const page = await open(gateway, "#/chat", theme);
      const bar = page.getByRole("navigation", { name: "Main" });
      const current = bar.locator('[aria-current="page"]');
      await current.waitFor();
      const [chosen, over] = [await token(page, "--selected"), await token(page, "--hover")];
      assert.deepEqual(await pointed(page, current), [chosen, chosen], theme);
      const other = bar.getByRole("button", { name: /^Team/ });
      assert.deepEqual(await pointed(page, other), ["rgba(0, 0, 0, 0)", over], theme);
      await page.close();
    }
  }),
);
