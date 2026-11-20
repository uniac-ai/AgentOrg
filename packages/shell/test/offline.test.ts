// Out of reach, in a real browser over the stand-in gateway: one steady notice centred at the top,
// over the whole screen under a gradual blur that holds every cursor event; pointed at, its refresh
// mark; pressed, a try at once, said while it runs; and gone once the service is back.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

const WIDTH = 1440;
const HEIGHT = 900;
async function open(gateway: Gateway, hash = "#/chat"): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const notice = (page: Page) =>
  page.getByRole("status").filter({ hasText: /You're offline|Reconnecting/ });
const button = (page: Page) => page.getByRole("button", { name: "You're offline. Check again" });
/** The refresh mark's drawn width, in the notice: 0 while hidden. */
const mark = (page: Page) =>
  notice(page).evaluate(
    (root) => root.querySelector("button span")?.getBoundingClientRect().width ?? null,
  );
/** Waits for what the page or the stand-in will come to. */
async function until(read: () => boolean | Promise<boolean>, what: string) {
  for (let tries = 0; !(await read()); tries++) {
    assert.ok(tries < 400, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

test(
  'out of reach, the notice says "You\'re offline", steady and centred at the top, and the whole page is under the blur, inert',
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("main").waitFor();
    gateway.goAway();
    await notice(page).waitFor();
    const seen = await page.evaluate(() => {
      const status = document.querySelector('button[aria-label^="You\'re offline"]')
        ?.parentElement as HTMLElement;
      const box = status.getBoundingClientRect();
      const cover = document.querySelector("[data-offline-cover]") as HTMLElement;
      const blurred = [...cover.querySelectorAll("div")].filter((layer) =>
        getComputedStyle(layer).backdropFilter.startsWith("blur("),
      ).length;
      return {
        words: status.textContent?.trim(),
        middle: Math.round(box.x + box.width / 2),
        top: Math.round(box.y),
        turning: document.querySelectorAll(".animate-spin").length,
        cover: [...Object.values(cover.getBoundingClientRect().toJSON())].slice(0, 4),
        blurred: blurred > 0,
        inert: !!document.querySelector("main")?.closest("[inert]"),
      };
    });
    assert.deepEqual(seen, {
      words: "You're offline",
      middle: WIDTH / 2,
      top: 20,
      turning: 0,
      cover: [0, 0, WIDTH, HEIGHT],
      blurred: true,
      inert: true,
    });
    await page.close();
  }),
);

test(
  "pointed at, the notice shows its refresh mark at its start",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("main").waitFor();
    gateway.goAway();
    await button(page).waitFor();
    await page.mouse.move(5, HEIGHT - 5);
    assert.equal(await mark(page), 0);
    await button(page).hover();
    await until(async () => (await mark(page)) === 14, "the mark");
    await page.close();
  }),
);

test(
  "pressed, it tries at once, before the backoff's wait ends",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("main").waitFor();
    const before = gateway.tries();
    gateway.goAway();
    // Refused four times over, the client waits its longest, five seconds, before it tries again.
    await until(() => gateway.tries() >= before + 4, "four tries refused");
    const refused = Date.now();
    await button(page).waitFor();
    const waited = gateway.tries();
    await button(page).click();
    await until(() => gateway.tries() > waited, "a try");
    // Well before the client's own next try, five seconds after the last refused.
    const after = Date.now() - refused;
    assert.ok(after < 4500, `tried ${after} ms after the last refused try`);
    await page.close();
  }),
);

test(
  'while a try it asked for runs, it says "Reconnecting…" with no mark and nothing turning; still out of reach, "You\'re offline" again',
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("main").waitFor();
    // Each try is held open until the test lets it go: the press joins a try already going on, so a
    // try closed on a timer could end between finding the words and reading them.
    gateway.goAway(true, 60_000);
    await button(page).waitFor();
    await button(page).click();
    const running = page.getByRole("button", { name: "Reconnecting" });
    await running.waitFor();
    const seen = await running.evaluate((b) => ({
      words: b.textContent?.trim(),
      busy: b.getAttribute("aria-busy"),
      marks: b.querySelectorAll("svg").length,
      turning: [...b.querySelectorAll("*")].filter(
        (e) => getComputedStyle(e).animationName !== "none",
      ).length,
    }));
    assert.deepEqual(seen, { words: "Reconnecting…", busy: "true", marks: 0, turning: 0 });
    // Let go, the try is refused, and every try after it at once.
    gateway.goAway();
    await button(page).waitFor();
    assert.equal((await notice(page).innerText()).trim(), "You're offline");
    await page.close();
  }),
);

test(
  "back in reach, the notice and the blur go, and the page takes presses again",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("main").waitFor();
    gateway.goAway();
    await button(page).waitFor();
    // Back, the client's own next try reaches it, within its longest wait.
    gateway.goAway(false);
    await notice(page).waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await page.locator("[data-offline-cover]").count(), 0);
    // The page is no longer inert (a hidden scroll-to-end button is, as its library makes it).
    assert.equal(await page.locator("main").evaluate((main) => !!main.closest("[inert]")), false);
    await page.close();
  }),
);

test(
  "out of reach before sign-in has loaded, the page says the same",
  withGateway(async (gateway) => {
    gateway.goAway();
    const page = await open(gateway);
    await notice(page).waitFor();
    assert.equal((await notice(page).innerText()).trim(), "You're offline");
    await page.locator("[data-offline-cover]").waitFor({ state: "attached" });
    gateway.goAway(false);
    await page.getByRole("main").waitFor({ timeout: 15_000 });
    await notice(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "under the blur, a press, a double press, the wheel and the right button reach nothing on the page",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const box = page.getByRole("textbox", { name: "Message" }).last();
    await box.waitFor();
    const at = await box.boundingBox();
    assert.ok(at);
    gateway.goAway();
    await button(page).waitFor();
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { heard: string[] }).heard = heard;
      for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"])
        document
          .querySelector("[data-shell]")
          ?.addEventListener(type, () => heard.push(type), true);
    });
    const x = at.x + 20;
    const y = at.y + 10;
    await page.mouse.click(x, y);
    await page.mouse.dblclick(x, y);
    await page.mouse.click(x, y, { button: "right" });
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -400);
    const seen = await page.evaluate(
      ([px, py]) => ({
        heard: (window as unknown as { heard: string[] }).heard,
        on: document.elementFromPoint(px as number, py as number)?.closest("[data-offline-cover]")
          ? "cover"
          : "page",
        // The browser's own menu doesn't open over it either.
        menu: (() => {
          const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          document.elementFromPoint(px as number, py as number)?.dispatchEvent(e);
          return e.defaultPrevented ? "held" : "open";
        })(),
      }),
      [x, y],
    );
    assert.deepEqual(seen, { heard: [], on: "cover", menu: "held" });
    await page.close();
  }),
);
