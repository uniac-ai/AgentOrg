// What the build tests share: a browser per file, a page on the stand-in gateway, and the
// window's parts by name.
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let launched: Browser;
/**
 * A browser for the file that calls this, closed after its tests. Each test ends with no page
 * open: one that fails before it closes its own would slow the tests after it in the file.
 */
export function withBrowser() {
  test.before(async () => {
    launched = await chromium.launch();
  });
  test.afterEach(() => Promise.all(launched.contexts().map((context) => context.close())));
  test.after(() => launched.close());
}
export const browser = () => launched;

export type Gateway = Awaited<ReturnType<typeof standIn>>;
export { SESSION };
export async function open(gateway: Gateway): Promise<Page> {
  const page = await launched.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  // Team, where Create is.
  await page.goto(`${gateway.url}/#/team`);
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
export const panel = (page: Page) =>
  page.getByRole("dialog", { name: /^(Create New Agent|New template)$/ });
/** The Settings window, which the creation window opens over from Templates. */
export const settingsWindow = (page: Page) => page.getByRole("dialog", { name: "Settings" });
export const card = (page: Page, name: string) =>
  panel(page).getByRole("region", { name, exact: true });
export async function fromTemplate(page: Page, name: string) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await card(page, "Base").waitFor();
}
/**
 * New template, from Settings: on its own, or from a template. It is the window that builds a stack,
 * its options in sections, which Create for an agent no longer has. Once its stack is drawn.
 */
export async function newTemplate(page: Page, from?: string) {
  await agentsRead(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Settings" })
    .click();
  const settings = settingsWindow(page);
  // On a phone Settings opens on its sections, and Templates is chosen from them.
  if ((page.viewportSize()?.width ?? 0) < 640)
    await settings
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Templates" })
      .click();
  await settings
    .getByRole("button", {
      name: from ? `New template from ${from}` : "New template",
      exact: true,
    })
    .click();
  await card(page, "Base").waitFor();
}
export async function choose(page: Page, field: string, option: RegExp) {
  await panel(page).getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: option }).click();
}
export const gives = (page: Page, name: string) =>
  card(page, name).locator("[data-gives]").innerText();

/** The shell has read its agents: they are in the team page's list. */
export const agentsRead = (page: Page) =>
  page.locator('ul[aria-label="Agents"] li').first().waitFor({ state: "attached" });
