// What the files window's tests share: Research's computer with a sample workspace, its page with its files
// in front, on the page's clock or not, and the window's parts and what the surface was asked.
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { browser, type Gateway } from "./build-kit.ts";
import { computer } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

export const withGateway =
  (run: (gateway: Gateway) => Promise<void>, operate = true) =>
  async () => {
    const gateway = await standIn();
    try {
      computer(gateway, [
        { surface: "browser", protocol: "screencast@1", operate },
        { surface: "terminal", protocol: "terminal@1", operate },
        { surface: "files", protocol: "files@1", operate },
      ]);
      gateway.putFile("notes.txt", "Remember the milk.", 3);
      gateway.putFile("storefront/README.md", "# Storefront\n\nThe shop's web app.", 125);
      gateway.putFile("storefront/package.json", `{ "name": "storefront" }`, 60 * 30);
      gateway.putFile("storefront/src/checkout/form.ts", "export const form = 1;", 1);
      await run(gateway);
    } finally {
      await gateway.close();
    }
  };
/** Research's page with its files in front. */
export async function open(gateway: Gateway): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  await page
    .getByRole("navigation", { name: "Dock" })
    .getByRole("button", { name: "Files" })
    .click();
  await files(page).getByRole("list", { name: "Files" }).getByRole("button").first().waitFor();
  return page;
}
export const files = (page: Page) => page.getByRole("main").getByRole("group", { name: "Files" });
/** The rows shown, each as its words in order. */
export const rows = async (page: Page) =>
  (await files(page).getByRole("list", { name: "Files" }).getByRole("button").allInnerTexts()).map(
    (row) =>
      row
        .split("\n")
        .filter((word) => word.trim())
        .join(" | "),
  );
export const where = (page: Page) => files(page).getByRole("group", { name: "Folder" }).innerText();
/** Whether a row, by its name, is marked as changed lately. */
export const marked = async (page: Page, name: string | RegExp) => {
  const row = files(page)
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) });
  assert.equal(await row.count(), 1, `one row named ${name}`);
  return (await row.getByRole("img", { name: "Changed" }).count()) > 0;
};
/** Waits, for no longer than a test's own waits, until something outside the page is so. */
export async function until(so: () => boolean, what: string) {
  for (const end = Date.now() + 8000; !so(); ) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
/** Research's page with its files in front, on a clock the test moves. */
export async function openOnClock(gateway: Gateway): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.clock.install();
  await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  await page
    .getByRole("navigation", { name: "Dock" })
    .getByRole("button", { name: "Files" })
    .click();
  await files(page)
    .getByRole("button", { name: /notes\.txt/ })
    .waitFor();
  return page;
}
/** How often a folder was read. */
export const lists = (gateway: Gateway) =>
  gateway.live.files.asked.filter((one) => one.type === "list").length;
/** The folder is read once more, as it is every so often. */
export async function nextRead(page: Page, gateway: Gateway) {
  const before = lists(gateway);
  await page.clock.fastForward(5000);
  await until(() => lists(gateway) > before, "the folder to be read again");
}
export const which = (page: Page, name: string | RegExp) =>
  files(page).getByRole("tablist", { name: "Which files" }).getByRole("tab", { name });
/** What was asked of the surface about what changed, each with the time it was asked from. */
export const walks = (gateway: Gateway) =>
  gateway.live.files.asked.filter((one) => one.type === "changed").map((one) => String(one.since));
export const up = (page: Page) => files(page).getByRole("button", { name: "Up", exact: true });
