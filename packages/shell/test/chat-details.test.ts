// An agent's details on the chat page: wide, its face in the conversation's head opens them beside
// the conversation, as a card, in the place its computer opens in; narrower, the face goes to the
// team page as before.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computerWith, noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

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
const side = (page: Page) => page.locator("[data-beside]");
/** Research's computer as the sidebar itself: the details hold its computer too, under a tab. */
const computer = (page: Page) =>
  side(page).locator(`> div > section[aria-label="Research's computer"]`);
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

test(
  "wide, a conversation's face opens its agent's details beside it, the conversation narrower by the sidebar and the page where it was; their Close closes them, and so does the face again",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await face(page).waitFor();
    const before = await widthOf(conversation(page));
    await openDetails(page);
    // The page's 1366 less 780, as the computer's sidebar is.
    const sidebar = await widthOf(side(page));
    assert.equal(sidebar, 584);
    assert.equal(before - (await widthOf(conversation(page))), sidebar);
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
  "beside its conversation the details are the agent's page at the sidebar's width: how it stands, Setup, its computer and Overview, with no Message and no Chats, and a tab picked stays on the chat page",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await openDetails(page);
    const shown = details(page);
    await shown.getByRole("heading", { name: "Research", exact: true }).waitFor();
    await shown.getByRole("status", { name: "State" }).waitFor();
    await shown.getByRole("button", { name: "Setup" }).waitFor();
    assert.equal(await shown.getByRole("button", { name: "Message" }).count(), 0);
    const tabs = shown.getByRole("tablist").getByRole("tab");
    assert.deepEqual(await tabs.allInnerTexts(), ["Computer", "Overview"]);
    await shown.getByRole("tabpanel", { name: "Computer" }).waitFor();
    await tabs.filter({ hasText: "Overview" }).click();
    await shown.getByRole("tabpanel", { name: "Overview" }).waitFor();
    assert.match(page.url(), /#\/chat$/);
    // Nothing of it is wider than the card, which scrolls down only.
    const [inner, outer] = await shown.evaluate((card) => {
      const scroller = card.firstElementChild as Element;
      return [scroller.scrollWidth, scroller.clientWidth];
    });
    assert.equal(inner, outer);
    await page.close();
  }),
);

/** The computer's live windows drawn anywhere on the page, each with the part of the page it is in. */
const terminals = (page: Page) =>
  page
    .getByRole("main")
    .getByRole("group", { name: "Terminal" })
    .evaluateAll((groups) =>
      groups.map(
        (group) =>
          group
            .closest("section[aria-label]")
            ?.parentElement?.closest("section[aria-label]")
            ?.getAttribute("aria-label") ?? "the sidebar",
      ),
    );

test(
  "one is beside the conversation at a time: the face puts the details in the open computer's place, the computer's button puts the computer back in theirs, and closing one brings back nothing",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await computerButton(page).click();
    await page.locator('[data-beside="open"]').waitFor();
    await still(page);
    const sidebar = await widthOf(side(page));
    // The sidebar stays open, at its width, through each change of what it shows.
    await face(page).click();
    await details(page).waitFor();
    assert.equal(await computer(page).count(), 0);
    assert.equal(await side(page).getAttribute("data-beside"), "open");
    assert.equal(await widthOf(side(page)), sidebar);
    assert.equal(await computerButton(page).getAttribute("aria-pressed"), "false");
    await computerButton(page).click();
    await computer(page).waitFor();
    assert.equal(await details(page).count(), 0);
    assert.equal(await side(page).getAttribute("data-beside"), "open");
    assert.equal(await computerButton(page).getAttribute("aria-pressed"), "true");
    await computer(page).getByRole("button", { name: "Close Research's computer" }).click();
    await side(page).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.equal(await side(page).count(), 0);
    await page.close();
  }),
);

test(
  "the computer's live window is in one place: under the details' Computer tab, then in the sidebar's computer when its button is pressed, then under the tab again from the face",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await openDetails(page);
    await details(page).getByRole("group", { name: "Terminal" }).waitFor();
    assert.deepEqual(await terminals(page), ["Research's details"]);
    await computerButton(page).click();
    await computer(page).getByRole("group", { name: "Terminal" }).waitFor();
    assert.deepEqual(await terminals(page), ["the sidebar"]);
    await face(page).click();
    await details(page).getByRole("group", { name: "Terminal" }).waitFor();
    assert.deepEqual(await terminals(page), ["Research's details"]);
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
