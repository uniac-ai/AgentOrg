// Create's card where nothing hovers, on a phone, and with reduced motion. In a real browser over
// the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator } from "@playwright/test";
import {
  browser,
  detail,
  edge,
  open,
  panel,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import {
  arrow,
  card,
  close,
  create,
  footBar,
  ground,
  moved,
  places,
  ring,
  tab,
  token,
} from "./create-card-kit.ts";
import { boxOf, wide } from "./create-window-kit.ts";

withBrowser();

test(
  "where nothing hovers the bar stands out at the name card's right, closed and open, and the window is no wider for it",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const [whole, was, out] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(tab(page)),
    ];
    assert.deepEqual(whole, was, "the window is the name card");
    assert.ok(Math.abs(was.x + 220 - 640) < 1, "in the page's middle");
    assert.ok(Math.abs(out.x + out.width - (was.x + was.width + 14)) < 0.5, "out at rest");
    assert.equal(await arrow(page), "out");
    assert.equal((await boxOf(edge(page))).width, 38, "pressed to the bar's end");
    await edge(page).tap();
    await wide(page, 800);
    await page.waitForTimeout(100);
    const now = await boxOf(card(page));
    assert.ok(
      Math.abs((await boxOf(tab(page))).x + out.width - (now.x + now.width + 14)) < 0.5,
      "still out, at the name card's right",
    );
    assert.equal(await arrow(page), "back");
    await page.close();
  }),
);

test(
  "on a phone the bar is along the card's foot, thin and there without a pointer over it, and what the agent can do opens under it, the taller window in the page's middle",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const [was, button, under] = [
      await boxOf(card(page)),
      await boxOf(close(page)),
      await boxOf(edge(page)),
    ];
    assert.equal(await tab(page).isVisible(), false, "no bar at the card's side");
    assert.equal(under.width, was.width, "as wide as the card");
    assert.ok(Math.abs(under.y - (was.y + was.height)) < 1, "along its foot");
    assert.equal(under.height, 24, "what is pressed");
    const drawn = await boxOf(footBar(page));
    assert.equal(drawn.height, 14, "thin, and drawn at rest");
    assert.ok(Math.abs(drawn.y + drawn.height - (under.y + under.height)) < 1);
    assert.equal(await ground(footBar(page)), await token(page, "--create"));
    // The name is its own size, larger than the line under it.
    assert.deepEqual(
      await window_.evaluate((e) => [
        getComputedStyle(e.querySelector("#build-name") as Element).fontSize,
        getComputedStyle(e.querySelector("textarea") as Element).fontSize,
      ]),
      ["22px", "16px"],
    );
    assert.equal(await detail(page).count(), 0);
    await edge(page).tap();
    const [whole, now, shown] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(detail(page)),
    ];
    assert.ok(Math.abs(whole.y + whole.height / 2 - 390) < 1, "in the page's middle");
    assert.ok(shown.y >= now.y + now.height + 24 - 1, "under the bar");
    assert.equal(shown.width, was.width);
    const moved_ = await boxOf(close(page));
    assert.deepEqual([moved_.x - now.x, moved_.y - now.y], [button.x - was.x, button.y - was.y]);
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) => text.split("\n")[0]),
      ["Computer", "Web"],
    );
    // The card's shadow falls down on it.
    assert.match(
      await detail(page)
        .locator("span[aria-hidden]")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundImage),
      /^linear-gradient\((?!to (right|left|top))/,
    );
    await edge(page).tap();
    assert.equal(await detail(page).count(), 0);
    assert.deepEqual(await boxOf(card(page)), was);
    await page.close();
  }),
);

test(
  "with reduced motion the bar is out at once and the window is at its width at once, and the row's buttons move it with no glide",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const moves = (part: Locator) =>
      part.evaluate((e) => {
        const { transitionProperty, transitionDuration } = getComputedStyle(e);
        return transitionProperty !== "none" && transitionDuration !== "0s";
      });
    const right = async () => {
      const box = await boxOf(card(page));
      return box.x + box.width;
    };
    assert.equal(await moves(tab(page)), false, "the bar does not slide");
    await edge(page).hover();
    assert.ok(Math.abs((await boxOf(tab(page))).x + 56 - ((await right()) + 14)) < 0.5, "at once");
    await edge(page).click();
    assert.equal(await moves(window_), false, "the window's width takes no time");
    assert.equal((await boxOf(window_)).width, 800, "at once");
    // The row is on its next place in the very frame after the press.
    const { chosen } = await ring(page);
    const beside = places(page)
      .nth((chosen + 1) % 20)
      .locator("div")
      .first();
    await window_.getByRole("button", { name: "Next avatar" }).click();
    await moved(page, chosen);
    assert.equal((await boxOf(beside)).width, 104, "whole, in the middle");
    await page.close();

    // Without it, the bar's slide takes time, and so does the window's width as it opens.
    const plain = await open(gateway);
    await create(plain);
    assert.equal(await moves(tab(plain)), true);
    assert.equal(await moves(panel(plain)), false, "not at rest");
    await edge(plain).click();
    assert.equal(await moves(panel(plain)), true, "while it opens");
    await plain.close();
  }),
);
