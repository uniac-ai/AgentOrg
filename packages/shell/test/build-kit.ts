// What the build tests share: a browser per file, a page on the stand-in gateway, and the
// window's parts by name.
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let launched: Browser;
/** A browser for the file that calls this, closed after its tests. */
export function withBrowser() {
  test.before(async () => {
    launched = await chromium.launch();
  });
  test.after(() => launched.close());
}
export const browser = () => launched;

export type Gateway = Awaited<ReturnType<typeof standIn>>;
export { SESSION };
export async function open(gateway: Gateway): Promise<Page> {
  const page = await launched.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/`);
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
export const plus = (page: Page) => page.getByRole("button", { name: /^Create/ }).first();
export const panel = (page: Page) => page.getByRole("dialog", { name: /^(Create|New template)$/ });
export const card = (page: Page, name: string) =>
  panel(page).getByRole("list", { name: "Units" }).getByRole("listitem", { name });
export async function fromTemplate(page: Page, name: string) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await card(page, "Base").waitFor();
}
export async function choose(page: Page, field: string, option: RegExp) {
  await panel(page).getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: option }).click();
}
export const gives = (page: Page, name: string) =>
  card(page, name).locator("[data-gives]").innerText();

/** The shell has read its agents: they are in the left bar, which a phone keeps behind Menu. */
export const agentsRead = (page: Page) =>
  page.locator('ul[aria-label="Agents"] li').first().waitFor({ state: "attached" });
