// The list of your conversations in a real browser, over the stand-in gateway: a row says when its
// last message was said; a conversation is pinned and unpinned from its menu, by a right-click, the
// keyboard or a long press; the pinned ones are tiles above the rest, on the Chat page and in the
// floating chat, and are kept in the app's store; a mouse drags a tile to another place, a row into
// the tiles and a tile out of them, and a tile's menu moves it earlier or later.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { noted } from "./design/samples.ts";

withBrowser();

/** Where the pins are kept in the app's store. */
const PINS = "ui/pinned-conversations";

async function open(
  gateway: Gateway,
  hash = "#/chat",
  { width = 1440, locale = "en-US", touch = false, now = undefined as string | undefined } = {},
): Promise<Page> {
  const page = await browser().newPage({
    viewport: { width, height: 900 },
    locale,
    timezoneId: "UTC",
    hasTouch: touch,
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  if (now) await page.clock.setFixedTime(new Date(now));
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** The Chat page's list of your conversations. */
const chatsOf = (page: Page) => page.getByRole("main").getByRole("list", { name: "Chats" });
/** The floating chat's. */
const floating = (page: Page) =>
  page.getByRole("complementary", { name: "Chats" }).getByRole("list", { name: "Chats" });
const rows = (list: Locator) => list.locator(":scope > li > button");
const tiles = (list: Locator) => list.getByRole("list", { name: "Pinned" }).getByRole("button");
/** One conversation of a list, row or tile, by its agent's name. */
const one = (list: Locator, name: string) =>
  list.getByRole("button").filter({ has: list.page().getByText(name, { exact: true }) });
/** The agents the rows name, top to bottom: each row's face comes first, then its name. */
const rowNames = async (list: Locator) =>
  (await rows(list).allInnerTexts()).map((text) => text.split("\n").filter(Boolean)[1]);
/** The agents the tiles name, in their order: each tile's face comes first, then its name. */
const tileNames = async (list: Locator) =>
  (await tiles(list).allInnerTexts()).map((text) => text.split("\n").filter(Boolean).at(-1));
const said = (id: string, text: string, at = new Date().toISOString()) => ({
  id,
  role: "assistant" as const,
  text,
  at,
});
/** Waits for what the page or the store will come to, which arrives a call at a time. */
async function until<T>(read: () => Promise<T> | T, expected: T) {
  for (let tries = 0; ; tries++) {
    const now = await read();
    try {
      assert.deepEqual(now, expected);
      return;
    } catch (error) {
      if (tries > 200) throw error;
      await new Promise((done) => setTimeout(done, 40));
    }
  }
}
/** Opens a conversation's menu by a right-click and presses its one item, which must be this. */
async function choose(page: Page, of: Locator, item: "Pin" | "Unpin") {
  await of.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), [item]);
  await menu.getByRole("menuitem", { name: item }).click();
  await menu.waitFor({ state: "detached" });
}

test(
  "a row says when its last message was said: its time if that was today, its date if before, as the person's locale writes them short, whole and on one line",
  withGateway(async (gateway) => {
    gateway.converse("a-reviewer", [said("r", "Said today.", "2026-03-05T22:46:00Z")]);
    gateway.converse("a-triage", [said("t", "Said last night.", "2026-03-04T23:59:00Z")]);
    gateway.converse("a-weekly", [said("w", "Said last year.", "2025-12-31T12:00:00Z")]);
    for (const [locale, times] of [
      ["en-US", ["10:46 PM", "3/4/26", "12/31/25"]],
      ["de-DE", ["22:46", "04.03.26", "31.12.25"]],
    ] as const) {
      const page = await open(gateway, "#/chat", { locale, now: "2026-03-05T23:00:00Z" });
      const list = chatsOf(page);
      await one(list, "Weekly report").waitFor();
      const shown = await Promise.all(
        ["Reviewer", "Triage", "Weekly report"].map((name) =>
          one(list, name)
            .locator("time")
            .evaluate((time) => ({
              // The space before "PM" is a narrow one that doesn't break.
              text: time.textContent?.replace(/\s/g, " "),
              at: time.getAttribute("datetime"),
            })),
        ),
      );
      assert.deepEqual(
        shown,
        [
          { text: times[0], at: "2026-03-05T22:46:00Z" },
          { text: times[1], at: "2026-03-04T23:59:00Z" },
          { text: times[2], at: "2025-12-31T12:00:00Z" },
        ],
        locale,
      );
      // The longest of them has its room: inside the row's padding, on one line, clear of the name.
      const room = await one(list, "Reviewer").evaluate((row) => {
        const box = row.getBoundingClientRect();
        const time = (row.querySelector("time") as Element).getBoundingClientRect();
        const name = (row.querySelector("span.truncate") as Element).getBoundingClientRect();
        return {
          inside: time.right <= box.right - 10,
          oneLine: time.height <= 16,
          clear: name.right <= time.left,
        };
      });
      assert.deepEqual(room, { inside: true, oneLine: true, clear: true }, locale);
      await page.close();
    }
  }),
);

test(
  "a row's menu pins its conversation: it becomes a tile above the rows, which keep their order; it stays pinned after a reload; the tile's menu unpins it",
  withGateway(async (gateway) => {
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-02T10:00:00Z")]);
    const page = await open(gateway);
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer", "Triage"]);
    assert.equal(await tiles(list).count(), 0);
    await choose(page, one(list, "Reviewer"), "Pin");
    await until(() => tileNames(list), ["Reviewer"]);
    assert.deepEqual(await rowNames(list), ["Research", "Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer"]);
    // The tile is under the list's head, above the first row, the face over the name.
    const placed = await list.evaluate((root) => {
      const tile = root.querySelector('ul[aria-label="Pinned"] button') as Element;
      const [face, name] = [...tile.children].map((part) => part.getBoundingClientRect());
      const row = (root.querySelector(":scope > li > button") as Element).getBoundingClientRect();
      return {
        first: root.firstElementChild?.contains(tile),
        aboveRows: tile.getBoundingClientRect().bottom <= row.top,
        faceOverName: !!face && !!name && face.bottom <= name.top,
      };
    });
    assert.deepEqual(placed, { first: true, aboveRows: true, faceOverName: true });

    await page.reload();
    await until(() => tileNames(list), ["Reviewer"]);
    await until(() => rowNames(list), ["Research", "Triage"]);
    await choose(page, one(list, "Reviewer"), "Unpin");
    await until(() => rowNames(list), ["Research", "Reviewer", "Triage"]);
    assert.equal(await list.getByRole("list", { name: "Pinned" }).count(), 0);
    await until(() => gateway.notes.get(PINS), []);
    await page.close();
  }),
);

test(
  "tiles keep the order they were pinned in whatever is said since, three to a line beside a conversation; a tile says it is the one open, has something new, or has a problem; it opens its conversation",
  withGateway(async (gateway) => {
    gateway.converse("a-weekly", [said("w", "Signups were up 4%.", "2026-01-02T10:00:00Z")]);
    gateway.converse(
      "a-triage",
      [{ id: "t", role: "user", text: "Route today's issues.", at: "2026-01-03T10:00:00Z" }],
      { code: "failed", message: "linear is down" },
    );
    gateway.notes.set(PINS, ["a-weekly", "a-reviewer", "a-triage"]);
    const page = await open(gateway, "#/chat/a-reviewer");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    assert.deepEqual(await rowNames(list), ["Research"]);
    const marks = () =>
      Promise.all(
        ["Weekly report", "Reviewer", "Triage"].map(async (name) => ({
          current: await one(list, name).getAttribute("aria-current"),
          marks: await one(list, name)
            .getByRole("img")
            .evaluateAll((all) => all.map((mark) => mark.getAttribute("aria-label"))),
        })),
      );
    assert.deepEqual(await marks(), [
      { current: null, marks: [] },
      { current: "true", marks: [] },
      { current: null, marks: ["linear is down"] },
    ]);
    // Weekly report says something new: its tile says so, and stays where it was pinned.
    await noted(gateway);
    gateway.addMessage("a-weekly", said("w2", "And up 6% this week."));
    await one(list, "Weekly report").getByRole("img", { name: "New" }).waitFor();
    assert.deepEqual(await tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    const boxes = await tiles(list).evaluateAll((all) =>
      all.map((tile) => tile.getBoundingClientRect()).map(({ top, left }) => ({ top, left })),
    );
    assert.equal(new Set(boxes.map((box) => box.top)).size, 1, "on one line");
    assert.deepEqual(
      boxes.map((box) => box.left),
      boxes.map((box) => box.left).sort((a, b) => a - b),
      "left to right",
    );
    await one(list, "Weekly report").click();
    await page.waitForURL(/#\/chat\/a-weekly$/);
    await until(marks, [
      { current: "true", marks: [] },
      { current: null, marks: [] },
      { current: null, marks: ["linear is down"] },
    ]);
    await page.close();
  }),
);

test(
  "from the keyboard, Shift+F10 on a row opens its menu; pinned, the keyboard is on its tile, and Shift+F10 there unpins it back to its row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const list = chatsOf(page);
    await one(list, "Reviewer").waitFor();
    for (const [item, isTile] of [
      ["Pin", true],
      ["Unpin", false],
    ] as const) {
      await one(list, "Reviewer").focus();
      await page.keyboard.press("Shift+F10");
      // Opened from the keyboard, the menu has the keyboard on its first item.
      await until(() => page.evaluate(() => document.activeElement?.textContent), item);
      await page.keyboard.press("Enter");
      await until(() => tiles(list).count(), isTile ? 1 : 0);
      await until(
        () =>
          page.evaluate(() => [
            document.activeElement?.textContent?.includes("Reviewer"),
            !!document.activeElement?.closest('ul[aria-label="Pinned"]'),
          ]),
        [true, isTile],
      );
    }
    await page.close();
  }),
);

test(
  "on a phone, a long press on a row opens its menu and not its conversation; pinned, its tile opens the conversation",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat", { width: 390, touch: true });
    const list = chatsOf(page);
    const row = one(list, "Reviewer");
    await row.waitFor();
    const box = await row.boundingBox();
    assert.ok(box);
    const touch = await page.context().newCDPSession(page);
    const at = [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }];
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at });
    await page.getByRole("menuitem", { name: "Pin" }).waitFor();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await page.getByRole("region", { name: /^Conversation with / }).count(), 0);
    await page.getByRole("menuitem", { name: "Pin" }).tap();
    await until(() => tileNames(list), ["Reviewer"]);
    await page.getByRole("menu").waitFor({ state: "detached" });
    // Held still on the tile, a touch opens the tile's menu as before; moved, it drags nothing.
    const tile = await one(list, "Reviewer").boundingBox();
    assert.ok(tile);
    const on = [
      { x: Math.round(tile.x + tile.width / 2), y: Math.round(tile.y + tile.height / 2) },
    ];
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: on });
    await page.getByRole("menuitem", { name: "Unpin" }).waitFor();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: on });
    for (const down of [20, 40, 60])
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: on.map(({ x, y }) => ({ x, y: y + down })),
      });
    assert.equal(await page.locator("[data-dragged]").count(), 0);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await tileNames(list), ["Reviewer"]);
    // A tap just after a moving touch only stops the scroll it began: a moment, then.
    await page.waitForTimeout(500);
    await one(list, "Reviewer").tap();
    await page.getByRole("region", { name: "Conversation with Reviewer" }).waitFor();
    await page.close();
  }),
);

test(
  "the floating chat lists the pinned conversations as tiles too, and pins from its rows; a tile opens its conversation there",
  withGateway(async (gateway) => {
    gateway.notes.set(PINS, ["a-reviewer"]);
    const page = await open(gateway, "#/team");
    await page.getByRole("button", { name: /^Chats/ }).click();
    const list = floating(page);
    await until(() => tileNames(list), ["Reviewer"]);
    assert.deepEqual(await rowNames(list), ["Research"]);
    await choose(page, one(list, "Research"), "Pin");
    await until(() => tileNames(list), ["Reviewer", "Research"]);
    assert.equal(await rows(list).count(), 0);
    await until(() => gateway.notes.get(PINS), ["a-reviewer", "a-research"]);
    await one(list, "Research").click();
    await page
      .getByRole("complementary", { name: "Chats" })
      .getByRole("heading", { name: "Research" })
      .waitFor();
    await page.close();
  }),
);

test(
  "a pin made in one tab is kept when another tab, open since before it, pins another",
  withGateway(async (gateway) => {
    const first = await open(gateway);
    await one(chatsOf(first), "Reviewer").waitFor();
    const second = await open(gateway);
    await choose(second, one(chatsOf(second), "Reviewer"), "Pin");
    await until(() => gateway.notes.get(PINS), ["a-reviewer"]);
    await choose(first, one(chatsOf(first), "Research"), "Pin");
    await until(() => gateway.notes.get(PINS), ["a-reviewer", "a-research"]);
    await until(() => tileNames(chatsOf(first)), ["Reviewer", "Research"]);
    await first.close();
    await second.close();
  }),
);

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
    // A press that doesn't move is still a click: it opens the conversation.
    await one(list, "Triage").click();
    await page.waitForURL(/#\/chat\/a-triage$/);
    // A reload draws them as they were left.
    await page.reload();
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
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
  "from the keyboard, Space picks a tile up, the arrows move it among the tiles, and Space puts it down, the keyboard still on it; Escape puts it back; Enter still opens it; its menu has Unpin alone",
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
    // The menu of a tile with others beside it: Unpin, and nothing else.
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Unpin"]);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    // Enter is the button's own: it opens the conversation.
    await one(list, "Reviewer").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/#\/chat\/a-reviewer$/);
    await page.close();
  }),
);
