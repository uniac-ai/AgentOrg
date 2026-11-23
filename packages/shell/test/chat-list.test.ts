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
    // A touch drags nothing: held still on the tile, it opens the tile's menu as before.
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
    assert.equal(
      await list
        .locator('li[data-chat="a-reviewer"]')
        .evaluate((e) => (e as HTMLElement).draggable),
      false,
    );
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

/** A conversation of a list, row or tile, by its agent's id: what is dragged, and marked. */
const item = (list: Locator, agent: string) => list.locator(`li[data-chat="${agent}"]`);
/**
 * Drags with the mouse from the middle of one thing to a point of another, given as fractions of
 * its box; `held` runs while it is held there, before it is dropped.
 */
async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  [x, y]: [number, number],
  held?: () => Promise<void>,
) {
  const [a, b] = [await from.boundingBox(), await to.boundingBox()];
  assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + b.width * x, b.y + b.height * y, { steps: 8 });
  // Twice more where it stops: a browser says a drag is over what it has entered for as long as
  // it is held there, and the test's mouse only when it is moved again.
  for (let again = 0; again < 2; again++)
    await page.mouse.move(b.x + b.width * x, b.y + b.height * y);
  await held?.();
  await page.mouse.up();
}
/** Three pinned, Weekly report, Reviewer and Triage, and Research's row under them. */
function threePinned(gateway: Gateway) {
  gateway.converse("a-weekly", [said("w", "Signups were up 4%.", "2026-01-02T10:00:00Z")]);
  gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-03T10:00:00Z")]);
  gateway.notes.set(PINS, ["a-weekly", "a-reviewer", "a-triage"]);
}

test(
  "a tile is dragged to another place among the tiles: a line marks where it would go, it is put there, and the order is kept; dragging opens nothing",
  withGateway(async (gateway) => {
    threePinned(gateway);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    // Onto the first tile's left half: before it. While held there, that tile has the line at its
    // side and the dragged one is faint.
    await drag(page, item(list, "a-triage"), item(list, "a-weekly"), [0.25, 0.5], async () => {
      await until(
        () =>
          list.evaluate((root) =>
            ["a-weekly", "a-reviewer", "a-triage"].map((agent) => {
              const style = getComputedStyle(
                root.querySelector(`li[data-chat="${agent}"]`) as Element,
              );
              return [style.boxShadow !== "none", style.opacity];
            }),
          ),
        [
          [true, "1"],
          [false, "1"],
          [false, "0.4"],
        ],
      );
    });
    await until(() => tileNames(list), ["Triage", "Weekly report", "Reviewer"]);
    await until(() => gateway.notes.get(PINS), ["a-triage", "a-weekly", "a-reviewer"]);
    // Onto the last tile's right half: after it, the last place.
    await drag(page, item(list, "a-triage"), item(list, "a-reviewer"), [0.75, 0.5]);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-weekly", "a-reviewer", "a-triage"]);
    // Nothing is marked once it is dropped, and the open conversation is the one it was.
    assert.deepEqual(
      await list
        .locator("li[data-chat]")
        .evaluateAll((all) =>
          all.map((one) => [getComputedStyle(one).boxShadow, getComputedStyle(one).opacity]),
        ),
      Array.from({ length: 4 }, () => ["none", "1"]),
    );
    assert.match(page.url(), /#\/chat\/a-research$/);
    // A reload draws them as they were left.
    await page.reload();
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    await page.close();
  }),
);

test(
  "a row dragged into the tiles is pinned where it is dropped, and a tile dragged down to the rows is unpinned; a row dropped among the rows stays, and with nothing pinned a row isn't dragged",
  withGateway(async (gateway) => {
    gateway.converse("a-weekly", [said("w", "Signups were up 4%.", "2026-01-02T10:00:00Z")]);
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-03T10:00:00Z")]);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer", "Triage", "Weekly report"]);
    // Nothing is pinned: there are no tiles to drag a row into, and it stays where it is.
    await drag(page, item(list, "a-triage"), item(list, "a-research"), [0.5, 0.5], async () => {
      assert.equal(
        await item(list, "a-triage").evaluate((row) => getComputedStyle(row).opacity),
        "1",
      );
    });
    assert.deepEqual(await rowNames(list), ["Research", "Reviewer", "Triage", "Weekly report"]);
    assert.equal(gateway.notes.get(PINS), undefined);

    await choose(page, one(list, "Weekly report"), "Pin");
    await choose(page, one(list, "Reviewer"), "Pin");
    await until(() => tileNames(list), ["Weekly report", "Reviewer"]);
    // A row onto the second tile's left half: pinned between the two.
    await drag(page, item(list, "a-research"), item(list, "a-reviewer"), [0.25, 0.5]);
    await until(() => tileNames(list), ["Weekly report", "Research", "Reviewer"]);
    assert.deepEqual(await rowNames(list), ["Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-weekly", "a-research", "a-reviewer"]);
    // A tile down onto a row: unpinned, a row again, in its place by when it was last said in.
    await drag(page, item(list, "a-weekly"), item(list, "a-triage"), [0.5, 0.5]);
    await until(() => tileNames(list), ["Research", "Reviewer"]);
    await until(() => rowNames(list), ["Triage", "Weekly report"]);
    await until(() => gateway.notes.get(PINS), ["a-research", "a-reviewer"]);
    // A row dropped on another row goes nowhere.
    await drag(page, item(list, "a-weekly"), item(list, "a-triage"), [0.5, 0.5]);
    await page.waitForTimeout(300);
    assert.deepEqual(await rowNames(list), ["Triage", "Weekly report"]);
    assert.deepEqual(gateway.notes.get(PINS), ["a-research", "a-reviewer"]);
    await page.close();
  }),
);

test(
  "from the keyboard, a tile's menu moves it earlier or later among the tiles, and the keyboard stays on it; the first has no Move earlier and the last no Move later",
  withGateway(async (gateway) => {
    threePinned(gateway);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Weekly report", "Reviewer", "Triage"]);
    /** Opens a tile's menu from the keyboard and checks its items; presses the one named, or closes it. */
    const press = async (name: string, items: string[], pick?: string) => {
      await one(list, name).focus();
      await page.keyboard.press("Shift+F10");
      const menu = page.getByRole("menu");
      await menu.waitFor();
      assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), items, name);
      // Opened from the keyboard, the menu has the keyboard on its first item; each arrow moves it
      // to the next.
      for (const [n, item] of items.entries()) {
        await until(() => page.evaluate(() => document.activeElement?.textContent), item);
        if (!pick || item === pick) break;
        assert.ok(n < items.length - 1, `${pick} is in the menu`);
        await page.keyboard.press("ArrowDown");
      }
      await page.keyboard.press(pick ? "Enter" : "Escape");
      await menu.waitFor({ state: "detached" });
    };
    const focused = () =>
      page.evaluate(() =>
        document.activeElement?.closest("li[data-chat]")?.getAttribute("data-chat"),
      );
    await press("Weekly report", ["Unpin", "Move later"]);
    await press("Triage", ["Unpin", "Move earlier"]);
    await press("Reviewer", ["Unpin", "Move earlier", "Move later"], "Move earlier");
    await until(() => tileNames(list), ["Reviewer", "Weekly report", "Triage"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer", "a-weekly", "a-triage"]);
    await until(focused, "a-reviewer");
    await press("Reviewer", ["Unpin", "Move later"], "Move later");
    await press("Reviewer", ["Unpin", "Move earlier", "Move later"], "Move later");
    await until(() => tileNames(list), ["Weekly report", "Triage", "Reviewer"]);
    await until(() => gateway.notes.get(PINS), ["a-weekly", "a-triage", "a-reviewer"]);
    await until(focused, "a-reviewer");
    await page.close();
  }),
);
