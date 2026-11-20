// What the fixed pages' tests share: a page opened at an address over the stand-in gateway, an agent's
// row in Team and its state on its page, and a gateway made for each test and closed after it.
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway } from "./build-kit.ts";
import { SESSION, standIn } from "./stand-in.ts";

export async function open(
  gateway: Gateway,
  hash = "#/",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser().newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** An agent's row in the team page's list, by its name and, if given, what its line says. */
export const inTeam = (page: Page, name: string, says?: string) => {
  const row = page
    .getByRole("main")
    .getByRole("list", { name: "Agents" })
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
  return says ? row.filter({ has: page.getByText(says, { exact: true }) }) : row;
};
export const box = (locator: Locator) => locator.boundingBox();
/** How an agent's page says it stands. */
export const state = (page: Page) => page.getByRole("main").getByRole("status", { name: "State" });
export const withGateway =
  (run: (gateway: Gateway) => Promise<void>, options?: Parameters<typeof standIn>[0]) =>
  async () => {
    const gateway = await standIn(options);
    try {
      await run(gateway);
    } finally {
      await gateway.close();
    }
  };
