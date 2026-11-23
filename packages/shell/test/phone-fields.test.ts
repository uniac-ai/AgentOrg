// Every field a person types into, in a real browser over the stand-in gateway: on a phone its
// words are 16 px on screen, so iOS doesn't zoom the page when it takes the keyboard; wider, each
// keeps its own size.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

async function open(gateway: Gateway, width: number, hash: string): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const sizeOf = (field: Locator) => field.evaluate((e) => getComputedStyle(e).fontSize);
const size = (page: Page, selector: string) => sizeOf(page.locator(selector).first());

/** The three fields' words: the message box, compose's "To" and the search's. */
async function fields(gateway: Gateway, width: number) {
  let page = await open(gateway, width, "#/chat/a-reviewer");
  await page.locator('main textarea[aria-label="Message"]').waitFor();
  const message = await size(page, 'main textarea[aria-label="Message"]');
  await page.close();
  page = await open(gateway, width, "#/chat");
  await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
  await page.getByRole("dialog", { name: "Message" }).getByRole("combobox").waitFor();
  const to = await sizeOf(page.getByRole("dialog", { name: "Message" }).locator("input"));
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Search" })
    .click();
  await page.getByRole("dialog", { name: "Search" }).getByRole("combobox").waitFor();
  const search = await sizeOf(page.getByRole("dialog", { name: "Search" }).locator("input"));
  await page.close();
  return { message, to, search };
}

test(
  "on a phone, the message box, compose's field and the search's field have 16 px words",
  withGateway(async (gateway) => {
    assert.deepEqual(await fields(gateway, 390), {
      message: "16px",
      to: "16px",
      search: "16px",
    });
  }),
);

test(
  "wider, each keeps its own size",
  withGateway(async (gateway) => {
    assert.deepEqual(await fields(gateway, 1440), {
      message: "14px",
      to: "15px",
      search: "15px",
    });
  }),
);
