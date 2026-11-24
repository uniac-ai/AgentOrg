// Create's window by the page's width, where what the agent can do is under the name card, and as
// the page is resized across the width where that changes. In a real browser over the stand-in
// gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { detail, edge, open, withBrowser, withGateway } from "./build-kit.ts";
import { card, create, looksRight, WIDTHS } from "./create-card-kit.ts";
import { boxOf, wide } from "./create-window-kit.ts";

withBrowser();

test(
  "under 768 wide the window has what it can do under the card, whole and in the page's middle at each width: 700, 560, 430 and 390",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of WIDTHS.filter(([width]) => width < 768))
      await looksRight(page, width, height);
    await page.close();
  }),
);

test(
  "a page resized with what the agent can do open changes the window's layout at once, with no width in between: beside the card at 900, under it at 700, and back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.setViewportSize({ width: 900, height: 800 });
    const window_ = await create(page);
    await edge(page).click();
    await wide(page, 800);
    // Once it has opened, its width no longer takes time.
    await page.waitForFunction(
      () =>
        !getComputedStyle(
          document.querySelector('[data-slot="dialog-content"]') as Element,
        ).transitionProperty.includes("width"),
    );
    const frame = () =>
      page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
    for (const [width, across, beside] of [
      [700, 440, false],
      [900, 800, true],
      [780, 748, true],
      [760, 440, false],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await frame();
      const [whole, name, shown] = [
        await boxOf(window_),
        await boxOf(card(page)),
        await boxOf(detail(page)),
      ];
      assert.equal(whole.width, across, `at once, at ${width}`);
      assert.ok(Math.abs(whole.x + whole.width / 2 - width / 2) < 1, `in the middle, at ${width}`);
      assert.ok(whole.x >= 16 - 0.5 && whole.x + whole.width <= width - 16 + 0.5);
      if (beside) assert.equal(shown.x + shown.width - (name.x + name.width), across - 440);
      else assert.ok(shown.y >= name.y + name.height - 0.5, `under the card, at ${width}`);
      assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    }
    await page.close();
  }),
);
