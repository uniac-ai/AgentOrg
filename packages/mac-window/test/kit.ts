// What the tests share: the built page served as the app's window would show it, and a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";

const DIST = new URL("../dist/", import.meta.url);
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

/** The page's folder over http, as the app's dev mode serves it. */
export async function serve() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://page").pathname.replace(/^\/$/, "/index.html");
    try {
      const body = readFileSync(new URL(`.${path}`, DIST));
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

let launched: Browser;
let page: Awaited<ReturnType<typeof serve>>;
/** A browser and the served page for the file that calls this, closed after its tests. */
export function withBrowser() {
  test.before(async () => {
    [launched, page] = await Promise.all([chromium.launch(), serve()]);
  });
  test.after(async () => {
    await launched.close();
    page.close();
  });
}

/** The window in one of the stand-in's states, at the design's width, with `init` run before the
 * page's own scripts. */
export async function open(
  state: string,
  options: { reducedMotion?: "reduce"; init?: () => void } = {},
) {
  const context = await launched.newContext({
    viewport: { width: 460, height: 700 },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const tab: Page = await context.newPage();
  tab.setDefaultTimeout(8000);
  if (options.init) await tab.addInitScript(options.init);
  await tab.goto(`${page.url}/?state=${state}`);
  return tab;
}

export const card = (tab: Page, title: string) => tab.getByRole("region", { name: title });
/** A card's line under its title, and whether it is in warn. */
export const line = (tab: Page, title: string) =>
  card(tab, title)
    .locator("span.text-\\[13px\\]")
    .first()
    .evaluate((el) => ({
      words: el.textContent,
      warn: el.classList.contains("text-[var(--warn)]"),
    }));

/** Read until it reads as expected, or say what it read last. */
export async function until<T>(read: () => Promise<T>, expected: T, ms = 6000) {
  const end = Date.now() + ms;
  let now = await read();
  while (JSON.stringify(now) !== JSON.stringify(expected) && Date.now() < end) {
    await new Promise((done) => setTimeout(done, 100));
    now = await read();
  }
  assert.deepEqual(now, expected);
}
