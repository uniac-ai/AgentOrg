// The page's card, in a real browser over the stand-in gateway: wider than a phone, everything
// beside the bar in one card, 6 px from the bar and the window's edges, with a 1 px line, 10 px
// corners and a shadow that barely shows, on a ground a step darker. On a phone there is none.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

async function open(
  gateway: Gateway,
  width: number,
  height: number,
  hash = "#/chat",
): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await page.locator("main").waitFor();
  return page;
}
/** The card, the bar and the ground, read in one frame. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const box = (e: Element) =>
      Object.values(e.getBoundingClientRect().toJSON())
        .slice(0, 4)
        .map((n) => Math.round((n as number) * 100) / 100);
    const card = document.querySelector("main")?.parentElement as Element;
    const style = getComputedStyle(card);
    return {
      card: box(card),
      bar: box(document.querySelector('nav[aria-label="Main"]') as Element),
      line: `${style.borderTopWidth} ${style.borderTopColor}`,
      corners: style.borderTopLeftRadius,
      // The card's own shadow, the last of those its classes set.
      shadow: style.boxShadow.split(/,\s*(?=rgba?\()/).at(-1),
      fill: style.backgroundColor,
      ground: getComputedStyle(document.querySelector("[data-shell]") as Element).backgroundColor,
    };
  });

test(
  "wide, everything beside the bar is one card, 6 from the bar and the window's edges, with a thin line, 10 px corners and a shadow that barely shows, in dark and in light",
  withGateway(async (gateway) => {
    const page = await open(gateway, 1440, 900);
    const dark = await frame(page);
    assert.deepEqual(dark, {
      card: [68, 6, 1366, 888],
      bar: [0, 0, 62, 900],
      line: "1px rgba(255, 255, 255, 0.08)",
      corners: "10px",
      shadow: "rgba(0, 0, 0, 0.4) 0px 1px 2px 0px",
      fill: "rgb(25, 25, 25)",
      ground: "rgb(17, 17, 17)",
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const light = await frame(page);
    assert.deepEqual(
      [light.line, light.shadow, light.fill, light.ground],
      [
        "1px rgba(0, 0, 0, 0.07)",
        "rgba(0, 0, 0, 0.06) 0px 1px 2px 0px",
        "rgb(243, 243, 243)",
        "rgb(232, 232, 232)",
      ],
    );
    await page.close();
  }),
);

test(
  "on a phone there is no card: the content runs to the window's edges above the bar, with no line, corners or shadow, on the canvas, and the bar along the foot has its 1 px line",
  withGateway(async (gateway) => {
    const page = await open(gateway, 390, 844);
    const seen = () =>
      page.evaluate(() => {
        const card = document.querySelector("main")?.parentElement as Element;
        const style = getComputedStyle(card);
        const bar = getComputedStyle(document.querySelector('nav[aria-label="Main"]') as Element);
        return {
          card: Object.values(card.getBoundingClientRect().toJSON()).slice(0, 4),
          edges: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
          corners: style.borderTopLeftRadius,
          shadow: style.boxShadow,
          fill: style.backgroundColor,
          ground: getComputedStyle(document.querySelector("[data-shell]") as Element)
            .backgroundColor,
          barLine: `${bar.borderTopWidth} ${bar.borderTopColor}`,
        };
      });
    assert.deepEqual(await seen(), {
      card: [0, 0, 390, 788],
      edges: ["0px", "0px", "0px", "0px"],
      corners: "0px",
      shadow: "none",
      fill: "rgb(25, 25, 25)",
      ground: "rgb(25, 25, 25)",
      barLine: "1px rgba(255, 255, 255, 0.08)",
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const light = await seen();
    assert.deepEqual(
      [light.fill, light.ground, light.barLine],
      ["rgb(243, 243, 243)", "rgb(243, 243, 243)", "1px rgba(0, 0, 0, 0.07)"],
    );
    await page.close();
  }),
);
