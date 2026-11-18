// An agent's computer on the chat page: wide, beside the conversation, opening and closing with a
// little motion; narrower, and on every other page, the layer's window as before.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computer, computerWith, noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(
  gateway: Gateway,
  hash = "#/chat",
  width = 1440,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
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
const conversation = (page: Page) =>
  page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
const button = (page: Page) =>
  conversation(page).getByRole("button", { name: "Research's computer" });
/** Research's computer as the page draws it, beside the conversation. */
const beside = (page: Page) =>
  page.getByRole("main").getByRole("region", { name: "Research's computer" });
const side = (page: Page) => page.locator("[data-beside]");
/** The layer's window. */
const window = (page: Page) => page.getByRole("group", { name: "Window" });
/** Waits for the sidebar's motion to finish, so what is measured is where it came to. */
const still = (page: Page) =>
  side(page).evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((motion) => motion.finished)),
  );
const widthOf = async (page: Page, part: ReturnType<Page["locator"]>) =>
  Math.round((await part.boundingBox())?.width ?? 0);
/** Opens Research's computer beside its conversation, and waits for it to come to rest. */
async function openBeside(page: Page) {
  await button(page).click();
  await page.locator('[data-beside="open"]').waitFor();
  await still(page);
}

test(
  "wide, a conversation's computer opens beside it: no window over the page, and the conversation narrower by the sidebar",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await button(page).waitFor();
    const before = await widthOf(page, conversation(page));
    await openBeside(page);
    await beside(page).waitFor();
    assert.equal(await window(page).count(), 0);
    const sidebar = await widthOf(page, side(page));
    assert.equal(before - (await widthOf(page, conversation(page))), sidebar);
    await page.close();
  }),
);

test(
  "the sidebar is the page's width less 780, held between 480 and 720",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    // The page is the screen less today's left bar.
    for (const [screen, wide] of [
      [1300, 480],
      [1600, 584],
      [1800, 720],
    ] as const) {
      const page = await open(gateway, "#/chat", screen);
      await openBeside(page);
      assert.equal(await widthOf(page, side(page)), wide, `at ${screen}`);
      await page.close();
    }
  }),
);

test(
  "the computer's window in front shows inside the sidebar, and its dock picks another there",
  withGateway(async (gateway) => {
    computer(gateway, [
      { surface: "terminal", protocol: "terminal@1", operate: true },
      { surface: "files", protocol: "files@1", operate: true },
    ]);
    const page = await open(gateway);
    await openBeside(page);
    await beside(page).getByRole("group", { name: "Terminal" }).waitFor();
    await beside(page)
      .getByRole("navigation", { name: "Dock" })
      .getByRole("button", { name: "Files" })
      .click();
    await beside(page).getByRole("group", { name: "Files" }).waitFor();
    assert.equal(await beside(page).getByRole("group", { name: "Terminal" }).count(), 0);
    await page.close();
  }),
);

test(
  "its own Close closes it, and so does the conversation's button, whose pressed state follows",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await openBeside(page);
    assert.equal(await button(page).getAttribute("aria-pressed"), "true");
    await beside(page).getByRole("button", { name: "Close Research's computer" }).click();
    await side(page).waitFor({ state: "detached" });
    assert.equal(await button(page).getAttribute("aria-pressed"), "false");
    await openBeside(page);
    await button(page).click();
    await side(page).waitFor({ state: "detached" });
    assert.equal(await button(page).getAttribute("aria-pressed"), "false");
    assert.equal(await window(page).count(), 0);
    await page.close();
  }),
);

test(
  "opening and closing take the page's window times, read from its styles; with reduced motion they take none",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const seconds = (time: string) =>
      time.endsWith("ms") ? Number.parseFloat(time) / 1000 : Number.parseFloat(time);
    let page = await open(gateway);
    const times = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return [root.getPropertyValue("--window-open"), root.getPropertyValue("--window-close")];
    });
    const [opening, closing] = times.map((time) => seconds(time.trim()));
    assert.ok(opening && closing && opening > closing, `${times}`);
    await openBeside(page);
    const durationOf = () =>
      side(page).evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).transitionDuration),
      );
    assert.equal(await durationOf(), opening);
    // Pressed, it closes in the closing time, and is still there while it does.
    const closingNow = await button(page).evaluate(async (pressed) => {
      (pressed as HTMLButtonElement).click();
      for (let frames = 0; frames < 30; frames++) {
        const element = document.querySelector('[data-beside="closed"]');
        if (element) return Number.parseFloat(getComputedStyle(element).transitionDuration);
        await new Promise((done) => requestAnimationFrame(done));
      }
      return undefined;
    });
    assert.equal(closingNow, closing);
    await side(page).waitFor({ state: "detached" });
    await page.close();

    page = await open(gateway, "#/chat", 1440, "reduce");
    await openBeside(page);
    assert.equal(
      await side(page).evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s",
    );
    // With no motion it goes as it is pressed.
    const gone = await button(page).evaluate(async (pressed) => {
      (pressed as HTMLButtonElement).click();
      await new Promise((done) => setTimeout(done, 50));
      return document.querySelector("[data-beside]") === null;
    });
    assert.ok(gone);
    await page.close();
  }),
);

test(
  "narrower, the same button opens the layer's window, and no sidebar",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway, "#/chat/a-research", 800);
    await button(page).click();
    await window(page).getByRole("region", { name: "Research's computer" }).waitFor();
    assert.equal(await side(page).count(), 0);
    // With no floating chat beside it, the window ends where the page ends.
    const [shown, room] = await Promise.all([
      window(page).boundingBox(),
      page.evaluate(() => innerWidth - 20),
    ]);
    assert.equal(Math.round((shown?.x ?? 0) + (shown?.width ?? 0)), room);
    await page.close();
  }),
);

test(
  "open beside the conversation, it is the layer's window on another page, and beside the conversation again back on the chat page",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    await openBeside(page);
    await page.evaluate(() => {
      location.hash = "#/a/a-reviewer";
    });
    await window(page).getByRole("region", { name: "Research's computer" }).waitFor();
    assert.equal(await side(page).count(), 0);
    await page.evaluate(() => {
      location.hash = "#/chat";
    });
    await page.locator('[data-beside="open"]').waitFor();
    await beside(page).waitFor();
    assert.equal(await window(page).count(), 0);
    await page.close();
  }),
);

test(
  "an agent's activity, opened on its page, is still the layer's window on the chat page",
  withGateway(async (gateway) => {
    gateway.setWorks("a-research", [
      {
        id: "w1",
        title: "Checkouts",
        state: "idle",
        at: new Date().toISOString(),
        entries: [
          {
            id: "e1",
            at: new Date().toISOString(),
            call: {
              name: "github__search_issues",
              state: "done",
              input: "{}",
              output: "14 issues",
            },
          },
          { id: "e2", at: new Date().toISOString(), words: "Reproducing it now." },
        ],
      },
    ]);
    const page = await open(gateway, "#/a/a-research/overview");
    await page
      .getByRole("main")
      .getByRole("region", { name: "Activity" })
      .getByRole("button", { name: "Expand" })
      .click();
    await window(page).getByRole("region", { name: "Research's activity" }).waitFor();
    await page.evaluate(() => {
      location.hash = "#/chat";
    });
    await conversation(page).waitFor();
    await window(page).getByRole("region", { name: "Research's activity" }).waitFor();
    assert.equal(await side(page).count(), 0);
    await page.close();
  }),
);

test(
  "the message box keeps the keyboard when the sidebar opens",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    const box = conversation(page).getByRole("textbox", { name: "Message" });
    await box.click();
    await box.pressSequentially("Still typing");
    // Pressed without moving the keyboard, as a click on it would.
    await button(page).evaluate((pressed) => (pressed as HTMLButtonElement).click());
    await page.locator('[data-beside="open"]').waitFor();
    await still(page);
    assert.ok(await box.evaluate((element) => element === document.activeElement));
    await page.keyboard.type(", and more");
    assert.equal(await box.inputValue(), "Still typing, and more");
    await page.close();
  }),
);
