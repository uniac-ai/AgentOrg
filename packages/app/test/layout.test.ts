import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { chromium, type Page } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

// dist/test/layout.test.js → this package's test sources.
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test");

/** The person, through the CLI's way in. */
function personOf(app: App, token: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const opened = new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data));
    waiting.get(reply.id)?.(reply);
  });
  return {
    close: () => socket.close(),
    async call<T = Record<string, unknown>>(slot: string, method: string, input: unknown = {}) {
      await opened;
      const reply = await new Promise<{ result?: unknown; error?: unknown }>((done) => {
        waiting.set(++id, done);
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    },
  };
}

const frameHeight = (page: Page, title: string) =>
  page
    .locator(`[aria-label="${title}"] iframe`)
    .evaluate((frame) => Math.round(frame.getBoundingClientRect().height));
/** In a placement's frame: how its document sits in it, and what the base styles drew. */
const inFrame = <T>(page: Page, title: string, read: () => T) =>
  page.frameLocator(`[aria-label="${title}"] iframe`).locator("html").evaluate(read);
/** The frame's height, and its document's and body's, which fill it. */
const filled = () => [
  innerHeight,
  Math.round(document.documentElement.getBoundingClientRect().height),
  Math.round(document.body.getBoundingClientRect().height),
];

test("a widget fills its placement whatever its content, on base styles its own rules outrank, and the column beside an agent is the person's to size", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-layout-")));
  const home = join(dir, "home");
  const app = await startApp({ home, firstRun: false });
  const person = personOf(app, readFileSync(join(home, "cli-token"), "utf8").trim());
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    person.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const built = await buildPackage(join(here, "fixtures", "fill"), { out: join(dir, "out") });
  const { hash } = await person.call<{ hash: string }>("packages", "add", { path: built.file });
  const actor = async (name: string) =>
    (await person.call<{ actorId: string }>("actors", "create", { name, package: hash })).actorId;
  const writer = await actor("Writer");
  const alone = await actor("Alone");
  for (const [module, title] of [
    ["tall", "Reading list"],
    ["plain", "Today"],
    ["quiet", "Quiet"],
  ] as const)
    await person.call("layout", "place", { actor: writer, module, title });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  await page.goto(`${app.url}/#/a/${encodeURIComponent(writer)}`);
  const aside = page.getByRole("complementary", { name: "Placed beside this agent" });
  await page
    .frameLocator('[aria-label="Today"] iframe')
    .getByRole("button", { name: "Add" })
    .waitFor();
  await page.frameLocator('[aria-label="Reading list"] iframe').getByText("Tall line 14").waitFor();

  // Every frame is its placement's height (the body's 260 px less its padding), whatever it
  // draws: fourteen lines, a few controls, or nothing. Its document and body fill it.
  const placement = 260 - 18;
  for (const title of ["Reading list", "Today", "Quiet"]) {
    assert.equal(await frameHeight(page, title), placement, title);
    assert.deepEqual(await inFrame(page, title, filled), [placement, placement, placement], title);
  }
  // Content that grows scrolls inside its frame: the frame keeps its height, nothing below moves.
  const below = () =>
    aside.locator('[aria-label="Today"]').evaluate((el) => el.getBoundingClientRect().top);
  const before = await below();
  await page.frameLocator('[aria-label="Reading list"] iframe').getByText("Tall line 14").click();
  await page.frameLocator('[aria-label="Reading list"] iframe').getByText("Tall line 15").waitFor();
  assert.equal(await frameHeight(page, "Reading list"), placement);
  assert.equal(await below(), before);
  assert.deepEqual(
    await inFrame(page, "Reading list", () => [
      document.body.scrollHeight,
      document.body.clientHeight,
      getComputedStyle(document.body).overflowY,
      getComputedStyle(document.body).scrollbarWidth,
    ]),
    [15 * 24, placement, "auto", "none"],
  );

  // Plain HTML on the base styles, in the shell's tokens, on a transparent document; the view's
  // own rule outranks them.
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => {
      const probe = document.createElement("i");
      probe.style.color = style.getPropertyValue(name);
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    return { accent: color("--accent"), raised: color("--raised"), fg: color("--fg") };
  });
  assert.deepEqual(
    await inFrame(page, "Today", () => {
      const of = (selector: string) =>
        getComputedStyle(document.querySelector(selector) as Element);
      return {
        page: of("html").backgroundColor,
        body: of("body").backgroundColor,
        text: of("body").color,
        submit: of("button[type=submit]").backgroundColor,
        item: of("li").backgroundColor,
        own: of(".own").backgroundColor,
      };
    }),
    {
      page: "rgba(0, 0, 0, 0)",
      body: "rgba(0, 0, 0, 0)",
      text: tokens.fg,
      submit: tokens.accent,
      item: tokens.raised,
      own: "rgb(1, 2, 3)",
    },
  );

  // The handle: dragged left, the column widens; bounded; kept in this browser.
  const handle = page.getByRole("separator", { name: "Resize the widgets" });
  const width = () => aside.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert.equal(await width(), 340);
  const main = page.locator(".container.main");
  const boxes = async () => JSON.stringify([await main.boundingBox(), await aside.boundingBox()]);
  const still = await boxes();
  await handle.hover();
  assert.equal(await boxes(), still, "hovering the handle moves nothing");
  const box = await handle.boundingBox();
  assert.ok(box);
  const dragBy = async (dx: number) => {
    const y = box.y + 200;
    const x = (await handle.boundingBox())?.x ?? 0;
    await page.mouse.move(x + 4, y);
    await page.mouse.down();
    await page.mouse.move(x + 4 + dx, y, { steps: 5 });
    await page.mouse.up();
  };
  await dragBy(-120);
  assert.equal(await width(), 460);
  assert.equal(await handle.getAttribute("aria-valuenow"), "460");
  await dragBy(-1000);
  assert.equal(await handle.getAttribute("aria-valuenow"), "640");
  await dragBy(1000);
  assert.equal(await handle.getAttribute("aria-valuenow"), "280");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await width(), 296);
  await page.reload();
  await aside.locator('[aria-label="Reading list"] iframe').waitFor();
  assert.equal(await width(), 296);

  // An agent with nothing beside it: no column, no handle, and the chat takes the stage.
  await page.goto(`${app.url}/#/a/${encodeURIComponent(alone)}`);
  await page.locator('[aria-label="Alone"] iframe').waitFor();
  assert.equal(await aside.isVisible(), false);
  assert.equal(await handle.count(), 0);
  const stage = await page.locator(".stage").boundingBox();
  assert.equal(Math.round((await main.boundingBox())?.width ?? 0), Math.round(stage?.width ?? -1));

  // Home's placements fill the same way.
  await page.goto(`${app.url}/#/`);
  await page
    .frameLocator('[aria-label="Today"] iframe')
    .getByRole("button", { name: "Add" })
    .waitFor();
  for (const title of ["Reading list", "Today", "Quiet"])
    assert.deepEqual(await inFrame(page, title, filled), [placement, placement, placement], title);
});
