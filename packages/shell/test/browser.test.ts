// The live browser (`screencast@1`) and the control log, over the stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
type Surface = { surface: string; protocol: string; operate: boolean; unavailable?: string };
const BROWSER: Surface = { surface: "browser", protocol: "screencast@1", operate: true };

function withSurfaces(gateway: Gateway, surfaces: Surface[]) {
  const research = gateway.agents.get("a-research") as Agent;
  research.units = [
    {
      instance: "i-computer",
      provider: "units",
      unit: "computer",
      title: "Computer",
      values: {},
      needs: {},
      status: { state: "connected", surfaces },
    },
  ];
}
async function open(gateway: Gateway, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
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
const until = async (check: () => boolean, what: string) => {
  for (let n = 0; n < 80 && !check(); n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), what);
};
const PAGE = 'canvas[aria-label="Page"]';
/** Where the page's picture is: it moves if any row of the frame above it changes height. */
/** The page's picture is drawn: its blue bar is there. */
const pictured = (page: Page) =>
  page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Page"]');
    if (!c || c.width !== 80) return false;
    const [r, , b] = c.getContext("2d")?.getImageData(30, 35, 1, 1).data ?? [];
    return (b ?? 0) > 150 && (r ?? 255) < 120;
  });
const box = (page: Page) =>
  page.locator(PAGE).evaluate((e) => JSON.stringify(e.getBoundingClientRect()));

test(
  "the browser opens to operate: a click, keys and an address reach the page",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.waitFor();
    await pictured(page);
    assert.equal(
      await frame.getByRole("tab", { name: "Checkout" }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await frame.getByLabel("Address").inputValue(), "https://shop.example/checkout");
    await frame.getByRole("button", { name: "Back" }).and(page.locator(":enabled")).waitFor();
    assert.deepEqual(
      gateway.live.opened.map((o) => o.mode),
      ["operate"],
      "one socket, opened to operate",
    );
    const before = await box(page);

    // A click lands where it was made, in the page's own pixels.
    const shown = await frame.locator(PAGE).boundingBox();
    assert.ok(shown);
    await page.mouse.click(shown.x + shown.width / 4, shown.y + shown.height / 2);
    await until(
      () => gateway.live.input.some((i) => i.type === "mouse" && i.action === "up"),
      "the click",
    );
    const down = gateway.live.input.find((i) => i.type === "mouse" && i.action === "down");
    assert.equal(down?.button, "left");
    assert.ok(
      Math.abs(Number(down?.x) - 200) < 4 && Math.abs(Number(down?.y) - 250) < 4,
      JSON.stringify(down),
    );

    assert.equal(await box(page), before, "your input moves nothing");

    await page.keyboard.type("ab");
    await page.keyboard.press("Enter");
    await until(
      () => gateway.live.input.some((i) => i.type === "key" && i.action === "up"),
      "Enter",
    );
    assert.deepEqual(
      gateway.live.input
        .filter((i) => i.type === "text" || i.type === "key")
        .map((i) => i.text ?? `${i.action} ${i.key}`),
      ["a", "b", "down Enter", "up Enter"],
    );

    // An address with no scheme is a site's, and the keys are the page's once it's sent.
    await frame.getByLabel("Address").fill("shop.example/cart");
    await frame.getByLabel("Address").press("Enter");
    await page.waitForFunction((at) => document.activeElement?.matches(at), PAGE);
    // Tab walks past the page, which would keep every key: only a click or an address goes in.
    await frame.getByLabel("Address").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate((at) => document.activeElement?.matches(at), PAGE), false);
    await frame.getByRole("button", { name: "Reload" }).click();
    await until(
      () => gateway.live.input.filter((i) => i.type === "navigate").length === 2,
      "navigate",
    );
    assert.deepEqual(
      gateway.live.input.filter((i) => i.type === "navigate").map((i) => i.to),
      ["https://shop.example/cart", "reload"],
    );
    assert.equal(
      gateway.live.input.filter((i) => i.type === "key").length,
      2,
      "the Enter that sent the address isn't the page's",
    );

    await page.close();
  }),
);

test(
  "the wheel is the page's once you've clicked in it, and until then scrolls what's around it",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    // Short enough that the agent's page scrolls.
    const page = await open(gateway, { width: 1440, height: 500 });
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.getByRole("button", { name: "Back" }).and(page.locator(":enabled")).waitFor();
    const scrolled = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("*")].reduce((sum, e) => sum + e.scrollTop, 0),
      );
    await frame.locator(PAGE).hover();
    const under = await scrolled();
    assert.ok(under > 0, "the frame is below the fold");

    await page.mouse.wheel(0, -30);
    await page.waitForFunction(
      (was) => [...document.querySelectorAll("*")].reduce((sum, e) => sum + e.scrollTop, 0) < was,
      under,
    );

    await frame.locator(PAGE).click();
    const held = await scrolled();
    await page.mouse.wheel(0, -30);
    await until(() => gateway.live.input.some((i) => i.action === "wheel"), "the wheel");
    assert.equal(gateway.live.input[0]?.action, "down", "nothing was sent before the click");
    await page.waitForTimeout(100);
    assert.equal(await scrolled(), held, "what's around the page stays where it is");
    await page.close();
  }),
);

test(
  "tabs are drawn as the service says, and New tab asks for one and shows it empty",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    const selected = (name: string) => frame.getByRole("tab", { name, selected: true }).waitFor();
    await selected("Checkout");
    const before = await box(page);

    // Until you pick one, the tab in front follows the newest.
    gateway.tabOpens({ id: 2, url: "https://docs.example/retries", title: "Retries" });
    await selected("Retries");
    assert.equal(await frame.getByLabel("Address").inputValue(), "https://docs.example/retries");

    await frame.getByRole("tab", { name: "Checkout" }).click();
    await selected("Checkout");
    assert.deepEqual(gateway.live.input.at(-1), { type: "tab", action: "show", id: 1 });

    await frame.getByRole("button", { name: "New tab", exact: true }).click();
    await until(() => gateway.live.tabs.length === 3, "your tab");
    assert.deepEqual(gateway.live.input.at(-1), { type: "tab", action: "open" });
    // Your new tab is in front, named as an empty one, with an empty address to type in.
    await selected("New tab");
    assert.equal(await frame.getByLabel("Address").inputValue(), "");

    // An address half typed belongs to its tab, also when the next tab is as empty.
    await frame.getByLabel("Address").fill("docs.example");
    await frame.getByRole("button", { name: "New tab", exact: true }).click();
    const front = (n: number) =>
      frame.getByRole("tab").nth(n).and(page.locator('[aria-selected="true"]')).waitFor();
    await front(3);
    assert.equal(await frame.getByLabel("Address").inputValue(), "");

    // The agent goes on in a tab of its own: it appears in the row and yours stays in front.
    gateway.tabOpens({ id: 5, url: "https://shop.example/cart", title: "Cart" });
    await frame.getByRole("tab", { name: "Cart" }).waitFor();
    await front(3);
    assert.equal(await box(page), before, "tabs coming and going move nothing");
    await page.close();
  }),
);

test(
  "the window's rows are where the design puts them: tabs with their Close and the plus, then the address",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.getByRole("tab", { name: "Checkout", selected: true }).waitFor();
    const origin = await frame.boundingBox();
    assert.ok(origin);
    /** A part's box from inside the window's edge. */
    const boxOf = async (part: Locator) => {
      const b = await part.boundingBox();
      assert.ok(b, `${part} is on the page`);
      const round = (n: number) => Math.round(n * 100) / 100;
      return {
        x: round(b.x - origin.x - 1),
        y: round(b.y - origin.y - 1),
        w: b.width,
        h: b.height,
      };
    };
    // A first row 44 tall: a tab 32 tall holding its name, then its Close, 20 across, 4 from its end.
    const tab = frame.getByRole("tab", { name: "Checkout" });
    const whole = await boxOf(tab.locator("xpath=.."));
    const close = await boxOf(frame.getByRole("button", { name: "Close Checkout" }));
    assert.deepEqual([whole.x, whole.y, whole.h], [8, 6, 32]);
    assert.deepEqual([close.y, close.w, close.h], [12, 20, 20]);
    assert.equal(Math.round((whole.x + whole.w - (close.x + close.w)) * 100) / 100, 4);
    assert.equal(await tab.evaluate((e) => getComputedStyle(e).fontSize), "13px");
    // The plus, 28 across, 4 after the tabs.
    const plus = await boxOf(frame.getByRole("button", { name: "New tab", exact: true }));
    assert.deepEqual(plus, {
      x: Math.round((whole.x + whole.w + 4) * 100) / 100,
      y: 8,
      w: 28,
      h: 28,
    });
    // A second row 40 tall: three buttons 28 across, 2 apart, then the address, 32 tall.
    const button = (name: string) => boxOf(frame.getByRole("button", { name }));
    assert.deepEqual(await button("Back"), { x: 8, y: 50, w: 28, h: 28 });
    assert.deepEqual(await button("Forward"), { x: 38, y: 50, w: 28, h: 28 });
    assert.deepEqual(await button("Reload"), { x: 68, y: 50, w: 28, h: 28 });
    const address = await boxOf(frame.getByLabel("Address"));
    assert.deepEqual([address.x, address.y, address.h], [102, 48, 32]);
    // Then the page, inset 8, with rounded corners.
    const pageArea = frame.locator('canvas[aria-label="Page"]').locator("xpath=..");
    const area = await boxOf(pageArea);
    assert.deepEqual([area.x, area.y], [8, 88]);
    assert.equal(await pageArea.evaluate((e) => getComputedStyle(e).borderTopLeftRadius), "10px");
    await page.close();
  }),
);

test(
  "every tab has a Close: it closes that tab and moves the ones after it up, and the last leaves no page",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    gateway.tabOpens({ id: 2, url: "https://docs.example/retries", title: "Retries" });
    gateway.tabOpens({ id: 3, url: "https://shop.example/cart", title: "Cart" });
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    const tab = (name: string) => frame.getByRole("tab", { name });
    const front = (name: string) => frame.getByRole("tab", { name, selected: true }).waitFor();
    const close = (name: string) => frame.getByRole("button", { name: `Close ${name}` }).click();
    await front("Cart");
    await pictured(page);
    assert.equal(await frame.getByRole("button", { name: /^Close / }).count(), 3);
    const at = async (name: string) => {
      const found = await tab(name).boundingBox();
      assert.ok(found, `${name} has a tab`);
      return found.x;
    };
    const [checkout, retries] = [await at("Checkout"), await at("Retries")];
    const before = await box(page);

    // One that isn't in front: it goes, the one before it stays, the one after takes its place.
    await close("Retries");
    await tab("Retries").waitFor({ state: "detached" });
    assert.equal(await at("Checkout"), checkout);
    assert.equal(await at("Cart"), retries);
    await front("Cart");
    assert.equal(await box(page), before, "the page under the tabs doesn't move");

    // The one in front, with two others left: the newest of them comes to the front.
    gateway.tabOpens({ id: 4, url: "https://docs.example/sessions", title: "Sessions" });
    await front("Sessions");
    await close("Sessions");
    await front("Cart");
    await close("Cart");
    await front("Checkout");

    // The last, while its page asks for a file: no tab, no address, nothing asked and no picture.
    gateway.screen({ type: "file-chooser", open: true, multiple: false });
    await frame.getByRole("dialog", { name: "The page asks" }).waitFor();
    await close("Checkout");
    await tab("Checkout").waitFor({ state: "detached" });
    assert.deepEqual(
      gateway.live.input.filter((i) => i.action === "close").map((i) => i.id),
      [2, 4, 3, 1],
    );
    assert.equal(await frame.getByRole("tab").count(), 0);
    assert.equal(await frame.getByLabel("Address").inputValue(), "");
    assert.equal(await frame.getByRole("dialog", { name: "The page asks" }).count(), 0);
    assert.ok(
      await frame.getByRole("button", { name: "Back" }).isDisabled(),
      "nowhere to go back in",
    );
    assert.equal(
      await frame.locator('canvas[aria-label="Page"]').evaluate((c: HTMLCanvasElement) => {
        const pixels = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data ?? [];
        return pixels.some((value) => value !== 0);
      }),
      false,
      "what the last tab looked like is gone",
    );

    // An address typed with no tab to go there in opens one, named by its site until it has a title.
    await frame.getByLabel("Address").fill("docs.example/start");
    await frame.getByLabel("Address").press("Enter");
    await front("docs.example");
    assert.deepEqual(gateway.live.input.at(-1), {
      type: "tab",
      action: "open",
      url: "https://docs.example/start",
    });
    assert.equal(await box(page), before, "nor when a tab comes back");
    await page.close();
  }),
);

test(
  "a browser you may only watch shows the page and what it asks, with nothing to press",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [{ ...BROWSER, operate: false }]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.getByRole("tab", { name: "Checkout" }).waitFor();
    assert.equal(gateway.live.opened.at(-1)?.mode, "watch");
    assert.ok(await frame.getByRole("button", { name: "Back" }).isDisabled());
    assert.ok(await frame.getByRole("tab", { name: "Checkout" }).isDisabled());
    assert.equal(await frame.getByRole("button", { name: "New tab", exact: true }).count(), 0);
    assert.equal(await frame.getByRole("button", { name: /^Close / }).count(), 0);

    gateway.screen({ type: "dialog", open: true, kind: "confirm", message: "Leave this page?" });
    const asks = frame.getByRole("dialog", { name: "The page asks" });
    await asks.getByText("Leave this page?").waitFor();
    assert.equal(await asks.getByRole("button").count(), 0, "a watcher can't answer");
    await page.close();
  }),
);

test(
  "what the page asks is answered in the frame",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.getByRole("button", { name: "Back" }).and(page.locator(":enabled")).waitFor();
    const asks = frame.getByRole("dialog", { name: "The page asks" });
    // The text over the page is the shell's, not the page's own dark on white.
    const shellText = await frame.evaluate((e) => getComputedStyle(e).color);

    gateway.screen({
      type: "dialog",
      open: true,
      kind: "prompt",
      message: "Your name?",
      defaultValue: "Sam",
    });
    assert.equal(await asks.evaluate((e) => getComputedStyle(e).color), shellText);
    await asks.getByLabel("Answer").fill("Sam Lee");
    await asks.getByRole("button", { name: "OK" }).click();
    await until(() => gateway.live.input.some((i) => i.type === "dialog"), "the answer");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "dialog"),
      {
        type: "dialog",
        accept: true,
        text: "Sam Lee",
      },
    );
    await asks.waitFor({ state: "detached" });

    gateway.screen({ type: "file-chooser", open: true, multiple: false });
    await asks.getByText("Choose a file").waitFor();
    await asks
      .getByLabel("Files")
      .setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await until(() => gateway.live.input.some((i) => i.type === "files"), "the file");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "files"),
      {
        type: "files",
        files: [
          { name: "a.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
        ],
      },
    );

    gateway.screen({
      type: "choice",
      multiple: true,
      options: [
        { value: "s", label: "Small", selected: true },
        { value: "m", label: "Medium", selected: false },
      ],
    });
    await asks.getByText("Medium").click();
    await asks.getByRole("button", { name: "Done" }).click();
    await until(() => gateway.live.input.some((i) => i.type === "choice"), "the choice");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "choice"),
      { type: "choice", values: ["s", "m"] },
    );

    // A list left open goes when another tab comes in front: it was the other page's.
    gateway.screen({
      type: "choice",
      multiple: false,
      options: [{ value: "s", label: "Small", selected: true }],
    });
    await asks.getByText("Small").waitFor();
    gateway.tabOpens({ id: 2, url: "https://docs.example/retries", title: "Retries" });
    await asks.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "a browser that can't open says why, in its frame",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [{ ...BROWSER, unavailable: "The browser isn't installed." }]);
    const page = await open(gateway);
    await page.getByText("The browser isn't installed.").waitFor();
    assert.equal(gateway.live.opened.length, 0);
    await page.close();
  }),
);

test(
  "the control log lists what agents did about this one, refusals with their reasons",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("status", { name: "Now" }).waitFor();
    assert.equal(
      await page.getByRole("region", { name: "Control" }).count(),
      0,
      "nothing yet, nothing shown",
    );
    gateway.controlled({
      at: new Date(Date.now() - 120_000).toISOString(),
      caller: "a-triage",
      tool: "agents_message",
      target: "a-research",
      outcome: "done",
    });
    gateway.controlled({
      at: new Date().toISOString(),
      caller: "a-research",
      tool: "agents_create",
      outcome: "refused",
      reason: "Its control doesn't allow creating agents.",
    });
    await page.reload();
    const log = page.getByRole("region", { name: "Control" });
    await log.getByText("Its control doesn't allow creating agents.").waitFor({ timeout: 12000 });
    const lines = await log.getByRole("listitem").allInnerTexts();
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^agents_create/);
    assert.match(lines[1] ?? "", /Triage agents_message Research/);
    await page.close();
  }),
);
