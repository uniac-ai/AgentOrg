// The frame around the pages, at both widths, in a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(gateway: Gateway, viewport: typeof WIDE, hash = "#/"): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Nothing runs off the side of the page. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test(
  "the top bar runs the full width, and the left bar starts below it",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Research" }).waitFor();
    const crumbs = await page.getByRole("navigation", { name: "breadcrumb" }).boundingBox();
    const left = await nav.boundingBox();
    assert.ok(crumbs && left);
    assert.ok(crumbs.x < 40, "the top bar starts at the window's edge");
    assert.ok(left.y >= crumbs.y + crumbs.height, "the left bar is below it");
    const search = await nav.getByRole("searchbox", { name: "Search agents" }).boundingBox();
    const plus = await nav.getByRole("button", { name: "Create" }).boundingBox();
    assert.ok(search && plus);
    assert.ok(Math.abs(search.y + search.height / 2 - (plus.y + plus.height / 2)) < 1, "one row");
    assert.ok(plus.x > search.x + search.width - 1, "the plus on its right");
    assert.ok(search.y < (await nav.getByRole("button", { name: "Agents" }).boundingBox())!.y);
    await page.close();
  }),
);

test(
  "search narrows the agents by name, and what it leaves out comes back",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const nav = page.getByRole("navigation", { name: "Main" });
    const names = () => nav.getByRole("listitem").allInnerTexts();
    await nav.getByRole("button", { name: "Research" }).waitFor();
    const search = nav.getByRole("searchbox", { name: "Search agents" });
    await search.fill("re");
    assert.deepEqual(
      (await names()).map((n) => n.trim()),
      ["Research", "Reviewer", "Weekly report"],
    );
    await search.fill("zzz");
    assert.deepEqual(await names(), ["No agent by that name"]);
    await search.fill("");
    assert.equal((await names()).length, 5);
    await page.close();
  }),
);

test(
  "Settings picks its sections on the left, and they don't move between sections",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/skills");
    const list = page.getByRole("tablist");
    const skills = page.getByRole("tab", { name: "Skills" });
    const account = page.getByRole("tab", { name: "Account" });
    await page.getByRole("button", { name: "Add skill" }).waitFor();
    const before = await list.boundingBox();
    const [one, two] = [await skills.boundingBox(), await account.boundingBox()];
    assert.ok(one && two && before);
    assert.ok(two.y > one.y && Math.abs(two.x - one.x) < 1, "a column");
    const row = await page.getByRole("main").getByText("cite-sources").first().boundingBox();
    assert.ok(row && row.x > before.x + before.width, "the section is to its right");
    await account.click();
    await page.getByRole("tab", { name: "Account", selected: true }).waitFor();
    assert.deepEqual(await list.boundingBox(), before);
    await page.close();
  }),
);

test(
  "at phone width nothing runs off the side, and Create and Settings still work",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Main" }).isVisible(), false);
    assert.equal(await fits(page), true, "agents");
    await page
      .getByRole("button", { name: "Create", exact: true })
      .filter({ visible: true })
      .click();
    const chooser = page.getByRole("dialog", { name: "Create" });
    await chooser.getByRole("button", { name: /^Assistant/ }).click();
    const stack = page.getByRole("dialog", { name: /^New agent/ });
    await stack.getByLabel("Name").fill("Foreman");
    await page.waitForTimeout(250);
    const box = await stack.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, "the popup fits across");
    assert.ok(box.y >= 0 && box.y + box.height <= PHONE.height, "and down");
    await stack.getByRole("button", { name: "Create", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await stack.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Settings" }).filter({ visible: true }).click();
    const skills = page.getByRole("tab", { name: "Skills" });
    const account = page.getByRole("tab", { name: "Account" });
    await skills.waitFor();
    const [one, two] = [await skills.boundingBox(), await account.boundingBox()];
    assert.ok(one && two && two.x > one.x && Math.abs(two.y - one.y) < 1, "sections in a row");
    const first = await page.getByRole("tab", { name: "Templates" }).boundingBox();
    assert.ok(first && first.x >= 0, "the first section isn't cut off");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("tab", { name: "Skills" }).click();
    const action = await page.getByRole("button", { name: "Add skill" }).boundingBox();
    assert.ok(action && action.x + action.width <= PHONE.width, "what it offers stays in view");
    assert.equal(await fits(page), true, "settings");
    await page.close();
  }),
);
