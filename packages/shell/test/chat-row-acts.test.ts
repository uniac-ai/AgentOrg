// A row's buttons in the list of your conversations, in a real browser over the stand-in gateway:
// one that pins and "⋯", shown over the row's time while the row is pointed at or has the keyboard
// and not otherwise; the pin button pins; "⋯" opens the menu a right-click opens; and a press on
// either is its own, neither a drag nor the row's.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, withBrowser, withGateway } from "./build-kit.ts";
import { chatsOf, one, open, PINS, rowNames, said, tileNames, until } from "./chat-list-kit.ts";

withBrowser();
// A test that fails leaves no page open to slow the ones after it.
test.afterEach(() =>
  Promise.all(
    browser()
      .contexts()
      .map((context) => context.close()),
  ),
);

/**
 * A conversation's row with its buttons, by its agent's id. It is found by what it is in the page
 * and not by a role: while a menu is open, nothing outside the menu has one.
 */
const item = (list: Locator, agent: string) =>
  list.page().locator(`main ul[aria-label="Chats"] > li[data-chat="${agent}"]`);
const pinOf = (list: Locator, name: string) => list.getByRole("button", { name: `Pin ${name}` });
const moreOf = (list: Locator, name: string) =>
  list.getByRole("button", { name: `More for ${name}` });
/**
 * A row as it is drawn: how far its buttons and its time are shown, how far the buttons' end is
 * from the row's, the row's height, and its name's width.
 */
const drawn = (list: Locator, agent: string) =>
  item(list, agent).evaluate((row) => {
    const buttons = row.querySelector(":scope > span") as Element;
    return {
      buttons: getComputedStyle(buttons).opacity,
      time: getComputedStyle(row.querySelector("time") as Element).opacity,
      fromEnd: Math.round(
        row.getBoundingClientRect().right - buttons.getBoundingClientRect().right,
      ),
      height: row.getBoundingClientRect().height,
      name: (row.querySelector("span.truncate") as Element).getBoundingClientRect().width,
    };
  });
/** The pointer, off every row. */
const away = (page: Page) => page.mouse.move(900, 500);
const focused = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.closest("li[data-chat]")?.getAttribute("data-chat"),
  );

/**
 * Each agent's conversation, last said in at a set time, and a page that opens on a set day at
 * half past eleven at night: what a row's time reads, and so how wide it is, is the same whenever
 * the test runs.
 */
const DAY = "2026-11-23";
async function at(
  gateway: Parameters<typeof open>[0],
  locale: string,
  times: Record<string, string>,
) {
  for (const [agent, time] of Object.entries(times))
    gateway.converse(agent, [said(agent, "Said then.", time)]);
  const page = await open(gateway, "#/chat/a-research", { locale, now: `${DAY}T23:30:00Z` });
  await until(() => rowNames(chatsOf(page)).then((names) => names.length), 4);
  await away(page);
  return page;
}

test(
  "a row's buttons are shown while it is pointed at, at its end over its time, which goes, whatever the time reads: an hour of one figure or of two, a date, and a date wider than the two of them; the row is as tall and its name as wide with them as without; they are clear of the name and of the mark for something new; pointed away from, they go",
  withGateway(async (gateway) => {
    for (const [locale, times, reads] of [
      [
        "en-US",
        {
          "a-reviewer": `${DAY}T21:52:00Z`,
          "a-triage": `${DAY}T22:07:00Z`,
          "a-weekly": `${DAY}T12:07:00Z`,
          "a-research": "2026-11-22T10:00:00Z",
        },
        ["9:52 PM", "10:07 PM", "12:07 PM", "11/22/26"],
      ],
      // A day and a year written out are wider than the buttons in any font; an hour of the
      // twenty-four is narrower.
      [
        "en-GB",
        {
          "a-reviewer": `${DAY}T21:52:00Z`,
          "a-triage": "2025-12-31T12:00:00Z",
          "a-weekly": "2025-12-30T12:00:00Z",
          "a-research": "2025-12-29T12:00:00Z",
        },
        ["21:52", "31/12/2025", "30/12/2025", "29/12/2025"],
      ],
    ] as const) {
      const page = await at(gateway, locale, times);
      const list = chatsOf(page);
      const agents = Object.keys(times);
      assert.deepEqual(
        await Promise.all(
          agents.map((agent) =>
            item(list, agent)
              .locator("time")
              .evaluate((time) => time.textContent?.replace(/\s/g, " ")),
          ),
        ),
        reads,
        locale,
      );
      // They come and go in a tenth of a second, and so does the time.
      assert.deepEqual(
        await item(list, "a-reviewer").evaluate((row) =>
          [row.querySelector(":scope > span"), row.querySelector("time")].map(
            (part) => getComputedStyle(part as Element).transitionDuration,
          ),
        ),
        ["0.1s", "0.1s"],
      );
      // Every row, the one open beside the list among them.
      for (const agent of agents) {
        const rest = await drawn(list, agent);
        assert.deepEqual(
          { ...rest, name: rest.name > 100 },
          { buttons: "0", time: "1", fromEnd: 4, height: 64, name: true },
          `${locale} ${agent}`,
        );
        await item(list, agent).hover();
        await until(() => drawn(list, agent), { ...rest, buttons: "1", time: "0", fromEnd: 10 });
        // Another row shows none meanwhile.
        const other = agents.find((one) => one !== agent) as string;
        const { buttons, time } = await drawn(list, other);
        assert.deepEqual({ buttons, time }, { buttons: "0", time: "1" });
        const placed = await item(list, agent).evaluate((row) => {
          const box = (part: Element | null) => (part as Element).getBoundingClientRect();
          const buttons = box(row.querySelector(":scope > span"));
          const time = box(row.querySelector("time"));
          return {
            two: [...row.querySelectorAll(":scope > span > button")]
              .map(box)
              .map((one) => [one.width, one.height]),
            inside: buttons.top >= box(row).top && buttons.bottom <= box(row).bottom,
            ofName: box(row.querySelector("span.truncate")).right <= buttons.left,
            ofWords: box(row.querySelectorAll("span.truncate")[1] ?? null).right <= buttons.left,
            ofNew: buttons.bottom <= box(row.querySelector("time + span")).top,
            // They end where the time ends, over its line: the time, gone, is all that is under
            // them, and a time wider than they are is gone beside them too.
            atTime:
              Math.abs(buttons.right - time.right) < 1 &&
              buttons.top <= time.top &&
              buttons.bottom >= time.bottom,
            timeWider: time.width > buttons.width,
          };
        });
        const { timeWider, ...clear } = placed;
        assert.deepEqual(
          clear,
          {
            two: [
              [24, 24],
              [24, 24],
            ],
            inside: true,
            ofName: true,
            ofWords: true,
            ofNew: true,
            atTime: true,
          },
          `${locale} ${agent}`,
        );
        // How wide a time of the twelve hours is depends on the font; these don't.
        if (locale === "en-GB") assert.equal(timeWider, agent !== "a-reviewer", agent);
        await away(page);
        await until(() => drawn(list, agent), rest);
      }
      await page.close();
    }
  }),
);

test(
  'the keyboard reaches a row\'s buttons after the row, the pin button then "⋯", and they are shown while it is on the row or on either; a person who asks for less motion gets none',
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    await away(page);
    await one(list, "Research").focus();
    for (const [on, research, reviewer] of [
      ["Pin Research", "1", "0"],
      ["More for Research", "1", "0"],
      ["a-reviewer", "0", "1"],
      ["Pin Reviewer", "0", "1"],
    ] as const) {
      await page.keyboard.press("Tab");
      assert.equal(await focused(page), on);
      await until(
        async () => [
          (await drawn(list, "a-research")).buttons,
          (await drawn(list, "a-reviewer")).buttons,
        ],
        [research, reviewer],
      );
    }
    // Back on the row before: its buttons, the last of them first.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(page), "More for Research");
    await until(async () => (await drawn(list, "a-research")).time, "0");
    // Less motion: nothing slides, and nothing fades.
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal((await drawn(list, "a-reviewer")).fromEnd, 10);
    assert.deepEqual(
      await item(list, "a-reviewer").evaluate((row) =>
        [row.querySelector(":scope > span"), row.querySelector("time")].map(
          (part) => getComputedStyle(part as Element).transitionProperty,
        ),
      ),
      ["none", "none"],
    );
    await page.close();
  }),
);

test(
  "the pin button pins its conversation, which joins the tiles, and opens nothing; from the keyboard Space on it pins, and picks nothing up",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    await item(list, "a-reviewer").hover();
    await pinOf(list, "Reviewer").click();
    await until(() => tileNames(list), ["Reviewer"]);
    assert.deepEqual(await rowNames(list), ["Research"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer"]);
    assert.match(page.url(), /#\/chat\/a-research$/);
    // The keyboard goes with it to its tile, as when its menu pins it; a tile has no buttons.
    await until(() => focused(page), "a-reviewer");
    assert.equal(await list.locator('li[data-chat="a-reviewer"] button').count(), 1);
    await away(page);
    await one(list, "Research").focus();
    await page.keyboard.press("Tab");
    assert.equal(await focused(page), "Pin Research");
    await page.keyboard.press("Space");
    await until(() => tileNames(list), ["Reviewer", "Research"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer", "a-research"]);
    assert.equal(await page.locator("[data-dragged]").count(), 0);
    await page.close();
  }),
);

test(
  '"⋯" opens the menu a right-click on the row opens, item for item; the row\'s buttons stay while it is open; its Pin pins',
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    const menu = page.getByRole("menu");
    const items = () => menu.getByRole("menuitem").allInnerTexts();
    await one(list, "Reviewer").click({ button: "right" });
    await menu.waitFor();
    const byRightClick = await items();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    const expanded = () =>
      item(list, "a-reviewer").locator("button").last().getAttribute("aria-expanded");
    assert.equal(await expanded(), "false");
    await item(list, "a-reviewer").hover();
    await moreOf(list, "Reviewer").click();
    await menu.waitFor();
    assert.deepEqual(await items(), byRightClick);
    assert.deepEqual(byRightClick, ["Pin", "Delete chat"]);
    assert.equal(await expanded(), "true");
    // The pointer is in the menu or anywhere: the row still shows what the menu is of.
    await away(page);
    await page.waitForTimeout(250);
    assert.deepEqual(
      await drawn(list, "a-reviewer").then(({ buttons, time }) => ({ buttons, time })),
      { buttons: "1", time: "0" },
    );
    // Opening it opened nothing else.
    assert.match(page.url(), /#\/chat\/a-research$/);
    await menu.getByRole("menuitem", { name: "Pin" }).click();
    await until(() => tileNames(list), ["Reviewer"]);
    await until(() => gateway.notes.get(PINS), ["a-reviewer"]);
    await menu.waitFor({ state: "detached" });
    // From the keyboard, Enter on "⋯" opens it with the keyboard on its first item.
    await one(list, "Research").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await focused(page), "More for Research");
    await page.keyboard.press("Enter");
    await until(() => page.evaluate(() => document.activeElement?.textContent), "Pin");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await until(() => focused(page), "More for Research");
    await page.close();
  }),
);

test(
  "a press on a row's button that moves drags nothing and opens nothing, and the row is still dragged by the rest of it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    const place = list.getByRole("list", { name: "Pinned" });
    for (const button of [pinOf(list, "Reviewer"), moreOf(list, "Reviewer")]) {
      await item(list, "a-reviewer").hover();
      await until(async () => (await drawn(list, "a-reviewer")).buttons, "1");
      const box = await button.boundingBox();
      assert.ok(box);
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 8, y + 8, { steps: 4 });
      await page.mouse.move(x - 60, y - 120, { steps: 8 });
      // A row picked up draws the place to drop it, and its face follows the pointer.
      assert.equal(await place.count(), 0);
      assert.equal(await page.locator("[data-dragged]").count(), 0);
      await page.mouse.up();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    assert.equal(gateway.notes.get(PINS), undefined);
    assert.match(page.url(), /#\/chat\/a-research$/);
    // The same press on the row's name picks the row up.
    const row = await item(list, "a-reviewer").boundingBox();
    assert.ok(row);
    await page.mouse.move(row.x + 120, row.y + 32);
    await page.mouse.down();
    await page.mouse.move(row.x + 128, row.y + 40, { steps: 4 });
    await place.waitFor();
    await page.mouse.up();
    await place.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "a touch shows no buttons: on the time's place it opens the conversation, as anywhere on the row, on a phone and on a wider screen",
  withGateway(async (gateway) => {
    for (const phone of [true, false]) {
      const page = await open(gateway, "#/chat", { width: phone ? 390 : 1440, touch: true });
      const list = chatsOf(page);
      await one(list, "Reviewer").waitFor();
      assert.equal((await drawn(list, "a-reviewer")).buttons, "0");
      const time = await one(list, "Reviewer").locator("time").boundingBox();
      assert.ok(time);
      await page.touchscreen.tap(time.x + time.width / 2, time.y + time.height / 2);
      await page.getByRole("region", { name: "Conversation with Reviewer" }).waitFor();
      assert.equal(gateway.notes.get(PINS), undefined);
      await page.close();
    }
  }),
);
