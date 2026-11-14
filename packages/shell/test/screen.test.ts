// This computer's screen, a window of the agent's computer: in a real browser over the stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computer, sampleAgents } from "./design/samples.ts";
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
async function open(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  return page;
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let n = 0; n < 100 && !(await check()); n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await check(), what);
}

/** A PNG of one colour, as the service sends a frame. */
function png(width: number, height: number, [r, g, b]: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Research's computer, this one, with its browser, its screen, its terminal and its files. */
const withScreen = (gateway: Gateway) =>
  computer(gateway, [
    { surface: "browser", protocol: "screencast@1", operate: true },
    { surface: "screen", protocol: "screen@1", operate: true },
    { surface: "terminal", protocol: "terminal@1", operate: true },
    { surface: "files", protocol: "files@1", operate: true },
  ]);
const frame = (page: Page) => page.getByRole("main").getByRole("region", { name: /computer$/ });
const dock = (page: Page) => frame(page).getByRole("navigation", { name: "Dock" });
const screen = (page: Page) => frame(page).getByRole("img", { name: "Your screen" });
const opened = (gateway: Gateway) => gateway.live.opened.filter((o) => o.surface === "screen");

test(
  "the screen is a window of its own, second in the dock, watched only, its picture whole and centred in its own shape",
  withGateway(async (gateway) => {
    withScreen(gateway);
    gateway.screenFrame(png(160, 100, [40, 80, 160]), 160, 100);
    const page = await open(gateway);
    await dock(page).waitFor();
    assert.deepEqual(
      await dock(page)
        .getByRole("button")
        .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))),
      ["Browser", "Screen", "Terminal", "Files"],
    );
    await dock(page).getByRole("button", { name: "Screen" }).click();
    await frame(page).getByText("Your screen", { exact: true }).waitFor();
    await until(
      async () => (await screen(page).evaluate((c: HTMLCanvasElement) => c.width)) === 160,
      "the frame is drawn",
    );
    // Its surface may be operated, but it is opened to watch: nothing is sent from it yet.
    assert.deepEqual(
      opened(gateway).map((o) => o.mode),
      ["watch"],
    );
    // Whole, in its own shape, and in the middle of the window's room for it.
    const picture = await screen(page).boundingBox();
    const room = await screen(page).evaluate((c) => {
      const r = (c.parentElement as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert.ok(picture);
    assert.ok(Math.abs(picture.width / picture.height - 1.6) < 0.01, "its own shape");
    assert.ok(Math.abs(picture.x + picture.width / 2 - (room.x + room.width / 2)) < 1, "centred");
    assert.ok(Math.abs(picture.y + picture.height / 2 - (room.y + room.height / 2)) < 1, "centred");
    assert.ok(picture.width <= room.width + 0.5 && picture.height <= room.height + 0.5, "whole");
    // A new picture, of another size, takes its place.
    gateway.screenFrame(png(100, 100, [200, 60, 60]), 100, 100);
    await until(
      async () => (await screen(page).evaluate((c: HTMLCanvasElement) => c.width)) === 100,
      "the new frame is drawn",
    );
    await page.close();
  }),
);

test(
  "the screen is watched only while its window is in front, and closed it says so and opens again",
  withGateway(async (gateway) => {
    withScreen(gateway);
    gateway.screenFrame(png(160, 100, [40, 80, 160]), 160, 100);
    const page = await open(gateway);
    await dock(page).getByRole("button", { name: "Screen" }).click();
    await until(() => gateway.live.screen.sockets.size === 1, "watched in front");
    await dock(page).getByRole("button", { name: "Terminal" }).click();
    await until(() => gateway.live.screen.sockets.size === 0, "not watched behind");
    await dock(page).getByRole("button", { name: "Screen" }).click();
    await until(() => gateway.live.screen.sockets.size === 1, "watched again in front");
    for (const ws of gateway.live.screen.sockets) ws.close(1001, "It stopped.");
    await frame(page).getByText("It stopped.").waitFor();
    await frame(page).getByRole("button", { name: "Open again" }).click();
    await until(
      () => opened(gateway).length === 3 && gateway.live.screen.sockets.size === 1,
      "opened again",
    );
    await page.close();
  }),
);

test(
  "who acted on the screen has a Screen line in In use, now that it is a window",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    computer(gateway, [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "screen", protocol: "screen@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
      { surface: "presence", protocol: "presence@1", operate: false },
    ]);
    const page = await open(gateway);
    const inUse = page.getByRole("main").getByRole("region", { name: "In use" });
    await inUse.waitFor();
    gateway.presence([
      { who: "agent", name: "Research", capability: "screen" },
      { who: "agent", name: "Research", capability: "browser" },
    ]);
    await until(async () => (await inUse.innerText()).includes("Screen"), "a Screen line");
    assert.deepEqual(
      await inUse.evaluate((section) =>
        [...section.children].slice(1).map((line) => (line as HTMLElement).innerText.split("\n")),
      ),
      [
        ["Browser", "Research"],
        ["Screen", "Research"],
      ],
    );
    await page.close();
  }),
);
