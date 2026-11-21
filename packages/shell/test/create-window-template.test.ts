// New template's window as a whole: its stack scrolling between its head and its foot, its card
// on top on a phone, and the row of templates to start from.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import {
  browser,
  card,
  newTemplate,
  open,
  panel,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { boxOf, chosen, identity, named, openTemplate } from "./create-window-kit.ts";
import { sampleBuild } from "./design/samples.ts";

withBrowser();

/** The options' sections, by their headings' words. */
const sections = (page: Page) =>
  panel(page).locator('form[aria-label="Build"] section h3').allInnerTexts();

test(
  "New template's stack scrolls between the window's head and its foot, which stay",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page);
    const window_ = panel(page);
    for (let i = 0; i < 10; i++) {
      await window_.getByRole("button", { name: "Add a unit" }).click();
      await page.getByRole("menuitem", { name: /^Web/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    const create = named(page, "Save template");
    const options = window_.getByRole("button", { name: "Close" }).filter({ visible: true });
    const before = [await boxOf(create), await boxOf(options)];
    const scrolled = await card(page, "Base").evaluate((el) => {
      const scroller = el.parentElement as HTMLElement;
      scroller.scrollTop = 500;
      return scroller.scrollTop;
    });
    assert.ok(scrolled > 0, "it scrolls");
    assert.deepEqual([await boxOf(create), await boxOf(options)], before);
    const box = await boxOf(window_);
    assert.deepEqual([box.width, box.height], [920, 680], "and the window is as it was");
    await page.close();
  }),
);

test(
  "on a phone New template's card is on top, compact, the options under it, and the close at the corner",
  withGateway(async (gateway) => {
    const page = await browser().newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    await newTemplate(page);
    const window_ = panel(page);
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.deepEqual([box.x, box.width, box.height], [16, 358, 680]);
    // The card, compact: a small face beside the name and the line.
    const top = await boxOf(identity(page));
    assert.deepEqual([top.x - box.x, top.y - box.y, top.width], [0, 0, 358]);
    const face = await boxOf(
      identity(page).locator('[aria-hidden="true"]').filter({ visible: true }).first(),
    );
    assert.deepEqual([face.width, face.height], [44, 44]);
    const name = await boxOf(window_.locator("#build-name"));
    assert.ok(name.x >= face.x + face.width, "the name beside the face");
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    // What it can do, as small chips in a row.
    const chips = identity(page)
      .getByRole("list", { name: "What it can do" })
      .getByRole("listitem");
    const [first, second] = [await boxOf(chips.nth(0)), await boxOf(chips.nth(1))];
    assert.equal(first.y, second.y, "in a row");
    assert.equal(first.height, 28);
    // The options under the card.
    const from = await boxOf(window_.getByRole("list", { name: "Start from" }));
    assert.ok(from.y >= top.y + top.height, "what to start from under the card");
    // Where the window's head isn't drawn, the close is at the corner.
    const close = await boxOf(
      window_.getByRole("button", { name: "Close" }).filter({ visible: true }),
    );
    assert.deepEqual([box.x + box.width - (close.x + close.width), close.y - box.y], [8, 8]);
    await page.close();
  }),
);

test(
  "New template's row to start from is of small cards that scrolls sideways when longer than the window; choosing one marks it and fills the options",
  withGateway(async (gateway) => {
    // The design's sample, with more templates than the row has room for.
    sampleBuild(gateway);
    const page = await open(gateway);
    const window_ = await openTemplate(page);
    const row = window_.getByRole("list", { name: "Start from" });
    const tiles = row.getByRole("button");
    const [first, second] = [await boxOf(tiles.nth(0)), await boxOf(tiles.nth(1))];
    assert.deepEqual([first.width, first.height], [184, 60]);
    assert.equal(first.y, second.y, "one row");
    assert.equal(second.x, first.x + first.width + 8);
    assert.equal(await chosen(page, "Empty"), "true");
    const scrolled = await row.evaluate((e) => {
      e.scrollLeft = 100;
      return [e.scrollWidth > e.clientWidth, e.scrollLeft, getComputedStyle(e).scrollbarWidth];
    });
    assert.deepEqual(scrolled, [true, 100, "none"], "it scrolls sideways, with no bar");
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    assert.equal(await chosen(page, /^Assistant/), "true");
    assert.equal(await chosen(page, "Empty"), null);
    assert.deepEqual(await sections(page), ["Base", "Computer", "Web", "Add"]);
    await page.close();
  }),
);
