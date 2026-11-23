// An agent's details on the chat page: where the page has room for their column beside the list and
// a conversation of 460, the face in the conversation's head opens them beside the conversation, in
// the place its computer opens in; where it hasn't, the face goes to the team page as before.
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
 * Waits for the sidebar's own motion to finish, so what is measured is where it came to. What it
 * shows may move for as long as it is shown.
 */
const still = (page: Page) =>
  side(page).evaluate((element) =>
    Promise.all(
      [element, element.firstElementChild as Element]
        .flatMap((part) => part.getAnimations())
        .map((motion) => motion.finished),
    ),
  );
const widthOf = async (part: ReturnType<Page["locator"]>) =>
  Math.round((await part.boundingBox())?.width ?? 0);
/** Opens Research's details beside its conversation, and waits for them to come to rest. */
async function openDetails(page: Page) {
  await face(page).click();
  await page.locator('[data-beside="open"]').waitFor();
  await details(page).waitFor();
  await still(page);
}
/** The details' column. */
const COLUMN = 360;
/**
 * The narrowest screen with room for it: the page is the screen less the bar's 62 and the card's 6
 * at each side with its line, and holds its list's 320, a conversation of 460 and the column.
 */
const ROOM = 62 + 14 + 320 + 460 + COLUMN;

test(
  "wide, a conversation's face opens its agent's details beside it in a column of 360, the conversation narrower by it and the page where it was; their Close closes them, and so does the face again",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await face(page).waitFor();
    const before = await widthOf(conversation(page));
    await openDetails(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    assert.equal(before - (await widthOf(conversation(page))), COLUMN);
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
  "the details open on the narrowest screen that leaves the conversation its 460 beside them, and one pixel narrower the face goes to the team page",
  withGateway(async (gateway) => {
    let page = await open(gateway, "#/chat/a-research", ROOM);
    await openDetails(page);
    assert.equal(await widthOf(side(page)), COLUMN);
    assert.equal(await widthOf(conversation(page)), 460);
    await page.close();

    page = await open(gateway, "#/chat/a-research", ROOM - 1);
    // The list is beside the conversation still.
    await page.getByRole("main").getByRole("region", { name: "Chats" }).waitFor();
    await face(page).click();
    await page.waitForURL(/#\/team\/a-research$/);
    assert.equal(await side(page).count(), 0);
    await page.close();
  }),
);

test(
  "beside its conversation the details are the agent's head and its Overview alone: how it stands, Setup, and what it is for read whole, with no Message, no tabs and no computer, and nothing wider than the column",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const purpose = "Digs through issues and docs, and writes up what it finds for the whole team";
    (gateway.agents.get("a-research") as Agent).purpose = purpose;
    const page = await open(gateway);
    await openDetails(page);
    const shown = details(page);
    await shown.getByRole("heading", { name: "Research", exact: true }).waitFor();
    await shown.getByRole("status", { name: "State" }).waitFor();
    await shown.getByRole("button", { name: "Setup" }).waitFor();
    await shown.getByRole("region", { name: "Activity" }).waitFor();
    assert.equal(await shown.getByRole("button", { name: "Message" }).count(), 0);
    assert.equal(await shown.getByRole("tablist").count(), 0);
    assert.equal(await shown.getByRole("region", { name: "Research's computer" }).count(), 0);
    // Nothing of it is cut at its side: neither its purpose, nor what scrolls in it.
    const widths = (part: ReturnType<Page["locator"]>) =>
      part.evaluate((element) => [element.scrollWidth, element.clientWidth]);
    const [words, line] = await widths(shown.getByText(purpose));
    assert.equal(words, line, "its purpose, whole");
    const [inner, outer] = await widths(shown.locator("> div").first());
    assert.equal(inner, outer);
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
    await details(page, "Reviewer").getByRole("heading", { name: "Reviewer" }).waitFor();
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
