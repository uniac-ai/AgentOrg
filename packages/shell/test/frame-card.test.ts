// The page on the ground, in a real browser over the stand-in gateway: wider than a phone, its list
// at the left on the ground itself, between the frame's strip and its row of places, and what it
// shows in a card beside it, 6 px from the window's top and side and 12 from its foot, with a 1 px
// line, 14 px corners and a slight shadow. Narrower than both side by side, the card is alone
// between the strip and the row. On a phone there is no card.
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
    const card = document.querySelector('main section[aria-label^="Conversation with"]');
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
  "the list is put away by the first button of the strip: Search and the row of places go with it, and what is chosen has the page under the strip, on Chat and on Team; it is so when the page opens again, and the same button brings them all back; narrower than both side by side there is no such button",
  withGateway(async (gateway) => {
    let page = await open(gateway, 1440, 900, "#/chat");
    await opened(page);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const boxOf = async (name: string) => {
      const box = await button(name).boundingBox();
      return box && [box.x, box.y, box.width, box.height];
    };
    const places = page.getByRole("navigation", { name: "Main" });
    /** Whether the person's store says the list is away, once it says so or not. */
    const kept = async (wanted: boolean) => {
      for (let tries = 0; gateway.notes.get("ui/list-collapsed") !== wanted; tries++) {
        assert.ok(tries < 100, `the store says ${wanted}`);
        await page.waitForTimeout(40);
      }
    };
    assert.deepEqual(await boxOf("Hide list"), [4, 4, 44, 44]);
    assert.equal(await button("Hide list").getAttribute("aria-expanded"), "true");
    await button("Hide list").click();
    await button("Show list").waitFor();
    assert.equal(await button("Show list").getAttribute("aria-expanded"), "false");
    assert.deepEqual(await boxOf("Show list"), [4, 4, 44, 44]);
    const away = await frame(page);
    assert.deepEqual([away.list, away.card], [null, [6, 52, 1428, 836]]);
    assert.equal(await places.count(), 0, "Search and the places are away with it");
    // The conversation is as it is beside its list: it has no way back to one.
    assert.equal(await button("All chats").count(), 0);
    // The plan's notice is in the strip, after the button.
    const notice = await page.getByRole("status").filter({ hasText: "ChatGPT plan" }).boundingBox();
    assert.deepEqual([notice?.x, notice?.y], [56, 6]);
    // Search still opens from its key.
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
    // It is kept: the page opens again as it was left, and Team's list is away as Chat's is.
    await kept(true);
    await page.goto(`${gateway.url}/#/team`);
    await page.reload();
    await button("Show list").waitFor();
    const details = page.getByRole("main").getByRole("heading", { level: 1 });
    await details.waitFor();
    assert.equal(await page.locator('main section[aria-label="Team"]').count(), 0);
    assert.equal(await details.count(), 1, "the agent's own heading alone");
    assert.equal(await places.count(), 0);
    await button("Show list").click();
    const team = page.locator('main section[aria-label="Team"]');
    await team.waitFor();
    assert.equal((await team.boundingBox())?.width, 300);
    await places.getByRole("button", { name: "Settings" }).waitFor();
    await kept(false);
    // Where a window draws its own buttons over the page's top left, their room is left: the
    // button is the first thing after it.
    await page.evaluate(() => document.documentElement.style.setProperty("--corner", "80px"));
    assert.deepEqual(await boxOf("Hide list"), [84, 4, 44, 44]);
    await page.close();
    page = await open(gateway, 800, 900, "#/chat");
    assert.equal(await page.getByRole("button", { name: /^(Hide|Show) list$/ }).count(), 0);
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
