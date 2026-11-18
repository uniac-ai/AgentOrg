// What is left to set up, as a banner across the top of the app while the model is signed out: on
// every page, over the bar, at one height in every state, with no close; and its way in, which
// takes this tab to ChatGPT's page. Over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { computerWith } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
async function open(gateway: Gateway, hash = "#/", width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  // ChatGPT's page is answered here: nothing leaves this computer.
  await page
    .context()
    .route("https://auth.example/**", (route) => route.fulfill({ status: 200, body: "ChatGPT" }));
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const banner = (page: Page) => page.getByRole("region", { name: "Set up" });
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box, `${locator} is on the page`);
  return box;
};
const SENTENCE = "Agents can't work until you sign in with ChatGPT.";

test(
  "signed out, the banner is across the top of every page, over the bar, with its title and its way in; signed in, it is gone",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    for (const hash of ["#/", "#/a/a-reviewer", "#/chat", "#/team", "#/skills"]) {
      await page.evaluate((to) => {
        location.hash = to;
      }, hash);
      await banner(page).getByRole("heading", { name: "Sign in with ChatGPT" }).waitFor();
      await banner(page).getByRole("button", { name: "Continue with ChatGPT" }).waitFor();
      const top = await boxOf(banner(page));
      assert.deepEqual([top.x, top.y, top.width, top.height], [0, 0, 1440, 48], hash);
      const bar = await boxOf(page.getByRole("navigation", { name: "Main" }));
      assert.ok(bar.y >= 48, `${hash}: the bar starts below it`);
      // It is not in the page: the page is beside the bar, under it.
      assert.equal(await page.getByRole("main").getByRole("region", { name: "Set up" }).count(), 0);
      // The bar has no mark of its own for it: the banner is the one place.
      assert.equal(
        await page
          .getByRole("navigation", { name: "Main" })
          .locator('[class*="var(--warn)"]')
          .count(),
        0,
        `${hash}: no mark in the bar`,
      );
    }
    gateway.setAccount("signed_in");
    await banner(page).waitFor({ state: "detached" });
    const bar = await boxOf(page.getByRole("navigation", { name: "Main" }));
    assert.ok(bar.y < 48, "the page has the room back");
    await page.close();
  }),
);

test(
  "each state says its words in the banner at the same height: signed out, starting, waiting, not eligible, and a page that couldn't be opened",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out", false);
    const page = await open(gateway);
    const heights: number[] = [];
    const height = async () => heights.push((await boxOf(banner(page))).height);
    await banner(page).getByRole("button", { name: "ChatGPT is starting…" }).waitFor();
    await height();
    gateway.setAccount("signed_out");
    const way = banner(page).getByRole("button", { name: "Continue with ChatGPT" });
    await way.waitFor();
    await height();
    // A sign-in that doesn't start: one line says so, in the colour of something wrong.
    gateway.refuseNext("login.start", "unavailable", "Not answering.");
    await way.click();
    const said = banner(page).getByRole("alert");
    await said
      .getByText("ChatGPT's page couldn't be opened. Try again.", { exact: true })
      .waitFor();
    await height();
    // Waiting for ChatGPT: the same title, and the way in waits.
    const holding = gateway.hold("login.start");
    await way.click();
    const waiting = banner(page).getByRole("button", { name: "Waiting for ChatGPT…" });
    await waiting.waitFor();
    assert.equal(await waiting.isDisabled(), true);
    await banner(page).getByRole("heading", { name: "Sign in with ChatGPT" }).waitFor();
    // Pressed again, the line about ChatGPT's page went.
    assert.equal(await said.count(), 0);
    await height();
    gateway.setAccount("ineligible");
    await banner(page)
      .getByRole("heading", { name: "This ChatGPT account can't be used" })
      .waitFor();
    await banner(page).getByRole("button", { name: "Use another account" }).waitFor();
    await height();
    assert.deepEqual(heights, [48, 48, 48, 48, 48]);
    // The wait ended as the account said where it stands: the late answer goes nowhere.
    holding();
    await page.waitForTimeout(400);
    assert.ok(page.url().startsWith(gateway.url), "this tab stays in the app");
    await page.close();
  }),
);

test(
  "the banner has no close, and nothing on it puts it away",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    await banner(page).getByRole("button", { name: "Continue with ChatGPT" }).waitFor();
    assert.equal(await banner(page).getByRole("button").count(), 1);
    assert.equal(await banner(page).getByRole("link").count(), 0);
    await banner(page).getByRole("heading").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    assert.equal(await banner(page).count(), 1);
    await page.close();
  }),
);

test(
  "the way in takes this tab to the address the sign-in gave, and opens no other; one that isn't https isn't gone to",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    let page = await open(gateway);
    await banner(page).getByRole("button", { name: "Continue with ChatGPT" }).click();
    await page.waitForURL(/^https:\/\/auth\.example\/authorize/);
    assert.equal(page.context().pages().length, 1);
    assert.ok(
      gateway.calls.some(
        (c) =>
          c.slot === "login" &&
          c.method === "start" &&
          String(c.input.redirectUri).endsWith("/oauth/chatgpt"),
      ),
    );
    await page.close();

    gateway.authorizeAt("http://auth.example/authorize");
    page = await open(gateway);
    await banner(page).getByRole("button", { name: "Continue with ChatGPT" }).click();
    await banner(page).getByRole("alert").getByText("ChatGPT's page couldn't be opened").waitFor();
    assert.ok(page.url().startsWith(gateway.url), "this tab stays in the app");
    assert.equal(page.context().pages().length, 1);
    await page.close();
  }),
);

test(
  "the floating chat and the layer's window are below the banner, and Reconnecting… is at the foot as before",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    computerWith(gateway, "terminal");
    const page = await open(gateway, "#/a/a-research");
    const below = async (part: Locator, what: string) =>
      assert.ok((await boxOf(part)).y >= 48, `${what} starts below the banner`);
    await banner(page).waitFor();
    await below(page.getByRole("group", { name: "Chats, collapsed" }), "the chat's button");
    await page.getByRole("button", { name: /^Chats/ }).click();
    await below(page.getByRole("complementary", { name: "Chats" }), "the chat's panel");
    await page.getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await below(page.getByRole("group", { name: "Window" }), "the layer's window");
    gateway.goAway();
    const notice = page.getByRole("status").filter({ hasText: "Reconnecting…" });
    await notice.waitFor();
    const box = await boxOf(notice);
    assert.equal(box.y + box.height, 900 - 20, "an inset from the foot");
    gateway.goAway(false);
    await page.close();
  }),
);

test(
  "on a phone the banner fits: its title on two lines beside the way in, whole, and nothing scrolls sideways",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway, "#/", 390);
    const way = banner(page).getByRole("button", { name: "Continue with ChatGPT" });
    await way.waitFor();
    const title = await boxOf(banner(page).getByRole("heading", { name: "Sign in with ChatGPT" }));
    assert.equal(Math.round(title.height), 36, "two lines of 18");
    const button = await boxOf(way);
    assert.ok(button.x >= 0 && button.x + button.width <= 390, "the way in is whole");
    assert.equal(Math.round(button.width), 196);
    assert.equal((await boxOf(banner(page))).height, 48);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  }),
);

test(
  "the page the app opens on has no card for it, and a signed-out agent's line says why it can't work with no Set up",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
    assert.equal(await page.getByRole("main").getByRole("region", { name: "Set up" }).count(), 0);
    await page.evaluate(() => {
      location.hash = "#/a/a-reviewer";
    });
    const state = page.getByRole("main").getByRole("status", { name: "State" });
    await state.getByText(SENTENCE).waitFor();
    assert.equal(await state.getByRole("button").count(), 0);
    await page.close();
  }),
);
