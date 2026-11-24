// The page on the ground, in a real browser over the stand-in gateway: wider than a phone, its list
// at the left on the ground itself, between the frame's strip and its row of places, and what it
// shows in a card beside it, 6 px from the window's top and side and 12 from its foot, with a 1 px
// line, 14 px corners and a slight shadow. Narrower than both side by side, the card is alone
// between the strip and the row. With the list put away the card has the window, and the frame's
// left side comes back over it while it is looked at. On a phone there is no card.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

async function open(gateway: Gateway, width: number, height: number, hash: string): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await page.locator("main section").first().waitFor();
  return page;
}
/** The conversation the page opens beside its list, which it does once it has read the list. */
const opened = (page: Page) =>
  page.locator('main section[aria-label^="Conversation with"]').waitFor();
/** The list, the card, the frame's rows and the ground, read in one frame. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const box = (e: Element | null) =>
      e &&
      Object.values(e.getBoundingClientRect().toJSON())
        .slice(0, 4)
        .map((n) => Math.round((n as number) * 100) / 100);
    const list = document.querySelector('main section[aria-label="Chats"]');
    // The card the conversation is in.
    const card =
      document.querySelector('main section[aria-label^="Conversation with"]')?.parentElement ??
      null;
    const style = card && getComputedStyle(card);
    const bar = document.querySelector('nav[aria-label="Main"]') as Element;
    return {
      list: box(list),
      listFill: list && getComputedStyle(list).backgroundColor,
      card: box(card),
      bar: box(bar),
      barLine: getComputedStyle(bar).borderTopWidth,
      line: style && `${style.borderTopWidth} ${style.borderTopColor}`,
      corners: style?.borderTopLeftRadius,
      // The card's own shadow, the last of those its classes set.
      shadow: style?.boxShadow.split(/,\s*(?=rgba?\()/).at(-1),
      fill: style?.backgroundColor,
      ground: getComputedStyle(document.querySelector("[data-shell]") as Element).backgroundColor,
    };
  });
/** The parts of the frame's left side, where each has come to rest. */
const side = (page: Page) =>
  page.evaluate(async () => {
    const parts = {
      button: document.querySelector("[data-side]:not([role])"),
      rows: document.querySelector('nav[aria-label="Main"]'),
      list: document.querySelector("main [data-list]"),
      notice: document.querySelector('[role="status"][data-side]'),
    };
    await Promise.all(
      Object.values(parts)
        .flatMap((part) => part?.getAnimations() ?? [])
        .map((moving) => moving.finished),
    );
    return Object.fromEntries(
      Object.entries(parts).map(([name, part]) => [
        name,
        part &&
          Object.values(part.getBoundingClientRect().toJSON())
            .slice(0, 4)
            .map((n) => Math.round(n as number)),
      ]),
    );
  });
/** The list is put away, and not looked at; or looked at. */
const away = (page: Page) =>
  page.locator("[data-shell][data-collapsed]:not([data-peek])").waitFor();
const looked = (page: Page) => page.locator("[data-shell][data-collapsed][data-peek]").waitFor();
const light = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

test(
  "wide, the list is on the ground at the left, 300 wide under the frame's rows, and the conversation is a card beside it, 6 from the window's top and side and 12 from its foot, with a thin line, 14 px corners and a slight shadow, in dark and in light",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    assert.deepEqual(await frame(page), {
      list: [0, 0, 300, 900],
      listFill: "rgba(0, 0, 0, 0)",
      card: [300, 6, 1134, 882],
      bar: [0, 0, 300, 900],
      barLine: "0px",
      line: "1px rgba(255, 255, 255, 0.08)",
      corners: "14px",
      shadow: "rgba(0, 0, 0, 0.4) 0px 2px 10px 0px",
      fill: "rgb(25, 25, 25)",
      ground: "rgb(20, 20, 20)",
    });
    // The list's rows start under the strip and its label, and end over the row of places.
    assert.deepEqual(
      await page.locator('main section[aria-label="Chats"]').evaluate((list) => {
        const style = getComputedStyle(list);
        return [style.paddingTop, style.paddingBottom];
      }),
      ["52px", "56px"],
    );
    await light(page);
    const seen = await frame(page);
    assert.deepEqual(
      [seen.line, seen.shadow, seen.fill, seen.ground],
      [
        "1px rgba(0, 0, 0, 0.07)",
        "rgba(0, 0, 0, 0.08) 0px 2px 10px 0px",
        "rgb(250, 250, 250)",
        "rgb(232, 230, 227)",
      ],
    );
    await page.close();
  }),
);

test(
  "narrower than a list beside a conversation, each has the page: the list across it under the frame's rows, the card between the strip and the row of places",
  withGateway(async (gateway) => {
    let page = await open(gateway, 800, 900, "#/chat");
    let seen = await frame(page);
    assert.deepEqual([seen.list, seen.card, seen.bar], [[0, 0, 800, 900], null, [0, 0, 300, 900]]);
    await page.close();
    page = await open(gateway, 800, 900, "#/chat/a-reviewer");
    seen = await frame(page);
    assert.deepEqual(
      [seen.list, seen.card, seen.bar, seen.corners],
      [null, [6, 52, 788, 792], [0, 0, 300, 900], "14px"],
    );
    await page.close();
  }),
);

test(
  "the list is put away by the first button of the strip: it, Search, the row of places and the notice go off the window's left edge with the list, and what is chosen has the window as a card, 6 from each edge, on Chat and on Team; it is so when the page opens again, and the same button brings them all back; narrower than both side by side there is no such button",
  withGateway(async (gateway) => {
    let page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const boxOf = async (name: string) => {
      const box = await button(name).boundingBox();
      return box && [box.x, box.y, box.width, box.height];
    };
    /** Whether the person's store says the list is away, once it says so or not. */
    const kept = async (wanted: boolean) => {
      for (let tries = 0; gateway.notes.get("ui/list-collapsed") !== wanted; tries++) {
        assert.ok(tries < 100, `the store says ${wanted}`);
        await page.waitForTimeout(40);
      }
    };
    // Each of the strip's buttons is 32 square, 10 from the window's corner, its icon where a
    // larger box had it.
    assert.deepEqual(await boxOf("Hide list"), [10, 10, 32, 32]);
    assert.deepEqual(
      await button("Hide list")
        .locator("svg")
        .evaluate((icon) => {
          const box = icon.getBoundingClientRect();
          return [box.width, box.left + box.width / 2, box.top + box.height / 2];
        }),
      [18, 26, 26],
    );
    assert.equal(await button("Hide list").getAttribute("aria-expanded"), "true");
    // Put away by a person, its going is seen: the parts of the left side move off.
    assert.ok(
      (await button("Hide list").evaluate((pressed) => {
        (pressed as HTMLButtonElement).click();
        return new Promise<number>((done) =>
          requestAnimationFrame(() =>
            done(
              document
                .getAnimations()
                .filter((one) => (one as CSSTransition).transitionProperty === "translate").length,
            ),
          ),
        );
      })) >= 4,
      "the button, the rows, the list and the notice move",
    );
    await away(page);
    assert.equal(await button("Show list").getAttribute("aria-expanded"), "false");
    // All of the left side is past the window's left edge, the list still there to come back.
    const gone = await side(page);
    assert.deepEqual(Object.keys(gone), ["button", "rows", "list", "notice"]);
    for (const [part, box] of Object.entries(gone))
      assert.ok(box && (box[0] ?? 0) + (box[2] ?? 0) < 0, `${part} is off the window: ${box}`);
    assert.deepEqual((await frame(page)).card, [6, 6, 1428, 888]);
    // The conversation is as it is beside its list: it has no way back to one.
    assert.equal(await button("All chats").count(), 0);
    // Search still opens from its key.
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
    // It is kept: the page opens again as it was left, and Team's list is away as Chat's is.
    await kept(true);
    await page.goto(`${gateway.url}/#/team`);
    // As the page opens, what was kept is applied at once: nothing moves as the list is put away.
    await page.addInitScript(() => {
      new MutationObserver((_, watching) => {
        if (!document.querySelector("[data-shell][data-collapsed]")) return;
        watching.disconnect();
        (window as unknown as { movedAway: number }).movedAway = document
          .getAnimations()
          .filter((one) => (one as CSSTransition).transitionProperty === "translate").length;
      }).observe(document, { subtree: true, attributeFilter: ["data-collapsed"] });
    });
    await page.reload();
    await away(page);
    assert.equal(
      await page.evaluate(() => (window as unknown as { movedAway: number }).movedAway),
      0,
      "away at once as the page opens",
    );
    // What looks at it afterwards is seen to bring it: the motion is back.
    await page.locator("[data-shell]:not([data-instant])").waitFor();
    // The chosen agent's own heading, after the list's.
    await page.getByRole("main").getByRole("heading", { level: 1 }).nth(1).waitFor();
    const team = page.locator('main section[aria-label="Team"]');
    assert.deepEqual((await side(page)).list, [-324, 0, 300, 900], "Team's list is off the window");
    assert.deepEqual(
      await team.evaluate((list) =>
        Object.values((list.nextElementSibling as Element).getBoundingClientRect().toJSON()).slice(
          0,
          4,
        ),
      ),
      [6, 6, 1428, 888],
    );
    // The first thing Tab comes to is the button, which is back over the page with the rest for
    // as long as the keyboard is on it; pressed, it brings the list back for good.
    await page.keyboard.press("Tab");
    await looked(page);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Show list",
    );
    assert.deepEqual((await side(page)).button, [10, 10, 32, 32]);
    await page.keyboard.press("Enter");
    await page.locator("[data-shell]:not([data-collapsed])").waitFor();
    assert.deepEqual(await team.boundingBox(), { x: 0, y: 0, width: 300, height: 900 });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .waitFor();
    await kept(false);
    // Where a window draws its own buttons over the page's top left, their room is left: the
    // button is the first thing after it, and with the list away the card starts under them.
    await page.evaluate(() => document.documentElement.style.setProperty("--corner", "80px"));
    assert.deepEqual(await boxOf("Hide list"), [90, 10, 32, 32]);
    await button("Hide list").click();
    await page.mouse.move(800, 450);
    await away(page);
    assert.deepEqual(
      await team.evaluate((list) =>
        Object.values((list.nextElementSibling as Element).getBoundingClientRect().toJSON()).slice(
          0,
          4,
        ),
      ),
      [6, 52, 1428, 842],
    );
    await page.close();
    page = await open(gateway, 800, 900, "#/chat");
    assert.equal(await page.getByRole("button", { name: /^(Hide|Show) list$/ }).count(), 0);
    await page.close();
  }),
);

test(
  "with the list away, the pointer at the window's left edge brings the frame's left side back over the card, as it is beside one, with a line and a shadow, the card where it was; it stays while the pointer is on it and goes when the pointer is past it or out of the window, but not out across that edge; the keyboard on one of its parts keeps it too",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    await page.getByRole("button", { name: "Hide list" }).click();
    await page.mouse.move(800, 450);
    await away(page);
    const card = (await frame(page)).card;
    // Once it has gone, near the edge is not at it.
    await side(page);
    await page.mouse.move(40, 300, { steps: 3 });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-shell][data-peek]").count(), 0);
    await page.mouse.move(8, 300, { steps: 3 });
    await looked(page);
    assert.deepEqual(await side(page), {
      button: [10, 10, 32, 32],
      rows: [0, 0, 300, 900],
      list: [0, 0, 300, 900],
      notice: [12, 798, 276, 40],
    });
    assert.deepEqual((await frame(page)).card, card, "the card is where it was, under it");
    // Over the card: the list on the ground with a line and a shadow at its end, and the frame's
    // own parts over the list, where a press reaches them.
    assert.deepEqual(
      await page.evaluate(() => {
        const list = document.querySelector("main [data-list]") as Element;
        const style = getComputedStyle(list);
        const at = (x: number, y: number) =>
          document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ??
          (list.contains(document.elementFromPoint(x, y)) ? "the list" : "the page");
        return {
          ground: style.backgroundColor,
          line: style.borderRightWidth,
          shadow: style.boxShadow !== "none",
          over: [at(26, 26), at(274, 26), at(30, 870), at(270, 870), at(150, 500), at(400, 500)],
        };
      }),
      {
        ground: "rgb(20, 20, 20)",
        line: "1px",
        shadow: true,
        over: ["Show list", "Search", "Chat", "Settings", "the list", "the page"],
      },
    );
    // On it, it stays; a little past it, it goes.
    await page.mouse.move(290, 400, { steps: 4 });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-shell][data-peek]").count(), 1);
    await page.mouse.move(330, 400, { steps: 3 });
    await away(page);
    // Out of the window across its left edge is at the edge; out another way is away.
    const leaves = (clientX: number) =>
      page.evaluate(
        (clientX) =>
          document.documentElement.dispatchEvent(new MouseEvent("mouseleave", { clientX })),
        clientX,
      );
    await leaves(-1);
    await looked(page);
    await leaves(500);
    await away(page);
    // The keyboard: Tab from the button, which the press left it on, is on Search.
    await page.keyboard.press("Tab");
    await looked(page);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Search",
    );
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await away(page);
    // A row chosen with the pointer has the keyboard, but is not looked at for it.
    await page.mouse.move(8, 300, { steps: 3 });
    await looked(page);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .click();
    await page.locator('main section[aria-label="Conversation with Reviewer"]').waitFor();
    await page.mouse.move(700, 400, { steps: 3 });
    await away(page);
    await page.close();
  }),
);

/** The left side's going and coming take long enough for a pointer to come back while it goes. */
const SLOW =
  '[data-shell] :is(nav[aria-label="Main"], [data-list], [data-side]) { transition-duration: 100s !important; }';
/** Whether the left side is looked at, once a moment has passed in which it could have gone. */
const stays = async (page: Page) => {
  await page.waitForTimeout(100);
  return (await page.locator("[data-shell][data-collapsed][data-peek]").count()) === 1;
};

test(
  "put away by a press, the frame's left side is not taken from under the pointer: it stays where it was, over the card, which has the window behind it, for as long as the pointer is anywhere in its room, and goes when the pointer is past it; a pointer back in its room before it has gone brings it back, and once it has gone only the window's edge does; a press on it while the keyboard has it keeps it",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    const there = {
      button: [10, 10, 32, 32],
      rows: [0, 0, 300, 900],
      list: [0, 0, 300, 900],
      notice: [12, 798, 276, 40],
    };
    assert.deepEqual(await side(page), there);
    // Nothing of it moves as it is put away under the pointer.
    await page.getByRole("button", { name: "Hide list" }).click();
    await looked(page);
    assert.equal(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((one) => (one as CSSTransition).transitionProperty === "translate").length,
      ),
      0,
    );
    assert.deepEqual(await side(page), there);
    assert.deepEqual((await frame(page)).card, [6, 6, 1428, 888]);
    assert.equal(
      await page.getByRole("button", { name: "Show list" }).getAttribute("aria-expanded"),
      "false",
    );
    // Its gaps, its list, the room under the list's last row, its row of places and the little
    // past its end are all on it.
    for (const [x, y] of [
      [150, 26],
      [150, 300],
      [150, 760],
      [150, 880],
      [296, 450],
      [310, 450],
    ] as const) {
      await page.mouse.move(x, y, { steps: 3 });
      assert.ok(await stays(page), `at ${x}, ${y}`);
    }
    await page.mouse.move(330, 450, { steps: 3 });
    await away(page);
    // Gone, the pointer in its room does not bring it: the window's edge does.
    await side(page);
    await page.mouse.move(150, 450, { steps: 3 });
    assert.equal(await stays(page), false);
    await page.mouse.move(8, 450, { steps: 3 });
    await looked(page);
    await side(page);
    // On its way off the window it is still there to come back to.
    const slow = await page.addStyleTag({ content: SLOW });
    await page.mouse.move(330, 450, { steps: 3 });
    await away(page);
    assert.ok(
      await page.evaluate(() => {
        const rows = document.querySelector('nav[aria-label="Main"]') as Element;
        return rows.getAnimations().length > 0 && rows.getBoundingClientRect().right > 200;
      }),
      "it has not gone far yet",
    );
    await page.mouse.move(200, 450, { steps: 3 });
    await looked(page);
    await slow.evaluate((style) => (style as Element).remove());
    assert.deepEqual(await side(page), there);
    // The keyboard on one of its parts keeps it; a press on it then is the pointer's hold.
    await page.mouse.move(700, 450, { steps: 3 });
    await away(page);
    await side(page);
    await page.keyboard.press("Tab");
    await looked(page);
    await page.mouse.click(150, 26);
    assert.ok(await stays(page), "pressed on, it stays");
    await page.mouse.move(700, 450, { steps: 3 });
    await away(page);
    await page.close();
  }),
);

test(
  "looked at, the frame's left side stays while a menu opened from one of its rows is open and while a row is dragged, wherever the pointer goes meanwhile, and goes as the menu closes or the row is let go with the pointer past it",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    await page.getByRole("button", { name: "Hide list" }).click();
    await looked(page);
    const row = page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Research" });
    const at = await row.boundingBox();
    assert.ok(at);
    const y = at.y + at.height / 2;
    // A right-click near the row's end opens its menu past the side's end.
    await page.mouse.click(250, y, { button: "right" });
    const pin = page.getByRole("menuitem", { name: "Pin", exact: true });
    const item = await pin.boundingBox();
    assert.ok(item);
    const past = item.x + item.width - 8;
    assert.ok(past > 312, `the menu's items run past the side: ${past}`);
    await page.mouse.move(past, item.y + item.height / 2, { steps: 4 });
    assert.ok(await stays(page), "it stays while its menu is open");
    // Chosen, the menu closes with the pointer past the side.
    await page.mouse.down();
    await page.mouse.up();
    await away(page);
    for (let tries = 0; !gateway.notes.has("ui/pinned-conversations"); tries++) {
      assert.ok(tries < 100, "the pin is kept");
      await page.waitForTimeout(40);
    }
    assert.deepEqual(gateway.notes.get("ui/pinned-conversations"), ["a-research"]);
    await side(page);
    // A row picked up and carried past the side keeps it until it is let go.
    await page.mouse.move(8, 450, { steps: 3 });
    await looked(page);
    await side(page);
    const other = await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .boundingBox();
    assert.ok(other);
    await page.mouse.move(150, other.y + other.height / 2, { steps: 3 });
    await page.mouse.down();
    await page.mouse.move(500, 500, { steps: 6 });
    await page.locator("[data-dragged]").waitFor();
    assert.ok(await stays(page), "it stays while a row is dragged");
    await page.mouse.up();
    await away(page);
    await page.close();
  }),
);

test(
  "with the list away, a touch brings the frame's left side back by a swipe in from the window's left edge, and sends it away by a touch past it or by choosing a conversation",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/chat`);
    await opened(page);
    // Put away by a touch, it goes at once: no pointer is left on it.
    await page.touchscreen.tap(26, 26);
    await away(page);
    /** A finger down at the first point, moved through the rest, and lifted. */
    const touch = (points: [number, number][]) =>
      page.evaluate((points) => {
        const fire = (type: string, [clientX, clientY]: [number, number]) => {
          const one = new Touch({ identifier: 1, target: document.body, clientX, clientY });
          document.body.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              touches: type === "touchend" ? [] : [one],
              changedTouches: [one],
            }),
          );
        };
        const [first, ...rest] = points as [[number, number], ...[number, number][]];
        fire("touchstart", first);
        for (const point of rest) fire("touchmove", point);
        fire("touchend", points.at(-1) as [number, number]);
      }, points);
    // A swipe that starts in the page, or runs up and down, is the page's own.
    await touch([
      [200, 400],
      [300, 402],
    ]);
    await touch([
      [6, 400],
      [10, 500],
    ]);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-shell][data-peek]").count(), 0);
    await touch([
      [6, 400],
      [30, 402],
      [80, 404],
    ]);
    await looked(page);
    assert.deepEqual((await side(page)).list, [0, 0, 300, 768]);
    // A touch on it changes nothing; one past it sends it away.
    await touch([[150, 400]]);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-shell][data-peek]").count(), 1);
    await touch([[600, 400]]);
    await away(page);
    // A conversation chosen in it is what it was looked at for.
    await touch([
      [6, 400],
      [60, 402],
    ]);
    await looked(page);
    await side(page);
    const row = await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .boundingBox();
    assert.ok(row);
    await page.touchscreen.tap(row.x + row.width / 2, row.y + row.height / 2);
    await page.locator('main section[aria-label="Conversation with Reviewer"]').waitFor();
    await away(page);
    await page.close();
  }),
);

test(
  "on a phone there is no card: the conversation runs to the window's edges above the row of places, with no line, corners or shadow, and the row along the foot is on the ground under its 1 px line",
  withGateway(async (gateway) => {
    const page = await open(gateway, 390, 844, "#/chat/a-reviewer");
    // The plan's notice has a row of its own above the page until it is dismissed.
    const notice = page.getByRole("status").filter({ hasText: "ChatGPT plan" });
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await notice.waitFor({ state: "detached" });
    assert.deepEqual(await frame(page), {
      list: null,
      listFill: null,
      card: [0, 0, 390, 788],
      bar: [0, 788, 390, 56],
      barLine: "1px",
      line: "0px rgba(255, 255, 255, 0.08)",
      corners: "0px",
      shadow: "none",
      fill: "rgb(25, 25, 25)",
      ground: "rgb(20, 20, 20)",
    });
    await light(page);
    const seen = await frame(page);
    assert.deepEqual([seen.fill, seen.ground], ["rgb(250, 250, 250)", "rgb(232, 230, 227)"]);
    await page.close();
  }),
);
