// The frame around the pages, wide and on a phone, in a real browser over the stand-in gateway:
// its rows of places, where the app opens, and where an agent's address leads. The ground and the
// page's cards on it are in frame-card.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(gateway: Gateway, viewport: typeof WIDE, hash = "#/"): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Nothing runs off the side of the page. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** A part's box as [x, y, width, height]. */
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height] as [number, number, number, number];
};
const bar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const place = (page: Page, name: string | RegExp) =>
  bar(page).getByRole("button", { name, exact: typeof name === "string" });
/** The label a place shows beside it. */
const label = (page: Page) => page.locator('[data-slot="tooltip-content"]');
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "the frame's rows lie over the page's left 300 with no line: Search at the end of a strip along the top, whose start is left empty, Chat and Team from the start of a row along the foot and Settings at its end, and no words, agents, search box or Create",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(await boxOf(bar(page)), [0, 0, 300, 900]);
    assert.deepEqual(
      await bar(page).evaluate((nav) => {
        const style = getComputedStyle(nav);
        return [style.borderRightWidth, style.borderTopWidth];
      }),
      ["0px", "0px"],
    );
    // Four places. Search is 44 square, 4 from the strip's end, in a strip 52 tall. The others are
    // 44 wide and a little less tall, 36, in a row 56 tall: Chat and Team 4 apart from 8 in,
    // Settings 8 from its end. Each of those holds an icon of 22.
    assert.deepEqual(
      await bar(page)
        .getByRole("button")
        .evaluateAll((places) => places.map((one) => one.getAttribute("aria-label"))),
      ["Search", "Chat", "Team", "Settings"],
    );
    assert.deepEqual(await boxOf(place(page, "Search")), [252, 4, 44, 44]);
    assert.deepEqual(await boxOf(place(page, "Chat")), [8, 854, 44, 36]);
    assert.deepEqual(await boxOf(place(page, "Team")), [56, 854, 44, 36]);
    assert.deepEqual(await boxOf(place(page, "Settings")), [248, 854, 44, 36]);
    // The strip's start is empty, for a window's own buttons: nothing to press or read is there.
    assert.equal(
      await page.evaluate(() =>
        [8, 40, 79].some((x) =>
          [8, 26, 51].some((y) => document.elementFromPoint(x, y)?.closest("button, a, h1, li")),
        ),
      ),
      false,
    );
    for (const name of ["Chat", "Team", "Settings"]) {
      const [x, y, width, height] = await boxOf(place(page, name).locator("svg"));
      const [px, py] = await boxOf(place(page, name));
      assert.deepEqual([width, height], [22, 22], name);
      assert.deepEqual([x - px, y - py], [11, 7], `${name}'s icon in the middle of its place`);
    }
    // Search is quieter than the places: an icon of 18 in the middle of its place, with a thinner
    // line, in the grey of what is said quietly.
    const search = place(page, "Search").locator("svg");
    const [sx, sy, sw, sh] = await boxOf(search);
    assert.deepEqual([sw, sh, sx - 252, sy - 4], [18, 18, 13, 13]);
    assert.deepEqual(
      await search.evaluate((icon) => {
        const style = getComputedStyle(icon);
        return [style.strokeWidth, style.color];
      }),
      ["1.5px", "rgb(161, 161, 161)"],
    );
    assert.equal(await bar(page).innerText(), "", "no words");
    assert.equal(await bar(page).getByRole("list").count(), 0, "no agents");
    assert.equal(await bar(page).getByRole("searchbox").count(), 0, "no search box");
    assert.equal(await bar(page).getByRole("button", { name: "Create" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Home" }).count(), 0, "no Home");
    // The page has the whole window, under the frame's rows.
    const main = page.locator("main");
    assert.deepEqual(await boxOf(main), [0, 0, 1440, 900]);
    assert.deepEqual(
      await main.evaluate((e) => {
        const style = getComputedStyle(e);
        return [style.backgroundColor, style.borderTopLeftRadius];
      }),
      ["rgba(0, 0, 0, 0)", "0px"],
    );
    await page.close();
  }),
);

test(
  "each place leads where it says and is marked while you are in it; Settings opens over the place, which stays marked",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const main = page.getByRole("main");
    // Read with the pointer away, since a place under it has the hover's background; and by the
    // bar's markup, which an open window puts out of reach but leaves there.
    const current = async () => {
      await page.mouse.move(700, 450);
      return page
        .locator('nav[aria-label="Main"] [aria-current="page"]')
        .evaluateAll((places) =>
          places.map((one) => [
            one.getAttribute("aria-label"),
            getComputedStyle(one).backgroundColor,
          ]),
        );
    };
    await main.getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(await current(), [["Chat", "rgba(255, 255, 255, 0.08)"]]);
    const still = await boxOf(bar(page));
    await place(page, "Team").click();
    await page.waitForURL(/#\/team$/);
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.deepEqual(await current(), [["Team", "rgba(255, 255, 255, 0.08)"]]);
    await place(page, "Settings").click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    assert.deepEqual(await current(), [["Team", "rgba(255, 255, 255, 0.08)"]]);
    assert.match(page.url(), /#\/team$/, "the address is the place's");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
    await place(page, "Chat").click();
    await page.waitForURL(/#\/chat$/);
    await main.getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(
      (await current()).map(([name]) => name),
      ["Chat"],
    );
    assert.deepEqual(await boxOf(bar(page)), still, "the bar doesn't move between places");
    // A place not current is plain until the pointer is on it.
    assert.equal(
      await place(page, "Team").evaluate((one) => getComputedStyle(one).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await page.close();
  }),
);

test(
  "a place's label shows over it while the pointer rests on it or the keyboard is on it, fading in and out",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    await place(page, "Team").waitFor();
    assert.equal(await label(page).count(), 0, "no label at first");
    await place(page, "Team").hover();
    await label(page).waitFor();
    assert.equal(await label(page).innerText(), "Team");
    const animation = () => label(page).evaluate((one) => getComputedStyle(one).animationName);
    assert.equal(await animation(), "enter", "it fades in");
    // Once it has come in: over its place, past its arrow, on the place's middle.
    await label(page).evaluate((one) =>
      Promise.all(one.getAnimations().map((moving) => moving.finished)),
    );
    const [x, y, width, height] = await boxOf(label(page));
    assert.ok(y + height <= 854 - 6, "over the place");
    assert.ok(Math.abs(x + width / 2 - 78) < 1, "on the place's middle");
    // Away from it: the pointer leaves the place and goes on, as a hand moves it.
    await page.mouse.move(700, 450, { steps: 4 });
    await page.locator('[data-slot="tooltip-content"][data-state="closed"]').waitFor();
    assert.equal(await animation(), "exit", "it fades out");
    await label(page).waitFor({ state: "detached" });

    // From the keyboard: the place it is on shows its label, and only that one.
    await place(page, "Chat").focus();
    await label(page).getByText("Chat").waitFor();
    await page.keyboard.press("Tab");
    await label(page).filter({ hasText: "Team" }).waitFor();
    await label(page).filter({ hasText: "Chat" }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await label(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "a sideways scroll over the list or the frame's rows goes to the next place and back, one place a gesture; a scroll up or down, or one over a card, changes nothing",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/chat");
    await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
    /** The place, a moment after a scroll that should change nothing. */
    const after = async () => {
      await page.waitForTimeout(120);
      return new URL(page.url()).hash;
    };
    /** A gesture is over once nothing has come of it for a moment. */
    const ended = () => page.waitForTimeout(300);
    // Over the list: down is the list's own.
    await page.mouse.move(150, 450);
    await page.mouse.wheel(0, 120);
    assert.equal(await after(), "#/chat");
    await page.mouse.wheel(120, 0);
    await page.waitForURL(/#\/team$/);
    // The same gesture running on, even turned back, changes nothing more.
    await page.mouse.wheel(-120, 0);
    assert.equal(await after(), "#/team");
    await ended();
    // Over the row of places, back: and before the first place there is none.
    await page.mouse.move(150, 890);
    await page.mouse.wheel(-120, 0);
    await page.waitForURL(/#\/chat$/);
    await ended();
    await page.mouse.wheel(-120, 0);
    assert.equal(await after(), "#/chat");
    await ended();
    // Over the conversation's card it is the card's own.
    await page.mouse.move(800, 450);
    await page.mouse.wheel(120, 0);
    assert.equal(await after(), "#/chat");
    await page.close();
  }),
);

test(
  "the Chat icon carries the count of conversations with something new, as the floating chat's button does",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/team");
    const pill = page.getByRole("group", { name: "Chats, collapsed" });
    await pill.getByRole("button", { name: "Chats", exact: true }).waitFor();
    await noted(gateway);
    assert.equal(await place(page, "Chat").innerText(), "", "nothing new, no count");
    gateway.addMessage("a-reviewer", reply("r9", "All clear on #482."));
    await pill.getByRole("button", { name: "Chats, 1 new" }).waitFor();
    await place(page, "Chat, 1 new").waitFor();
    assert.equal(await place(page, "Chat, 1 new").innerText(), "1");
    gateway.addMessage("a-research", reply("s9", "Found it."));
    await pill.getByRole("button", { name: "Chats, 2 new" }).waitFor();
    assert.equal(await place(page, "Chat, 2 new").innerText(), "2");
    // The chat page opens on the newest, which is read there; then the other is read too.
    await place(page, "Chat, 2 new").click();
    const main = page.getByRole("main");
    await main
      .getByRole("region", { name: "Conversation with Research" })
      .getByText("Found it.")
      .waitFor();
    await place(page, "Chat, 1 new").waitFor();
    await main.getByRole("list", { name: "Chats" }).getByText("All clear on #482.").click();
    await main
      .getByRole("region", { name: "Conversation with Reviewer" })
      .getByText("All clear on #482.")
      .waitFor();
    await place(page, "Chat").waitFor();
    assert.equal(await place(page, "Chat").innerText(), "");
    await page.close();
  }),
);

test(
  "the app opens on Chat, and so does an address that names nothing",
  withGateway(async (gateway) => {
    for (const hash of ["", "#/", "#/nothing/here"]) {
      const page = await open(gateway, WIDE, hash);
      await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
      assert.equal(await place(page, "Chat").getAttribute("aria-current"), "page", hash);
      await page.close();
    }
  }),
);

test(
  "an agent's own address and its tabs show its details in Team",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.equal(await place(page, "Team").getAttribute("aria-current"), "page");
    assert.equal(
      await main
        .getByRole("list", { name: "Agents" })
        .getByRole("button", { name: /Reviewer/ })
        .getAttribute("aria-current"),
      "true",
    );
    await page.goto(`${gateway.url}/#/a/a-research/chats`);
    await main.getByRole("heading", { name: "Research", level: 1 }).waitFor();
    await main.getByRole("tab", { name: "Chats", selected: true }).waitFor();
    await main.getByRole("region", { name: "Team" }).waitFor();
    // Its tabs are Team's from there on.
    await main.getByRole("tab", { name: "Overview" }).click();
    await page.waitForURL(/#\/team\/a-research\/overview$/);
    await page.close();
  }),
);

test(
  "on a phone the places sit in a row along the foot under a 1 px line, with their labels, the current one in full colour, and the floating chat's button above them",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE, "#/team");
    const main = page.getByRole("main");
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.deepEqual(await boxOf(bar(page)), [0, 788, 390, 56]);
    assert.deepEqual(
      await bar(page).evaluate((nav) => {
        const style = getComputedStyle(nav);
        return [style.borderTopWidth, style.borderTopColor, style.borderRightWidth];
      }),
      ["1px", "rgba(255, 255, 255, 0.08)", "0px"],
    );
    // Under the bar's 1 px line along its top.
    assert.deepEqual(await boxOf(place(page, "Search")), [0, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Chat")), [97.5, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Team")), [195, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Settings")), [292.5, 789, 97.5, 55]);
    // Each label is under its icon, and the four icons are one size, Search's too.
    for (const name of ["Search", "Chat", "Team", "Settings"]) {
      assert.equal(await place(page, name).innerText(), name);
      const icon = await boxOf(place(page, name).locator("svg"));
      assert.equal(icon[2], 22, `${name}'s icon`);
      const words = await boxOf(place(page, name).getByText(name, { exact: true }));
      assert.ok(words[1] >= icon[1] + icon[3], `${name}'s label under its icon`);
      assert.equal(
        await place(page, name)
          .getByText(name)
          .evaluate((e) => getComputedStyle(e).fontSize),
        "10px",
      );
    }
    const colours = await bar(page)
      .getByRole("button")
      .evaluateAll((places) =>
        places.map((one) => [
          one.getAttribute("aria-label"),
          getComputedStyle(one).color,
          getComputedStyle(one).backgroundColor,
        ]),
      );
    assert.deepEqual(colours, [
      ["Search", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
      ["Chat", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
      ["Team", "rgb(250, 250, 250)", "rgba(0, 0, 0, 0)"],
      ["Settings", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
    ]);
    // No menu button and no head: once the plan's notice is dismissed, the page has the room
    // above the row, to the window's edges.
    assert.equal(await page.getByRole("button", { name: "Menu" }).count(), 0);
    assert.equal(await page.getByRole("banner").filter({ visible: true }).count(), 0);
    const notice = page.getByRole("status").filter({ hasText: "ChatGPT plan" });
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await notice.waitFor({ state: "detached" });
    assert.deepEqual(await boxOf(page.locator("main")), [0, 0, 390, 788]);
    // The floating chat's button sits above the row.
    const pill = await boxOf(page.getByRole("group", { name: "Chats, collapsed" }));
    assert.equal(pill[1] + pill[3], 788 - 20);
    // A label doesn't show beside a place here: it is under it already.
    await place(page, "Settings").hover();
    await page.waitForTimeout(300);
    assert.equal(await label(page).filter({ visible: true }).count(), 0);
    assert.equal(await fits(page), true);
    await page.close();
  }),
);

test(
  "at phone width nothing runs off the side, and Create and Settings still work",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE);
    // Chat, with its conversations on it.
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("listitem")
      .first()
      .waitFor();
    assert.equal(await fits(page), true, "Chat");
    // Create is on Team.
    await place(page, "Team").click();
    await page.getByRole("main").getByRole("button", { name: "Create" }).click();
    const stack = page.getByRole("dialog", { name: "Create" });
    await stack.getByRole("button", { name: /^Assistant/ }).click();
    await stack.getByLabel("Name").fill("Foreman");
    await page.waitForTimeout(250);
    const box = await stack.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, "the popup fits across");
    assert.ok(box.y >= 0 && box.y + box.height <= PHONE.height, "and down");
    await stack.getByRole("button", { name: "Create", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await stack.waitFor({ state: "detached" });
    // Settings takes the screen, and a section's action is whole on its top line.
    await place(page, "Settings").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.deepEqual(await boxOf(settings), [0, 0, PHONE.width, PHONE.height]);
    await settings
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Skills" })
      .click();
    const add = settings.getByRole("button", { name: "Add skill" });
    assert.equal((await add.innerText()).trim(), "Add skill");
    const action = await add.boundingBox();
    assert.ok(action && action.x + action.width <= PHONE.width, "what it offers is in view");
    assert.equal(await fits(page), true, "settings");
    await page.close();
  }),
);
