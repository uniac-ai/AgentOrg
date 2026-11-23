// Dragging in the list of your conversations, in a real browser over the stand-in gateway: a mouse
// drags a tile to another place among the tiles, a row onto the tiles and a tile off them, the
// agent's face alone following the pointer and the place it would land in kept empty; with nothing
// pinned a place to drop a row is drawn; and the keyboard picks a tile up, moves it and puts it down.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { type Gateway, withBrowser, withGateway } from "./build-kit.ts";
import { chatsOf, one, open, PINS, rowNames, said, tileNames, until } from "./chat-list-kit.ts";

withBrowser();

/** A conversation of a list, row or tile, by its agent's id: what is dragged, and where it is. */
const item = (list: Locator, agent: string) => list.locator(`li[data-chat="${agent}"]`);
/**
 * Drags with the mouse from the middle of one thing to a point of another, given as fractions of
 * its box; `held` runs while it is held there, before it is dropped, and is told where it is held.
 */
async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  [x, y]: [number, number],
  held?: (at: { x: number; y: number }) => Promise<void>,
) {
  const [a, b] = [await from.boundingBox(), await to.boundingBox()];
  assert.ok(a && b);
  const at = { x: b.x + b.width * x, y: b.y + b.height * y };
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(at.x, at.y, { steps: 8 });
  await held?.(at);
  await page.mouse.up();
}
/** Three pinned, Weekly report, Reviewer and Triage, and Research's row under them. */
function threePinned(gateway: Gateway) {
  gateway.converse("a-weekly", [said("w", "Signups were up 4%.", "2026-01-02T10:00:00Z")]);
  gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-03T10:00:00Z")]);
  gateway.notes.set(PINS, ["a-weekly", "a-reviewer", "a-triage"]);
}
/**
 * The tiles as they are drawn, left to right and line by line, each with whether it is the empty
 * place of the one being dragged; and the rows the same, top to bottom.
 */
const drawn = (list: Locator) =>
  list.evaluate((root) => {
    const of = (items: Element[]) =>
      items
        .map((one) => ({
          box: one.getBoundingClientRect(),
          said: `${one.getAttribute("data-chat")}${
            getComputedStyle(one.firstElementChild as Element).opacity === "0" ? " (empty)" : ""
          }`,
        }))
        .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
        .map((one) => one.said);
    return {
      tiles: of([...root.querySelectorAll('ul[aria-label="Pinned"] > li')]),
      rows: of([...root.querySelectorAll(":scope > li[data-chat]")]),
    };
  });
/**
 * What follows the pointer: the letters it shows, its size, how far its middle is from where the
 * pointer is held, and the cursor over it. None when nothing is dragged.
 */
const followed = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const face = document.querySelector("[data-dragged] > *");
    if (!face) return undefined;
    const box = face.getBoundingClientRect();
    return {
      shows: (face.parentElement as HTMLElement).textContent.trim(),
      size: [box.width, box.height],
      off: Math.round(Math.hypot(box.left + box.width / 2 - x, box.top + box.height / 2 - y)),
      cursor: getComputedStyle(document.elementFromPoint(x, y) as Element).cursor,
    };
  }, at);

test(
  "a tile is dragged to another place among the tiles: the agent's face alone follows the pointer, with no cursor of its own; its place is kept empty where it would land and the others make room; dropped, it is there, and the order is kept",
  withGateway(async (gateway) => {
    threePinned(gateway);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    assert.equal(await followed(page, { x: 0, y: 0 }), undefined);
    // Held over the first tile: its place is the first, empty, and the other two have moved along.
    await drag(page, item(list, "a-triage"), item(list, "a-weekly"), [0.5, 0.5], async (at) => {
      await until(() => drawn(list), {
        tiles: ["a-triage (empty)", "a-weekly", "a-reviewer"],
        rows: ["a-research"],
      });
      assert.deepEqual(await followed(page, at), {
        shows: "T",
        size: [48, 48],
        off: 0,
        cursor: "auto",
      });
      // No line marks the place: the empty place is the mark.
      assert.deepEqual(
        await list
          .locator("li[data-chat]")
          .evaluateAll((all) => all.map((one) => getComputedStyle(one).boxShadow)),
        ["none", "none", "none", "none"],
      );
    });
    await until(() => tileNames(list), ["Triage", "Weekly report", "Reviewer"]);
    await until(() => gateway.notes.get(PINS), ["a-triage", "a-weekly", "a-reviewer"]);
    // Dropped: nothing follows the pointer, nothing is empty, and the open conversation is the one
    // it was.
    assert.equal(await followed(page, { x: 0, y: 0 }), undefined);
    assert.deepEqual(await drawn(list), {
      tiles: ["a-triage", "a-weekly", "a-reviewer"],
      rows: ["a-research"],
    });
    assert.match(page.url(), /#\/chat\/a-research$/);
    // Onto the last tile: it takes the last place.
    await drag(page, item(list, "a-triage"), item(list, "a-reviewer"), [0.5, 0.5]);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-weekly", "a-reviewer", "a-triage"]);
    // A reload draws them as they were left, and a press that doesn't move is still a click: it
    // opens the conversation.
    await page.reload();
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    await one(list, "Triage").click();
    await page.waitForURL(/#\/chat\/a-triage$/);
    await page.close();
  }),
);

test(
  "a row dragged onto the tiles is pinned where it is dropped, the same face following the pointer; a tile dragged down off them is unpinned, its row's place kept for it; a row dropped among the rows stays",
  withGateway(async (gateway) => {
    gateway.converse("a-weekly", [said("w", "Signups were up 4%.", "2026-01-02T10:00:00Z")]);
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-03T10:00:00Z")]);
    gateway.notes.set(PINS, ["a-weekly", "a-reviewer"]);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer"]);
    await until(() => rowNames(list), ["Research", "Triage"]);
    // A row held over the second tile: its place is there, empty, and it is no longer among the rows.
    await drag(page, item(list, "a-research"), item(list, "a-reviewer"), [0.5, 0.5], async (at) => {
      await until(() => drawn(list), {
        tiles: ["a-weekly", "a-research (empty)", "a-reviewer"],
        rows: ["a-triage"],
      });
      assert.deepEqual(await followed(page, at), {
        shows: "R",
        size: [48, 48],
        off: 0,
        cursor: "auto",
      });
    });
    await until(() => tileNames(list), ["Weekly report", "Research", "Reviewer"]);
    assert.deepEqual(await rowNames(list), ["Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-weekly", "a-research", "a-reviewer"]);
    // A tile held over a row: it is off the tiles, and its row's place, by when it was last said
    // in, is kept empty for it.
    await drag(page, item(list, "a-weekly"), item(list, "a-triage"), [0.5, 0.5], async () => {
      await until(() => drawn(list), {
        tiles: ["a-research", "a-reviewer"],
        rows: ["a-triage", "a-weekly (empty)"],
      });
    });
    await until(() => tileNames(list), ["Research", "Reviewer"]);
    await until(() => rowNames(list), ["Triage", "Weekly report"]);
    await until(() => gateway.notes.get(PINS), ["a-research", "a-reviewer"]);
    // A row dropped on another row goes nowhere.
    await drag(page, item(list, "a-weekly"), item(list, "a-triage"), [0.5, 0.5]);
    await page.waitForTimeout(300);
    assert.deepEqual(await drawn(list), {
      tiles: ["a-research", "a-reviewer"],
      rows: ["a-triage", "a-weekly"],
    });
    assert.deepEqual(gateway.notes.get(PINS), ["a-research", "a-reviewer"]);
    await page.close();
  }),
);

test(
  "with nothing pinned, a place to drop a row is drawn at the top of the list while it is dragged, and gone after; dropped there, the row is the first pin",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    const place = list.getByRole("list", { name: "Pinned" });
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    assert.equal(await place.count(), 0);
    /** Picks Reviewer's row up, which draws the place above the rows. */
    const pickUp = async () => {
      const row = await item(list, "a-reviewer").boundingBox();
      assert.ok(row);
      await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
      await page.mouse.down();
      await page.mouse.move(row.x + row.width / 2 + 8, row.y + row.height / 2 + 8, { steps: 4 });
      await place.waitFor();
    };
    // Picked up and let go where it is, among the rows: the place was there, and nothing is pinned.
    await pickUp();
    assert.deepEqual(await drawn(list), { tiles: [], rows: ["a-research", "a-reviewer (empty)"] });
    const [bottom, first] = await list.evaluate((root) => [
      (root.querySelector('ul[aria-label="Pinned"]') as Element).getBoundingClientRect().bottom,
      (root.querySelector(":scope > li[data-chat]") as Element).getBoundingClientRect().top,
    ]);
    assert.ok(bottom !== undefined && first !== undefined && bottom <= first, "above the rows");
    await page.mouse.up();
    await place.waitFor({ state: "detached" });
    assert.equal(gateway.notes.get(PINS), undefined);
    // Picked up and dropped on the place: it is pinned.
    await pickUp();
    const box = await place.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await until(() => drawn(list), { tiles: ["a-reviewer (empty)"], rows: ["a-research"] });
    await page.mouse.up();
    await until(() => tileNames(list), ["Reviewer"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer"]);
    await page.close();
  }),
);

test(
  "from the keyboard, Space picks a tile up, the arrows move it among the tiles, and Space puts it down, the keyboard still on it; Escape puts it back; Enter still opens it; its menu has Unpin, and no Pin",
  withGateway(async (gateway) => {
    threePinned(gateway);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    const focused = () =>
      page.evaluate(() =>
        document.activeElement?.closest("li[data-chat]")?.getAttribute("data-chat"),
      );
    /** Presses a key once what is drawn is as it should be before it. */
    const press = async (key: string, tiles: string[]) => {
      await until(async () => (await drawn(list)).tiles, tiles);
      // A moment, as a person takes between keys: a tile just picked up is measured first.
      await page.waitForTimeout(100);
      await page.keyboard.press(key);
    };
    await one(list, "Reviewer").focus();
    await press("Space", ["a-weekly", "a-reviewer", "a-triage"]);
    await press("ArrowLeft", ["a-weekly", "a-reviewer (empty)", "a-triage"]);
    await press("Space", ["a-reviewer (empty)", "a-weekly", "a-triage"]);
    await until(() => tileNames(list), ["Reviewer", "Weekly report", "Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer", "a-weekly", "a-triage"]);
    await until(focused, "a-reviewer");
    // Picked up, moved and put back with Escape: nothing changes.
    await press("Space", ["a-reviewer", "a-weekly", "a-triage"]);
    await press("ArrowRight", ["a-reviewer (empty)", "a-weekly", "a-triage"]);
    await press("Escape", ["a-weekly", "a-reviewer (empty)", "a-triage"]);
    await until(() => drawn(list), {
      tiles: ["a-reviewer", "a-weekly", "a-triage"],
      rows: ["a-research"],
    });
    assert.deepEqual(gateway.notes.get(PINS), ["a-reviewer", "a-weekly", "a-triage"]);
    await until(focused, "a-reviewer");
    // The menu of a tile with others beside it: Unpin where a row's has Pin.
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Unpin", "Delete chat"]);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    // Enter is the button's own: it opens the conversation.
    await one(list, "Reviewer").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/#\/chat\/a-reviewer$/);
    await page.close();
  }),
);
