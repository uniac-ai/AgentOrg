// The frame around the pages, wide, as a rail and on a phone, in a real browser over the stand-in
// gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
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

/** A part's box as [x, y, width, height]. */
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height];
};

test(
  "wide, the frame's parts are where the design puts them",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const nav = page.getByRole("navigation", { name: "Main" });
    const row = (name: string) => nav.getByRole("button", { name, exact: true });
    await row("Working Research").waitFor();
    assert.deepEqual(await boxOf(nav), [0, 0, 236, 900]);
    assert.deepEqual(await boxOf(row("Home")), [10, 12, 216, 40]);
    assert.deepEqual(await boxOf(nav.getByRole("searchbox")), [10, 60, 180, 36]);
    assert.deepEqual(await boxOf(row("Create")), [194, 62, 32, 32]);
    // Rows are 40 tall and 42 apart.
    assert.deepEqual(await boxOf(row("Working Research")), [10, 106, 216, 40]);
    assert.deepEqual(await boxOf(row("Idle Reviewer")), [10, 148, 216, 40]);
    assert.deepEqual(await boxOf(row("Has a problem Triage")), [10, 190, 216, 40]);
    assert.deepEqual(await boxOf(row("Templates")), [10, 808, 216, 40]);
    assert.deepEqual(await boxOf(row("Settings")), [10, 850, 216, 40]);
    // A face is 28 across in its row, and its mark is 8, at the face's foot on the right.
    const mark = row("Working Research").getByRole("img", { name: "Working" });
    assert.deepEqual(await boxOf(mark.locator("xpath=..")), [18, 112, 28, 28]);
    assert.deepEqual(await boxOf(mark), [38, 132, 8, 8]);
    assert.equal(
      await row("Working Research").evaluate((e) => getComputedStyle(e).fontSize),
      "15px",
    );
    // The page is everything beside the bar, with no frame of its own.
    const main = page.locator("main");
    assert.deepEqual(await boxOf(main), [236, 0, 1204, 900]);
    assert.deepEqual(
      await main.evaluate((e) => {
        const style = getComputedStyle(e);
        return [style.backgroundColor, style.borderTopLeftRadius];
      }),
      ["rgba(0, 0, 0, 0)", "0px"],
    );
    await page.close();
  }),
);

test(
  "as a rail, the frame's parts are where the design puts them, and so is the drawer its search opens",
  withGateway(async (gateway) => {
    const page = await open(gateway, { width: 800, height: 900 });
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Working Research" }).waitFor();
    assert.deepEqual(await boxOf(nav), [0, 0, 60, 900]);
    assert.deepEqual(await boxOf(nav.getByRole("button", { name: "Home" })), [8, 12, 44, 40]);
    assert.deepEqual(
      await boxOf(nav.getByRole("button", { name: "Search", exact: true })),
      [14, 60, 32, 32],
    );
    assert.deepEqual(await boxOf(nav.getByRole("button", { name: "Create" })), [14, 96, 32, 32]);
    assert.deepEqual(
      await boxOf(nav.getByRole("button", { name: "Working Research" })),
      [8, 138, 44, 40],
    );
    assert.deepEqual(await boxOf(page.locator("main")), [60, 0, 740, 900]);
    await nav.getByRole("button", { name: "Search", exact: true }).click();
    const drawer = page.getByRole("dialog").getByRole("navigation", { name: "Main" });
    assert.deepEqual(await boxOf(drawer), [0, 0, 272, 900]);
    assert.deepEqual(await boxOf(drawer.getByRole("searchbox")), [10, 60, 216, 36]);
    // A click on the page behind it closes it.
    await page.locator("[data-drawer-overlay]").click({ position: { x: 600, y: 400 } });
    await drawer.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "on a phone, the frame's parts are where the design puts them, and so is the drawer behind Menu",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE);
    const head = page.getByRole("banner");
    assert.deepEqual(await boxOf(head), [0, 0, 390, 48]);
    assert.deepEqual(await boxOf(head.getByRole("button", { name: "Menu" })), [8, 8, 32, 32]);
    assert.deepEqual(await boxOf(page.locator("main")), [0, 48, 390, 796]);
    await head.getByRole("button", { name: "Menu" }).click();
    const menu = page.getByRole("dialog").getByRole("navigation", { name: "Main" });
    assert.deepEqual(await boxOf(menu), [0, 0, 272, 844]);
    assert.deepEqual(await boxOf(menu.getByRole("button", { name: "Home" })), [10, 12, 252, 40]);
    assert.equal(
      await menu.getByRole("searchbox").evaluate((e) => e === document.activeElement),
      false,
      "opened as a menu, its search isn't taken to be wanted",
    );
    // Create from the drawer: its window opens once the drawer is gone, and has the keyboard.
    await menu.getByRole("button", { name: "Create" }).click();
    await menu.waitFor({ state: "detached" });
    const create = page.getByRole("dialog", { name: "Create" });
    await create.getByRole("button", { name: "Empty" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]'));
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
    // Narrowed to a rail, which has no field to show or clear a search, every agent is there.
    await search.fill("re");
    await page.setViewportSize({ width: 800, height: 900 });
    await nav.getByRole("button", { name: "Triage" }).waitFor();
    assert.equal(await nav.getByRole("list", { name: "Agents" }).getByRole("listitem").count(), 5);
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
    await search.and(page.locator(":focus")).waitFor();
    await search.click();
    await field.waitFor();
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    await search.and(page.locator(":focus")).waitFor();
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
  "Settings picks its sections across the top, with what a section offers at their end, and they don't move between sections",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/skills");
    await page.getByRole("button", { name: "Dismiss" }).click();
    const main = page.getByRole("main");
    const list = main.getByRole("tablist");
    const skills = main.getByRole("tab", { name: "Skills" });
    const account = main.getByRole("tab", { name: "Account" });
    const add = main.getByRole("button", { name: "Add skill" });
    await add.waitFor();
    const before = await list.boundingBox();
    const [one, two, offer] = [
      await skills.boundingBox(),
      await account.boundingBox(),
      await add.boundingBox(),
    ];
    assert.ok(one && two && before && offer);
    assert.ok(two.x > one.x && Math.abs(two.y - one.y) < 1, "a row");
    // The page is 1080 wide and centred beside the bar; the row is 20 in from its sides.
    const room = await main.boundingBox();
    assert.ok(room);
    const left = room.x + (room.width - 1080) / 2;
    assert.deepEqual([before.x, before.y, before.height], [left + 20, 24, 32]);
    assert.ok(Math.abs(offer.y + offer.height / 2 - (before.y + 16)) < 1, "on the same row");
    assert.equal(offer.x + offer.width, left + 1080 - 20, "what it offers ends the row");
    const row = await main.getByText("cite-sources").first().boundingBox();
    assert.ok(row && row.y > before.y + before.height, "the section is under them");
    // It is one row for every section: it keeps the keyboard as the section under it changes.
    await list.evaluate((row) => row.setAttribute("data-same", "row"));
    await skills.focus();
    await page.keyboard.press("ArrowRight");
    await main.getByRole("tab", { name: "MCP connections", selected: true }).waitFor();
    await main.getByRole("button", { name: "Connect", exact: true }).waitFor();
    assert.equal(await add.count(), 0, "what the section offers changes with it");
    await page.keyboard.press("ArrowRight");
    await main.getByRole("tab", { name: "Providers", selected: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Providers");
    assert.equal(await list.getAttribute("data-same"), "row", "the same row, not another like it");
    await account.click();
    await main.getByRole("tab", { name: "Account", selected: true }).waitFor();
    assert.deepEqual(await list.boundingBox(), before);
    assert.equal(
      await list.locator("xpath=../..").getByRole("button").count(),
      0,
      "Account offers nothing",
    );
    await page.close();
  }),
);

test(
  "at phone width nothing runs off the side, and Create and Settings still work",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE);
    // Home, with its chats on it.
    await page
      .getByRole("main")
      .getByRole("region", { name: "Recent" })
      .getByRole("listitem")
      .first()
      .waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Main" }).isVisible(), false);
    assert.equal(await fits(page), true, "Home");
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
    assert.deepEqual(
      await page.getByRole("tab").allInnerTexts(),
      ["Templates", "Skills", "MCPs", "Providers", "Account"],
      "the long one is said short",
    );
    const first = await page.getByRole("tab", { name: "Templates" }).boundingBox();
    assert.ok(first && first.x >= 0, "the first section isn't cut off");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("tab", { name: "Skills" }).click();
    // What it offers is its mark alone there, at the end of a row that scrolls sideways.
    const add = page.getByRole("button", { name: "Add skill" });
    assert.equal((await add.innerText()).trim(), "");
    await add.evaluate((button) => {
      const row = button.parentElement as HTMLElement;
      row.scrollLeft = row.scrollWidth;
    });
    const action = await add.boundingBox();
    assert.ok(action && action.x + action.width <= PHONE.width, "what it offers comes into view");
    assert.equal(await fits(page), true, "settings");
    await page.close();
  }),
);
