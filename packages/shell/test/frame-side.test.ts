// How wide the frame's side is, in a real browser over the stand-in gateway: the line between the
// page's list and its card is a handle, dragged or moved by the keyboard between the side's least
// and its most, the card taking the rest; the width is kept in the person's store. That the side
// comes back over the card while the list is put away is in frame-card.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { chatsOf, one, PINS, rows, said, tiles, until } from "./chat-list-kit.ts";

withBrowser();

/** Where the width is kept in the app's store. */
const WIDTH = "ui/list-width";

async function open(gateway: Gateway, width: number, hash = "#/chat"): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** The conversation the page opens beside its list, which it does once it has read the list. */
const opened = (page: Page) =>
  page.locator('main section[aria-label^="Conversation with"]').waitFor();
const handle = (page: Page) => page.getByRole("separator", { name: "List width" });
/** The list, the frame's rows and the card, left and width each, and what the handle says. */
const sides = (page: Page) =>
  page.evaluate(() => {
    const span = (e: Element | null | undefined) => {
      const box = e?.getBoundingClientRect();
      return box ? [box.x, box.width] : null;
    };
    const said = document.querySelector('[role="separator"][aria-label="List width"]');
    return {
      list: span(document.querySelector("main [data-list]")),
      rows: span(document.querySelector('nav[aria-label="Main"]')),
      card: span(
        document.querySelector('main section[aria-label^="Conversation with"]')?.parentElement,
      ),
      handle: span(said),
      says: ["aria-valuemin", "aria-valuenow", "aria-valuemax"].map((name) =>
        Number(said?.getAttribute(name)),
      ),
    };
  });
/** The frame with its side `side` wide, in a window `width` wide: the card has the rest, less 6. */
const sidesAt = (side: number, width = 1440, most = 480) => ({
  list: [0, side],
  rows: [0, side],
  card: [side, width - side - 6],
  handle: [side - 4, 8],
  says: [288, side, most],
});
/** Whether the handle's line is drawn, once its fading has run. */
const lineShown = (page: Page) =>
  handle(page)
    .locator("span")
    .evaluate(async (line) => {
      await Promise.all(line.getAnimations().map((fading) => fading.finished));
      return getComputedStyle(line).opacity === "1";
    });

test(
  "the line between the list and the card is a handle: nothing is drawn on it until it is pointed at, and dragged it makes the list as wide as the pointer says, between 288 and 480, the frame's rows as wide and the card taking the rest; the width is kept in the person's store as the drag ends, and the page opens again at it; a double click puts it back at 300",
  withGateway(async (gateway) => {
    let page = await open(gateway, 1440);
    await opened(page);
    assert.deepEqual(await sides(page), sidesAt(300));
    assert.equal(await handle(page).getAttribute("aria-orientation"), "vertical");
    assert.equal(await lineShown(page), false, "nothing is drawn at rest");
    assert.equal(gateway.notes.has(WIDTH), false);
    // Pointed at, it shows a thin line along the card's edge, between the card's corners, and the
    // pointer says it can be dragged.
    await page.mouse.move(301, 450);
    assert.equal(await lineShown(page), true, "the line shows while it is pointed at");
    assert.deepEqual(
      await handle(page).evaluate((part) => {
        const line = (part.firstElementChild as Element).getBoundingClientRect();
        return [getComputedStyle(part).cursor, line.x, line.y, line.width, line.height];
      }),
      ["col-resize", 299, 20, 2, 854],
    );
    await page.mouse.down();
    await page.mouse.move(381, 460, { steps: 4 });
    // While it is dragged the list is as wide already, and nothing is kept yet.
    assert.deepEqual(await sides(page), sidesAt(380));
    assert.equal(await lineShown(page), true, "the line shows while it is dragged");
    assert.equal(gateway.notes.has(WIDTH), false);
    // Past its most and its least it stays at them, wherever the pointer goes.
    await page.mouse.move(900, 460, { steps: 4 });
    assert.deepEqual(await sides(page), sidesAt(480));
    await page.mouse.move(700, 100, { steps: 2 });
    assert.equal(await lineShown(page), true, "the line shows while the pointer is off it");
    await page.mouse.move(60, 460, { steps: 4 });
    assert.deepEqual(await sides(page), sidesAt(288));
    await page.mouse.move(353, 470, { steps: 4 });
    await page.mouse.up();
    assert.deepEqual(await sides(page), sidesAt(352));
    await until(() => gateway.notes.get(WIDTH), 352);
    // Nothing of the page was selected by the drag.
    assert.equal(await page.evaluate(() => String(getSelection())), "");
    // Team's list is as wide.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Team" })
      .click();
    await page.getByRole("main").getByRole("heading", { level: 1 }).nth(1).waitFor();
    assert.deepEqual((await sides(page)).list, [0, 352]);
    await page.close();

    // Opened again, the card is drawn at the kept width from the first: it is never seen at 300.
    page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((session) => {
      localStorage.setItem("agentorg.session", session);
      const lefts: number[] = [];
      (window as unknown as { lefts: number[] }).lefts = lefts;
      new MutationObserver(() => {
        const card = document.querySelector(
          'main section[aria-label^="Conversation with"]',
        )?.parentElement;
        const left = card?.getBoundingClientRect().left;
        if (left !== undefined && lefts.at(-1) !== left) lefts.push(left);
      }).observe(document, { subtree: true, childList: true, attributes: true });
    }, SESSION);
    await page.goto(`${gateway.url}/#/chat`);
    await opened(page);
    assert.deepEqual(await sides(page), sidesAt(352));
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { lefts: number[] }).lefts),
      [352],
    );
    // A double click on the handle puts it back where it starts, and that is kept.
    await page.mouse.dblclick(352, 300);
    assert.deepEqual(await sides(page), sidesAt(300));
    await until(() => gateway.notes.get(WIDTH), 300);
    await page.close();
  }),
);

test(
  "the handle takes the keyboard after the list: the arrows move it 16 at a time, Home and End take it to its least and its most, and each is kept; in a window with less room its most is two fifths of the window, and a width chosen in a wider one is held to that until there is room again",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440);
    await opened(page);
    // It comes after the list's rows and before what is in the card.
    await rows(chatsOf(page)).last().focus();
    for (let tabs = 0; tabs < 4; tabs++) {
      await page.keyboard.press("Tab");
      if (await handle(page).evaluate((part) => part === document.activeElement)) break;
    }
    assert.ok(
      await handle(page).evaluate((part) => part === document.activeElement),
      "Tab comes to the handle from the list's last row and its buttons",
    );
    assert.equal(await lineShown(page), true, "the line shows while the keyboard is on it");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await sides(page), sidesAt(316));
    await until(() => gateway.notes.get(WIDTH), 316);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    // A step past its least ends at it.
    assert.deepEqual(await sides(page), sidesAt(288));
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await sides(page), sidesAt(288));
    await page.keyboard.press("End");
    assert.deepEqual(await sides(page), sidesAt(480));
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await sides(page), sidesAt(480));
    await until(() => gateway.notes.get(WIDTH), 480);
    await page.keyboard.press("Home");
    assert.deepEqual(await sides(page), sidesAt(288));
    await page.keyboard.press("End");
    await until(() => gateway.notes.get(WIDTH), 480);
    // Another key is not its own.
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await sides(page), sidesAt(480));
    // A window of 1000 has room for 400 of it; what was chosen is kept, and is back with the room.
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.locator('[role="separator"][aria-valuemax="400"]').waitFor();
    assert.deepEqual(await sides(page), sidesAt(400, 1000, 400));
    assert.equal(gateway.notes.get(WIDTH), 480);
    // The narrowest window with the two side by side has room for 358, and the card 532.
    await page.setViewportSize({ width: 896, height: 900 });
    await page.locator('[role="separator"][aria-valuemax="358"]').waitFor();
    assert.deepEqual(await sides(page), sidesAt(358, 896, 358));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[role="separator"][aria-valuemax="480"]').waitFor();
    assert.deepEqual(await sides(page), sidesAt(480));
    await page.close();
  }),
);

test(
  "at its least the side holds what it held: three pinned tiles in a row, a row's name whole beside its time and clear of its buttons, the strip's two buttons and the row of places clear of each other, and the plan's notice no wider than it",
  withGateway(async (gateway) => {
    gateway.converse("a-reviewer", [said("r", "The first of them.", "2026-03-05T22:46:00Z")]);
    gateway.converse("a-research", [said("s", "The second.", "2026-03-05T22:40:00Z")]);
    gateway.converse("a-triage", [said("t", "The third.", "2026-03-05T22:30:00Z")]);
    gateway.converse("a-weekly", [said("w", "Said last year.", "2025-12-31T12:00:00Z")]);
    gateway.notes.set(PINS, ["a-reviewer", "a-research", "a-triage"]);
    gateway.notes.set(WIDTH, 288);
    const page = await open(gateway, 1440);
    await opened(page);
    const list = chatsOf(page);
    await one(list, "Weekly report").waitFor();
    assert.deepEqual(await sides(page), sidesAt(288));
    // The tiles: three of 88 in one row, 8 from the list's sides and 4 apart.
    assert.deepEqual(
      await tiles(list).evaluateAll((all) =>
        all.map((tile) => {
          const box = tile.getBoundingClientRect();
          return [box.x, box.y, box.width];
        }),
      ),
      [
        [8, 92, 88],
        [100, 92, 88],
        [192, 92, 88],
      ],
    );
    // The row: its name is whole, clear of its time, which is inside the row; pointed at, its two
    // buttons are inside it too, clear of the name.
    const row = one(list, "Weekly report");
    await row.hover();
    assert.deepEqual(
      await row.evaluate(async (row) => {
        const box = row.getBoundingClientRect();
        const name = row.querySelector("span.truncate") as HTMLElement;
        const time = (row.querySelector("time") as Element).getBoundingClientRect();
        const buttons = [...(row.parentElement as Element).querySelectorAll("span > button")];
        await Promise.all(
          buttons.flatMap((button) =>
            (button.parentElement as Element).getAnimations().map((moving) => moving.finished),
          ),
        );
        return {
          row: [box.x, box.width],
          whole: name.scrollWidth <= name.clientWidth,
          clear: name.getBoundingClientRect().right <= time.left,
          inside: time.right <= box.right - 10,
          buttons: buttons.map((button) => {
            const at = button.getBoundingClientRect();
            return at.left >= name.getBoundingClientRect().right && at.right <= box.right - 10;
          }),
        };
      }),
      { row: [8, 272], whole: true, clear: true, inside: true, buttons: [true, true] },
    );
    // The frame's own buttons: the strip's two at its ends, the places from the row's start and
    // Settings at its end, none over another; and the notice's close, inside the side.
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-side] button, nav[aria-label="Main"] button')].map(
        (button) => {
          const box = button.getBoundingClientRect();
          return [button.getAttribute("aria-label"), box.x, box.width];
        },
      ),
    );
    assert.deepEqual(boxes, [
      ["Hide list", 10, 32],
      ["Search", 246, 32],
      ["Chat", 8, 44],
      ["Team", 56, 44],
      ["Settings", 236, 44],
      ["Dismiss", 246, 24],
    ]);
    const notice = await page.getByRole("status").filter({ hasText: "ChatGPT plan" }).boundingBox();
    assert.deepEqual([notice?.x, notice?.width], [12, 264]);
    await page.close();
  }),
);

test(
  "there is no handle where the list and the card are not side by side: in a narrower window and on a phone, which are laid out as they were whatever was chosen, and while the list is put away, when the side that comes back over the card is as wide as was chosen",
  withGateway(async (gateway) => {
    gateway.notes.set(WIDTH, 400);
    for (const [width, hash] of [
      [800, "#/chat"],
      [800, "#/chat/a-reviewer"],
      [390, "#/chat"],
    ] as const) {
      const page = await open(gateway, width, hash);
      await page.locator("main section").first().waitFor();
      assert.equal(await handle(page).count(), 0, `${width} ${hash}`);
      // The list has the page there, and the frame's rows are where they start, whatever was chosen.
      const seen = await sides(page);
      if (hash === "#/chat") assert.deepEqual(seen.list, [0, width], `${width}: the list`);
      assert.deepEqual(seen.rows, [0, width < 640 ? width : 300], `${width} ${hash}: the rows`);
      await page.close();
    }
    const page = await open(gateway, 1440);
    await opened(page);
    assert.deepEqual(await sides(page), sidesAt(400));
    await page.getByRole("button", { name: "Hide list" }).click();
    // Put away under the pointer, it is still there, over the card, as wide as it was.
    await page.locator("[data-shell][data-collapsed][data-peek]").waitFor();
    assert.equal(await handle(page).count(), 0);
    const seen = await sides(page);
    assert.deepEqual(
      [seen.list, seen.rows, seen.card],
      [
        [0, 400],
        [0, 400],
        [6, 1428],
      ],
    );
    // It goes when the pointer is past it: past where it ends now, not where it starts.
    await page.mouse.move(405, 400, { steps: 3 });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-shell][data-peek]").count(), 1);
    await page.mouse.move(420, 400, { steps: 3 });
    await page.locator("[data-shell][data-collapsed]:not([data-peek])").waitFor();
    await page.close();
  }),
);
