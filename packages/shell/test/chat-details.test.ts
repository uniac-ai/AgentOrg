// An agent's details on the chat page: where the page has room for their column beside the list and
// a conversation of 472, the face in the conversation's head opens them beside the conversation, in
// the place its computer opens in: in the conversation's card, on its ground, past a line of the
// card's own; where it hasn't, the face goes to the team page as before.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computerWith, noted } from "./design/samples.ts";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());
// A test that fails leaves its page open, and a page opened beside one draws its frames far apart:
// each test starts with none.
test.afterEach(() => Promise.all(browser.contexts().map((context) => context.close())));

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash = "#/chat", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await noted(gateway);
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
const conversation = (page: Page, name = "Research") =>
  page.getByRole("main").getByRole("region", { name: `Conversation with ${name}` });
const face = (page: Page, name = "Research") =>
  conversation(page, name).getByRole("button", { name: `${name}'s details` });
const computerButton = (page: Page) =>
  conversation(page).getByRole("button", { name: "Research's computer" });
/** An agent's details as the page draws them, beside the conversation. */
const details = (page: Page, name = "Research") =>
  page.getByRole("main").getByRole("region", { name: `${name}'s details` });
/** Research's computer as the page draws it, beside the conversation. */
const computer = (page: Page) =>
  page.getByRole("main").getByRole("region", { name: "Research's computer" });
const side = (page: Page) => page.locator("[data-beside]");
/**
 * Waits for the sidebar to be open and its own motion to finish, so what is measured is where it
 * came to: it is drawn closed for a frame before it opens, with what it shows already in it. What
 * it shows may move for as long as it is shown.
 */
const still = async (page: Page) => {
  await page.locator('[data-beside="open"]').waitFor();
  await side(page).evaluate((element) =>
    Promise.all(
      [element, element.firstElementChild as Element]
        .flatMap((part) => part.getAnimations())
        .map((motion) => motion.finished),
    ),
  );
};
const widthOf = async (part: ReturnType<Page["locator"]>) =>
  Math.round((await part.boundingBox())?.width ?? 0);
/** Opens Research's details beside its conversation, and waits for them to come to rest. */
async function openDetails(page: Page) {
  await face(page).click();
  await details(page).waitFor();
  await still(page);
}
/** The details' column. */
const COLUMN = 360;
/** The 6 beside the card, and the card's line at each side. */
const GAP = 6;
const LINES = 2;
/**
 * The narrowest screen with room for it: the page is the screen, and holds its list's 300 and the
 * card, 6 from the screen's side, with a conversation of 472 and the column inside its line.
 */
const ROOM = 300 + 472 + COLUMN + LINES + GAP;
/** The card the conversation is in, with what is open beside it. */
const card = (page: Page) => conversation(page).locator("xpath=..");

test(
  "wide, a conversation's face opens its agent's details beside it in a column of 360, in the conversation's card and on its ground, past one line of the card's own, the conversation narrower by it and the page where it was; their Close closes them, and so does the face again",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await face(page).waitFor();
    const before = await widthOf(conversation(page));
    await openDetails(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    assert.equal(before - (await widthOf(conversation(page))), COLUMN);
    // One card holds both: the side has no ground, corners or shadow of its own, and starts at
    // the conversation's end with a line the colour of the card's, which ends where the side does.
    const look = () =>
      side(page).evaluate((e) => {
        const style = getComputedStyle(e);
        const holder = e.parentElement as Element;
        const held = getComputedStyle(holder);
        const box = e.getBoundingClientRect();
        const around = holder.getBoundingClientRect();
        const before = (e.previousElementSibling as Element).getBoundingClientRect();
        return {
          ground: [style.backgroundColor, held.backgroundColor],
          line: [style.borderLeftWidth, style.borderLeftColor === held.borderTopColor],
          own: [style.borderTopWidth, style.borderRightWidth, style.borderTopLeftRadius],
          shadow: style.boxShadow,
          from: box.left - before.right,
          to: around.right - box.right,
          tall: [box.top - around.top, around.bottom - box.bottom],
        };
      });
    const drawn = {
      line: ["1px", true],
      own: ["0px", "0px", "0px"],
      shadow: "none",
      from: 0,
      to: 1,
      tall: [1, 1],
    };
    assert.deepEqual(await look(), {
      ground: ["rgba(0, 0, 0, 0)", "rgb(25, 25, 25)"],
      ...drawn,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    assert.deepEqual(await look(), {
      ground: ["rgba(0, 0, 0, 0)", "rgb(250, 250, 250)"],
      ...drawn,
    });
    assert.equal(await widthOf(card(page)), 1440 - 300 - GAP);
    assert.match(page.url(), /#\/chat$/);
    await details(page).getByRole("button", { name: "Close Research's details" }).click();
    await side(page).waitFor({ state: "detached" });
    assert.equal(await widthOf(conversation(page)), before);
    await openDetails(page);
    await face(page).click();
    await side(page).waitFor({ state: "detached" });
    assert.match(page.url(), /#\/chat$/);
    await page.close();
  }),
);

test(
  "the details open on the narrowest screen that leaves the conversation its 472 beside them, and one pixel narrower the face goes to the team page; with the list put away the page has the list's room too, and they open there",
  withGateway(async (gateway) => {
    let page = await open(gateway, "#/chat/a-research", ROOM);
    await openDetails(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    assert.equal(await widthOf(conversation(page)), 472);
    await page.close();

    page = await open(gateway, "#/chat/a-research", ROOM - 1);
    // The list is beside the conversation still.
    await page.getByRole("main").getByRole("region", { name: "Chats" }).waitFor();
    await face(page).click();
    await page.waitForURL(/#\/team\/a-research$/);
    assert.equal(await side(page).count(), 0);
    await page.close();

    page = await open(gateway, "#/chat/a-research", ROOM - 1);
    await page.getByRole("button", { name: "Hide list" }).click();
    await page.locator("[data-shell][data-collapsed]").waitFor();
    await openDetails(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    // The conversation has what the card has beside the column: the page less the 6 at each side
    // and the card's line.
    assert.equal(await widthOf(conversation(page)), ROOM - 1 - 2 * GAP - LINES - COLUMN);
    await page.close();
  }),
);

test(
  "the details are their Close in a thin row of its own in the top corner and, under it, one card with the agent's face, its name and what it is for, read whole, stacked and centred at the creation window's sizes, on the side's ground, and nothing else",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const purpose = "Digs through issues and docs, and writes up what it finds for the whole team";
    (gateway.agents.get("a-research") as Agent).purpose = purpose;
    const page = await open(gateway);
    await openDetails(page);
    const shown = details(page);
    await shown.getByText(purpose).waitFor();
    // Its face, its name and what it is for, and no other words; two buttons, Close and its own.
    assert.deepEqual((await shown.innerText()).split(/\n+/), ["R", "Research", purpose]);
    assert.deepEqual(
      await shown.getByRole("button").evaluateAll((all) => all.map((b) => b.ariaLabel)),
      ["Close Research's details", "Research on the team page"],
    );
    const boxes = await shown.evaluate((column) => {
      const box = (element: Element | null | undefined) => {
        const at = (element as Element).getBoundingClientRect();
        return { x: at.x, y: at.y, right: at.right, bottom: at.bottom, mid: (at.x + at.right) / 2 };
      };
      const [close, group] = column.querySelectorAll("button");
      const said = column.querySelector("p") as Element;
      const card = said.parentElement as Element;
      const name = group?.lastElementChild as Element;
      const [carded, named, worded] = [card, name, said].map((e) => getComputedStyle(e));
      return {
        column: box(column),
        close: box(close),
        card: box(card),
        face: box(group?.firstElementChild),
        name: box(name),
        purpose: box(said),
        ground: getComputedStyle(column).backgroundColor,
        carded: [carded?.borderTopWidth, carded?.backgroundColor !== "rgba(0, 0, 0, 0)"],
        type: [named?.fontSize, named?.fontWeight, worded?.fontSize, worded?.textAlign],
        // Nothing of it is cut at its side: neither what it is for, nor the column.
        cut: [column, said].map((e) => e.scrollWidth - e.clientWidth),
      };
    });
    const sizeOf = (at: { x: number; y: number; right: number; bottom: number }) => [
      at.right - at.x,
      at.bottom - at.y,
    ];
    // Close is small, in the column's top corner, with nothing beside it; the card is 12 under its
    // row.
    assert.deepEqual(sizeOf(boxes.close), [24, 24], "its Close");
    assert.deepEqual([boxes.close.right, boxes.close.y], [boxes.column.right, boxes.column.y]);
    assert.equal(boxes.card.y - boxes.close.bottom, 12, "the card under Close's row");
    assert.deepEqual([boxes.card.x, boxes.card.right], [boxes.column.x, boxes.column.right]);
    assert.deepEqual(boxes.carded, ["1px", true], "a card with a line and a fill");
    // In it, as the creation window draws them: a face of 80, the name 16 under it at 22 semibold,
    // and what it is for 4 under that at 13, each on the card's middle.
    assert.deepEqual(sizeOf(boxes.face), [80, 80], "its face");
    assert.equal(boxes.name.y - boxes.face.bottom, 16, "its name under its face");
    assert.equal(boxes.purpose.y - boxes.name.bottom, 4, "what it is for under its name");
    assert.deepEqual(boxes.type, ["22px", "600", "13px", "center"]);
    for (const part of [boxes.face, boxes.name, boxes.purpose])
      assert.ok(Math.abs(part.mid - boxes.card.mid) <= 0.5, "on the card's middle");
    assert.deepEqual(boxes.cut, [0, 0]);
    assert.equal(boxes.ground, "rgba(0, 0, 0, 0)", "no ground of its own");
    await page.close();
  }),
);

test(
  "the details' face and name go to the agent on the team page",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openDetails(page);
    await details(page).getByRole("button", { name: "Research on the team page" }).click();
    await page.waitForURL(/#\/team\/a-research$/);
    await page.getByRole("main").getByRole("heading", { name: "Research" }).waitFor();
    await page.close();
  }),
);

test(
  "one is beside the conversation at a time: the face puts the details in the open computer's place, the computer's button puts the computer back in theirs, the sidebar open throughout and going to the width of what it shows; closing one brings back nothing",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await computerButton(page).click();
    await computer(page).waitFor();
    await still(page);
    const sidebar = await widthOf(side(page));
    assert.ok(sidebar > COLUMN, `${sidebar}`);
    await face(page).click();
    await details(page).waitFor();
    assert.equal(await computer(page).count(), 0);
    assert.equal(await side(page).getAttribute("data-beside"), "open");
    assert.equal(await computerButton(page).getAttribute("aria-pressed"), "false");
    await still(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    await computerButton(page).click();
    await computer(page).waitFor();
    assert.equal(await details(page).count(), 0);
    assert.equal(await side(page).getAttribute("data-beside"), "open");
    assert.equal(await computerButton(page).getAttribute("aria-pressed"), "true");
    await still(page);
    assert.equal(await widthOf(side(page)), sidebar);
    await computer(page).getByRole("button", { name: "Close Research's computer" }).click();
    await side(page).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.equal(await side(page).count(), 0);
    await page.close();
  }),
);

test(
  "while the sidebar closes it still shows what it showed: the details closed from their Close, and the computer that took their place closed from its own",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    /** Presses a button, and says what the sidebar holds once it is closing. */
    const closing = (pressed: ReturnType<Page["locator"]>) =>
      pressed.evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        for (let frames = 0; frames < 30; frames++) {
          const side = document.querySelector('[data-beside="closed"]');
          if (side)
            return [...side.querySelectorAll(":scope > div > section")].map((shown) =>
              shown.getAttribute("aria-label"),
            );
          await new Promise((done) => requestAnimationFrame(done));
        }
        return undefined;
      });
    await openDetails(page);
    assert.deepEqual(
      await closing(details(page).getByRole("button", { name: "Close Research's details" })),
      ["Research's details"],
    );
    await side(page).waitFor({ state: "detached" });
    // The computer in the details' place, then closed.
    await openDetails(page);
    await computerButton(page).click();
    await computer(page).waitFor();
    assert.deepEqual(
      await closing(computer(page).getByRole("button", { name: "Close Research's computer" })),
      ["Research's computer"],
    );
    await side(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "open, the details are the open conversation's agent's: another conversation shows its own",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openDetails(page);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .click();
    await details(page, "Reviewer").getByText("Reviewer", { exact: true }).waitFor();
    assert.equal(await details(page).count(), 0);
    assert.equal(await side(page).getAttribute("data-beside"), "open");
    // Its face closes them, as the first's did.
    await face(page, "Reviewer").click();
    await side(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

for (const [where, width] of [
  ["narrower", 800],
  ["on a phone", 390],
] as const)
  test(
    `${where}, a conversation's face goes to its agent's details on the team page, with no sidebar, and leaves the floating chat collapsed`,
    withGateway(async (gateway) => {
      const page = await open(gateway, "#/chat/a-research", width);
      await face(page).click();
      await page.waitForURL(/#\/team\/a-research$/);
      await page.getByRole("main").getByRole("heading", { name: "Research" }).waitFor();
      assert.equal(await side(page).count(), 0);
      assert.equal(await page.getByRole("complementary", { name: "Chats" }).count(), 0);
      await page.getByRole("group", { name: "Chats, collapsed" }).waitFor();
      await page.close();
    }),
  );
