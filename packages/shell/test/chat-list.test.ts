// The list of your conversations in a real browser, over the stand-in gateway: a row says when its
// last message was said; a conversation is pinned and unpinned from its menu, by a right-click, the
// keyboard or a long press; the pinned ones are tiles above the rest, on the Chat page and in the
// floating chat, and are kept in the app's store.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser, withGateway } from "./build-kit.ts";
import {
  chatsOf,
  choose,
  floating,
  one,
  open,
  PINS,
  rowNames,
  rows,
  said,
  tileNames,
  tiles,
  until,
} from "./chat-list-kit.ts";
import { noted } from "./design/samples.ts";

withBrowser();

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
    // Held still on the tile, a touch opens the tile's menu as before.
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
    await one(list, "Reviewer").tap();
    await page.getByRole("region", { name: "Conversation with Reviewer" }).waitFor();
    // Back on the list, a touch that moves across the tile drags nothing.
    await page.goto(`${gateway.url}/#/chat`);
    await until(() => tileNames(list), ["Reviewer"]);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: on });
    for (const down of [20, 40, 60])
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: on.map(({ x, y }) => ({ x, y: y + down })),
      });
    assert.equal(await page.locator("[data-dragged]").count(), 0);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await tileNames(list), ["Reviewer"]);
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
