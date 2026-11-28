// Create's card opened: the bar at the name card's right edge, a second card's edge from beneath,
// and the window as two cards in the page's middle, the name card over what the agent can do. In a
// real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { detail, edge, open, startFrom, withBrowser, withGateway } from "./build-kit.ts";
import {
  arrow,
  card,
  close,
  create,
  ground,
  listen,
  still,
  tab,
  token,
  watch,
  watched,
} from "./create-card-kit.ts";
import { boxOf, wide } from "./create-window-kit.ts";

withBrowser();

test(
  "the bar that opens what the agent can do is a second card's edge under the name card: with the pointer or the keyboard on the card's right edge it slides out to the right with the card's light shadow on it, and the name card keeps its box and its outline",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    assert.equal(await detail(page).count(), 0, "what it can do is closed");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    const [whole, was, side] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(edge(page)),
    ];
    const right = was.x + was.width;
    assert.deepEqual(whole, was, "the window is the name card");
    assert.equal(was.width, 440);
    assert.ok(Math.abs(was.x + 220 - 720) < 1, "in the page's middle");
    // What is pressed: the card's last 24 below its head row.
    assert.deepEqual([side.x, side.width], [right - 24, 24]);
    assert.ok(side.y >= was.y + 56 && side.height > was.height / 2);

    // The bar is its own surface under the name card: not part of it, and painted beneath it.
    const beneath = await tab(page).evaluate((e) => {
      const form = document.querySelector('form[aria-label="Create"]') as Element;
      return {
        apart: !form.contains(e) && e.parentElement === form.parentElement,
        under: Number(getComputedStyle(e).zIndex) < Number(getComputedStyle(form).zIndex),
        corners: getComputedStyle(e).borderTopRightRadius,
        outline: getComputedStyle(form).borderRadius,
      };
    });
    assert.deepEqual(beneath, { apart: true, under: true, corners: "24px", outline: "24px" });
    assert.equal(await ground(tab(page)), await token(page, "--create"), "the other ground");
    assert.notEqual(await ground(tab(page)), await ground(card(page)));
    // At rest all of it, with the card's shadow on it, is behind the card.
    const shade = tab(page).locator("span").first();
    const hidden = await boxOf(tab(page));
    assert.ok(hidden.x >= was.x && hidden.x + hidden.width <= right + 0.5, "behind the card");
    assert.ok((await boxOf(shade)).x + 14 <= right + 0.5, "its shadow too");

    // With the pointer on the edge it slides out to the right, 14 of it, as the card's own
    // height and with the card's corners: the name card's box and outline are as they were,
    // and the window is no wider.
    await watch(page);
    await edge(page).hover();
    await still(page);
    await page.waitForTimeout(50);
    const out = await boxOf(tab(page));
    assert.ok(Math.abs(out.x + out.width - (right + 14)) < 0.5, "14 beyond the card's edge");
    assert.deepEqual([out.y, out.height], [was.y, was.height], "the card's height");
    const seen = await watched(page);
    assert.equal(seen.card.length, 1, `the card moved or grew: ${seen.card.join(" | ")}`);
    assert.deepEqual(seen.widths, [440], "the window is no wider");
    assert.equal(
      await card(page).evaluate((e) => getComputedStyle(e).borderRadius),
      "24px",
      "the card's outline",
    );
    // Its arrow points out, in the part that is out; the card's shadow lies on that part,
    // from the card's edge.
    const part = await boxOf(tab(page).locator("span").nth(1));
    assert.ok(Math.abs(part.x - right) < 0.5 && part.width === 14);
    assert.equal(await arrow(page), "out");
    const lit = await shade.evaluate((e) => {
      const { x, width } = e.getBoundingClientRect();
      return { x, width, image: getComputedStyle(e).backgroundImage };
    });
    assert.ok(Math.abs(lit.x - right) < 0.5 && lit.width === 14, "on the part that is out");
    assert.match(lit.image, /^linear-gradient\(to right/);
    assert.match(lit.image, /0\.14\)/, "very light");
    // What is pressed keeps its left edge and reaches the bar's end.
    const pressed = await boxOf(edge(page));
    assert.deepEqual([pressed.x, pressed.width], [side.x, 38]);
    await page.mouse.move(8, 8);
    await still(page);
    assert.ok((await boxOf(tab(page))).x + hidden.width <= right + 0.5, "back under the card");

    // With the keyboard on it, the same.
    await window_.getByRole("button", { name: "Create", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await edge(page).evaluate((e) => e === document.activeElement), true);
    await still(page);
    assert.ok(Math.abs((await boxOf(tab(page))).x + hidden.width - (right + 14)) < 0.5);
    await page.close();
  }),
);

test(
  "pressed, the window opens as two cards in the page's middle: the name card, moved left with its Close, lying over what the agent can do, on which its light shadow falls; the bar that closes it is at the same place, the name card's right edge, with its arrow pointing back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const [was, button, side] = [
      await boxOf(card(page)),
      await boxOf(close(page)),
      await boxOf(edge(page)),
    ];
    const grew = await listen(page);
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    await wide(page, 800);
    const how = await grew();
    assert.equal(how, "grew", `it grows, not jumps: its width's transition ${how}`);
    // Both together in the page's middle: the name card has moved left by half of what opened.
    const [whole, now, shown] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(detail(page)),
    ];
    assert.ok(Math.abs(whole.x + whole.width / 2 - 720) < 1, "in the page's middle");
    assert.deepEqual(
      [now.x, now.y, now.width, now.height],
      [was.x - 180, was.y, 440, was.height],
      "the name card, moved left",
    );
    const moved_ = await boxOf(close(page));
    assert.deepEqual(
      [moved_.x - now.x, moved_.y - now.y],
      [button.x - was.x, button.y - was.y],
      "Close is where it was on the card",
    );
    // What it can do is a card of its own under the name card: it starts under the card's edge
    // and ends at the window's, with its own corners, on the window's other ground.
    const right = now.x + now.width;
    assert.ok(shown.x < right && shown.x >= right - 40, "tucked under the card's edge");
    assert.ok(Math.abs(shown.x + shown.width - (whole.x + whole.width)) < 0.5);
    assert.equal(shown.x + shown.width - right, 360, "360 of it at the card's right");
    assert.deepEqual(
      await detail(page).evaluate((e) => {
        const form = document.querySelector('form[aria-label="Create"]') as Element;
        return [
          getComputedStyle(e).borderRadius,
          Number(getComputedStyle(e).zIndex) < Number(getComputedStyle(form).zIndex),
        ];
      }),
      ["24px", true],
    );
    assert.equal(await ground(detail(page)), await token(page, "--create"));
    assert.equal(await edge(page).getAttribute("aria-controls"), "create-detail");
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) =>
        text.split("\n").filter(Boolean),
      ),
      [
        [
          "Computer",
          "Terminal, files and a browser",
          "computer, browser",
          "terminal, files, computer, browser",
        ],
        ["Web", "Search and fetch", "web", "web-research"],
      ],
    );
    assert.equal(await detail(page).getByRole("listitem").first().locator("svg").count(), 3);
    assert.equal(
      await detail(page)
        .locator("input, textarea, select, button, [role=combobox], [role=switch]")
        .count(),
      0,
      "shown, not asked",
    );
    // The name card's shadow on it: from the card's edge, 20 wide, very light.
    const shade = detail(page).locator("span[aria-hidden]").first();
    const lit = await shade.evaluate((e) => {
      const { x, width } = e.getBoundingClientRect();
      return { x, width, image: getComputedStyle(e).backgroundImage };
    });
    assert.ok(Math.abs(lit.x - right) < 0.5 && lit.width === 20, "at the card's edge");
    assert.match(lit.image, /^linear-gradient\(to right/);
    assert.match(lit.image, /0\.14\)/, "black at 14 in a hundred, in the dark theme");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    assert.match(
      await shade.evaluate((e) => getComputedStyle(e).backgroundImage),
      /0\.04\)/,
      "and at 4 in the light one",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });

    // The bar that closes it: what is pressed is where it was on the name card, and nothing is
    // at the window's far edge. At rest it is behind the card.
    await page.mouse.move(8, 8);
    await window_.locator("#build-name").focus();
    await still(page);
    const again = await boxOf(edge(page));
    assert.deepEqual(
      [again.x - now.x, again.y - now.y, again.width, again.height],
      [side.x - was.x, side.y - was.y, 24, side.height],
      "at the same place on the name card",
    );
    assert.equal(await window_.locator("[data-edge]").count(), 1, "the one control");
    assert.ok(again.x + again.width < whole.x + whole.width - 300, "none at the far edge");
    assert.ok((await boxOf(tab(page))).x + 56 <= right + 0.5, "behind the card at rest");
    // Under the pointer it slides out the same way, over the start of what it can do, and its
    // arrow points back; nothing of the list is under it, and nothing moves or changes size.
    await edge(page).hover();
    await still(page);
    const out = await boxOf(tab(page));
    assert.ok(Math.abs(out.x + out.width - (right + 14)) < 0.5, "14 beyond the card's edge");
    assert.equal(await arrow(page), "back");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    const first = await boxOf(detail(page).getByRole("listitem").first());
    assert.ok(first.x >= right + 14, "the list is clear of it");
    assert.ok((await boxOf(detail(page).getByRole("heading"))).x >= right + 14);
    assert.deepEqual(await boxOf(window_), whole, "the window as it was");
    assert.deepEqual(await boxOf(card(page)), now, "the name card as it was");

    // A unit nobody offers here is named by its id, and holds Create back.
    await startFrom(page, "From elsewhere");
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) =>
        text.split("\n").filter(Boolean),
      ),
      [["mystery", "Not available here."]],
    );
    assert.equal(
      await window_.getByRole("button", { name: "Create", exact: true }).isDisabled(),
      true,
    );
    await startFrom(page, "Empty");
    assert.equal(await detail(page).getByRole("listitem").count(), 0);
    await detail(page).getByText("Nothing yet.").waitFor();

    // Pressed again it closes: the name card alone, back in the page's middle, no shadow left.
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    await wide(page, 440);
    assert.deepEqual(await boxOf(card(page)), was);
    assert.equal(await detail(page).count(), 0);
    assert.equal(await window_.locator("#create-detail > span[aria-hidden]").count(), 0);
    // Once it has closed it is not drawn behind the card.
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#create-detail") as Element).visibility ===
        "hidden",
    );
    // Opened again, the window starts as the card alone.
    await edge(page).click();
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await create(page);
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    assert.deepEqual(await boxOf(window_), was);
    await page.close();
  }),
);
