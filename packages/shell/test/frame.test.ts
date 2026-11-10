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
  "the left bar runs the window's height: Home first, search with Create beside it, the agents, then Templates and Settings at the foot",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Research" }).waitFor();
    const bar = await nav.boundingBox();
    assert.deepEqual(bar, { x: 0, y: 0, width: 236, height: WIDE.height });
    assert.equal(await page.getByRole("banner").filter({ visible: true }).count(), 0, "no top bar");
    assert.equal(await nav.getByRole("button").first().innerText(), "Home");
    const home = await nav.getByRole("button", { name: "Home" }).boundingBox();
    assert.ok(home && home.y < 20, "nothing above Home");
    assert.equal(
      await nav.getByRole("button", { name: "Home" }).getAttribute("aria-current"),
      "page",
    );
    assert.doesNotMatch(await nav.innerText(), /AgentOrg/, "no product name in the bar");
    const y = async (name: string) => {
      const box = await nav.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box, name);
      return box.y + box.height / 2;
    };
    const search = await nav.getByRole("searchbox", { name: "Search" }).boundingBox();
    const plus = await nav.getByRole("button", { name: "Create" }).boundingBox();
    assert.ok(search && plus);
    assert.ok(Math.abs(search.y + search.height / 2 - (await y("Create"))) < 1, "one row");
    assert.ok(plus.x > search.x + search.width - 1, "the plus on its right");
    const last = await nav.getByRole("button", { name: "Broken" }).boundingBox();
    assert.ok(last);
    assert.ok((await y("Home")) < search.y, "Home above the search row");
    assert.ok(search.y < (await nav.getByRole("button", { name: "Research" }).boundingBox())!.y);
    assert.ok(last.y + last.height < (await y("Templates")), "Templates below the agents");
    assert.ok((await y("Templates")) < (await y("Settings")), "Settings last");
    assert.ok(WIDE.height - (await y("Settings")) < 60, "at the foot");
    await page.close();
  }),
);

test(
  "search narrows the agents by name, and what it leaves out comes back",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const nav = page.getByRole("navigation", { name: "Main" });
    const names = () =>
      nav.getByRole("list", { name: "Agents" }).getByRole("listitem").allInnerTexts();
    await nav.getByRole("button", { name: "Research" }).waitFor();
    const search = nav.getByRole("searchbox", { name: "Search" });
    const still = await nav.getByRole("button", { name: "Settings" }).boundingBox();
    await search.fill("re");
    assert.deepEqual(
      (await names()).map((n) => n.split("\n").at(-1)),
      ["Research", "Reviewer", "Weekly report"],
    );
    await search.fill("zzz");
    assert.deepEqual(await names(), []);
    assert.deepEqual(await nav.getByRole("button", { name: "Settings" }).boundingBox(), still);
    await search.fill("");
    assert.equal((await names()).length, 5);
    await page.close();
  }),
);

test(
  "narrow, the bar is a rail of faces, and its search opens the whole bar with the field ready",
  withGateway(async (gateway) => {
    const page = await open(gateway, { width: 820, height: 900 });
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Research" }).waitFor();
    assert.equal((await nav.boundingBox())?.width, 60);
    assert.equal(await nav.getByRole("searchbox").isVisible(), false);
    const face = await nav.getByRole("button", { name: "Research" }).boundingBox();
    assert.ok(face && face.x >= 0 && face.x + face.width <= 60, "a row is its face alone");
    const main = await page.locator("main").boundingBox();

    await nav.getByRole("button", { name: "Search", exact: true }).click();
    const drawer = page.getByRole("dialog").getByRole("navigation", { name: "Main" });
    const field = drawer.getByRole("searchbox", { name: "Search" });
    await field.waitFor();
    assert.equal((await page.getByRole("dialog").boundingBox())?.width, 272);
    assert.equal(await field.evaluate((e) => e === document.activeElement), true, "ready to type");
    assert.deepEqual(
      await page.locator("main").boundingBox(),
      main,
      "over the page, moving nothing",
    );
    await field.fill("tri");
    await drawer.getByRole("button", { name: "Triage" }).click();
    await drawer.waitFor({ state: "detached" });
    await page.waitForURL(/#\/a\/a-triage/);
    // What was typed went with the drawer, and the keyboard is back where it was.
    assert.equal(await nav.getByRole("list", { name: "Agents" }).getByRole("listitem").count(), 5);
    const search = nav.getByRole("button", { name: "Search", exact: true });
    assert.equal(await search.evaluate((e) => e === document.activeElement), true);
    await search.click();
    await field.waitFor();
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    assert.equal(await search.evaluate((e) => e === document.activeElement), true);
    // A long list scrolls in the rail as in the bar, with no bar of its own showing.
    assert.deepEqual(
      await nav.getByRole("list", { name: "Agents" }).evaluate((list) => {
        const style = getComputedStyle(list.parentElement as Element);
        return [style.overflowY, style.scrollbarWidth];
      }),
      ["auto", "none"],
    );
    assert.equal(
      await nav.getByRole("button", { name: "Triage" }).getAttribute("aria-current"),
      "page",
      "the rail shows where you are",
    );
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
    // The bar is behind the menu button, and the top of the page names the place.
    const head = page.getByRole("banner");
    assert.equal(await head.innerText(), "Home");
    await head.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog").getByRole("navigation", { name: "Main" });
    assert.equal(await drawer.getByRole("button").first().innerText(), "Home");
    await drawer.getByRole("button", { name: "Create", exact: true }).click();
    await drawer.waitFor({ state: "detached" });
    const stack = page.getByRole("dialog", { name: "Create" });
    await stack.getByRole("button", { name: /^Assistant/ }).click();
    await stack.getByLabel("Name").fill("Foreman");
    await page.waitForTimeout(250);
    const box = await stack.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, "the popup fits across");
    assert.ok(box.y >= 0 && box.y + box.height <= PHONE.height, "and down");
    await stack.getByRole("button", { name: "Create", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await stack.waitFor({ state: "detached" });
    await head.getByRole("button", { name: "Menu" }).click();
    await drawer.getByRole("button", { name: "Settings" }).click();
    await drawer.waitFor({ state: "detached" });
    assert.equal(await head.innerText(), "Settings");
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

test(
  "the Create window doesn't animate its size when motion is reduced",
  withGateway(async (gateway) => {
    const page = await browser.newPage({ viewport: WIDE, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/`);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Create" })
      .click();
    const window_ = page.getByRole("dialog", { name: "Create" });
    await window_.getByRole("button", { name: "Empty" }).waitFor();
    assert.equal(await window_.evaluate((el) => getComputedStyle(el).transitionProperty), "none");
    const empty = window_.getByRole("button", { name: "Empty" });
    await empty.click();
    await window_.locator("#build-name").waitFor();
    await empty.click();
    await window_.locator("#build-name").waitFor({ state: "detached", timeout: 200 });
    await page.close();
  }),
);
