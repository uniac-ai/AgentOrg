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
export const chooser = panel;
export const card = (page: Page, name: string) =>
  panel(page).getByRole("list", { name: "Units" }).getByRole("listitem", { name });
export async function fromTemplate(page: Page, name: string) {
  await page.getByRole("list", { name: "Your agents" }).waitFor();
  await plus(page).click();
  await chooser(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await panel(page).waitFor();
}
export async function choose(page: Page, field: string, option: RegExp) {
  await panel(page).getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: option }).click();
}
/** Opens a card that started as one row. */
export const unfold = (page: Page, name: string) =>
  card(page, name)
    .getByRole("button", { name: `Open ${name}` })
    .click();
export const gives = (page: Page, name: string) =>
  card(page, name).locator("[data-gives]").innerText();
