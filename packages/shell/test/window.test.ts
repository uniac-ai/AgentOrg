// An agent's computer as a window in the layer: opened from Expand or from a chat, beside the
// chat, one at a time. Over the stand-in gateway.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { computer, startTerminals } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
/** An agent given a computer with a browser and a terminal. */
const withComputer = (gateway: Gateway, agent: string) =>
  computer(
    gateway,
    [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
    ],
    agent,
  );
async function open(gateway: Gateway, hash: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    withComputer(gateway, "a-research");
    withComputer(gateway, "a-reviewer");
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Wait for something the stand-in comes to hold. */
async function until(held: () => boolean, what: string) {
  for (const end = Date.now() + 4000; !held() && Date.now() < end; )
    await new Promise((done) => setTimeout(done, 25));
  assert.ok(held(), what);
}
const layerWindow = (page: Page) => page.getByRole("group", { name: "Window" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 100) / 100);
};
/** Research's first chat, open in the panel. */
async function researchChat(page: Page) {
  await page.getByRole("main").getByRole("tab", { name: "Chats" }).click();
  await page
    .getByRole("main")
    .getByRole("list", { name: "Chats with Research" })
    .getByRole("button")
    .first()
    .click();
  await panel(page).getByRole("button", { name: "Research's page" }).waitFor();
  // Once what was said in it is read.
  await panel(page).getByRole("log").locator(":scope > *").first().waitFor();
}

test(
  "Expand opens the computer as a window in the layer, in the room the chat leaves, and its own Close closes it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame.getByRole("button", { name: "Expand" }).click();
    const win = layerWindow(page);
    await win.getByRole("heading", { name: "Research's computer" }).waitFor();
    // From the inset to one gap short of the collapsed chat.
    assert.deepEqual(await boxOf(win), [20, 20, 1440 - 20 - 20 - 64 - 12, 860]);
    // There it is as large as it gets, says whose it is, and has its own Close.
    assert.equal(await win.getByRole("button", { name: "Expand" }).count(), 0);
    await win.getByRole("button", { name: "Close Research's computer" }).waitFor();
    // The browser, in front, is the one view it had: moved to the window, not opened again.
    await win.getByRole("group", { name: "Browser" }).waitFor();
    assert.equal(gateway.live.screens.size, 1);
    assert.equal(opened(gateway, "browser"), 1);
    // The window picked there is the one in front on its page too.
    await win
      .getByRole("navigation", { name: "Dock" })
      .getByRole("button", { name: "Terminal" })
      .click();
    await win
      .getByRole("group", { name: "Terminal" })
      .getByRole("tablist")
      .waitFor({ state: "attached" });
    await frame.getByRole("group", { name: "Terminal" }).waitFor();
    // A computer's views are one set: under its window, the page's frame holds a place and no
    // view. The browser, behind the terminal now, has none open: what it shows is on the computer.
    assert.equal(await frame.getByRole("tablist").count(), 0);
    await until(() => gateway.live.terminal.sockets.size === 1, "one terminal view");
    await until(() => gateway.live.screens.size === 0, "no browser view behind the terminal");
    // Opening the chat leaves it one gap short of the panel, and moves nothing of the chat.
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).waitFor();
    assert.deepEqual(await boxOf(win), [20, 20, 1440 - 20 - 20 - 420 - 12, 860]);
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    await win.getByRole("button", { name: "Close Research's computer" }).click();
    await win.waitFor({ state: "detached" });
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    // Closed, the same view is in the page's frame: none was opened for it.
    await frame.getByRole("button", { name: "Expand" }).waitFor();
    await frame
      .getByRole("group", { name: "Terminal" })
      .getByRole("tablist")
      .waitFor({ state: "attached" });
    assert.equal(gateway.live.terminal.sockets.size, 1);
    assert.equal(opened(gateway, "terminal"), 1, "the one terminal view, moved there and back");
    await page.close();
  }),
);

test(
  "a chat shows its agent's computer beside it and takes it away again; another agent's takes its place",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    await researchChat(page);
    const button = panel(page).getByRole("button", { name: "Research's computer" });
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    const said = await panel(page).innerText();
    await button.click();
    await layerWindow(page).getByRole("heading", { name: "Research's computer" }).waitFor();
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await panel(page).innerText(), said, "the chat stays as it is");
    await button.click();
    await layerWindow(page).waitFor({ state: "detached" });
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    // An agent with no computer has no such button.
    gateway.addChat("a-triage", { id: "c-route", title: "Route today's issues", said: [] });
    await page.goto(`${gateway.url}/#/a/a-triage`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats with Triage" })
      .getByRole("button")
      .first()
      .click();
    await panel(page).getByRole("button", { name: "Triage's page" }).waitFor();
    assert.equal(
      await panel(page)
        .getByRole("button", { name: /computer$/ })
        .count(),
      0,
    );
    // One window at a time: Reviewer's, opened from its chat, takes Research's place.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.goto(`${gateway.url}/#/a/a-research`);
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await layerWindow(page).getByRole("heading", { name: "Research's computer" }).waitFor();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("list")
      .getByRole("button", { name: /Reviewer/ })
      .first()
      .click();
    await panel(page).getByRole("button", { name: "Reviewer's computer" }).click();
    await layerWindow(page).getByRole("heading", { name: "Reviewer's computer" }).waitFor();
    assert.equal(await layerWindow(page).count(), 1);
    assert.equal(await layerWindow(page).getByRole("heading").count(), 1);
    await page.close();
  }),
);

test(
  "where the open chat leaves a window too little room they overlap, the one opened last on top; on a phone each takes the screen",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research", 1000);
    /** Which of the two is on top in the middle of the chat. */
    const onTop = () =>
      page.evaluate(() => {
        const at = document.elementFromPoint(1000 - 20 - 210, 450);
        return at?.closest('aside[aria-label="Chats"]')
          ? "chat"
          : at?.closest('[role="group"][aria-label="Window"]')
            ? "window"
            : "neither";
      });
    await researchChat(page);
    await panel(page).getByRole("button", { name: "Research's computer" }).click();
    const win = layerWindow(page);
    await win.getByRole("heading", { name: "Research's computer" }).waitFor();
    // The window runs to the inset, under or over the chat.
    assert.deepEqual(await boxOf(win), [20, 20, 960, 860]);
    assert.equal(await onTop(), "window");
    // It takes the keyboard when it opens, and its Close gives it back to what opened it.
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.equal(await focused(), "Window");
    // Its Close gives the chat back; collapsed and opened again over a window, the chat is on top.
    await win.getByRole("button", { name: "Close Research's computer" }).click();
    await win.waitFor({ state: "detached" });
    assert.equal(await focused(), "Research's computer");
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("main").getByRole("tab", { name: "Computer" }).click();
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await win.getByRole("navigation", { name: "Dock" }).waitFor();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).waitFor();
    assert.equal(await onTop(), "chat");
    await page.close();

    const phone = await open(gateway, "#/a/a-research", 390, 844);
    await phone.getByRole("main").getByRole("button", { name: "Expand" }).click();
    await layerWindow(phone).getByRole("navigation", { name: "Dock" }).waitFor();
    assert.deepEqual(await boxOf(layerWindow(phone)), [0, 0, 390, 844]);
    await layerWindow(phone).getByRole("button", { name: "Close Research's computer" }).click();
    await layerWindow(phone).waitFor({ state: "detached" });
    await phone.close();
  }),
);

/** Research with all three windows, and files to walk. */
function withFiles(gateway: Gateway) {
  computer(gateway, [
    { surface: "browser", protocol: "screencast@1", operate: true },
    { surface: "terminal", protocol: "terminal@1", operate: true },
    { surface: "files", protocol: "files@1", operate: true },
  ]);
  gateway.putFile("notes.txt", "Remember the milk.", 3);
  gateway.putFile("storefront/README.md", "# Storefront", 125);
  // More than a window shows at once, so the folder scrolls.
  for (let n = 10; n < 70; n++) gateway.putFile(`storefront/part-${n}.ts`, "export {};", 9);
}
const opened = (gateway: Gateway, surface: string) =>
  gateway.live.opened.filter((one) => one.surface === surface).length;
const where = (within: Locator) => within.getByRole("group", { name: "Folder" }).innerText();
/** How far down what scrolls in the window in front is: the windows behind it aren't seen. */
const scrolled = (within: Locator) =>
  within.evaluate((e) =>
    Math.max(
      ...[...e.querySelectorAll("*")]
        .filter((part) => part.scrollTop && part.checkVisibility({ visibilityProperty: true }))
        .map((part) => part.scrollTop),
      0,
    ),
  );
/** Turns the wheel over a part of a window, and says how far down the window then is. */
async function wheel(page: Page, within: Locator, over: Locator, by: number) {
  const was = await scrolled(within);
  await over.hover();
  await page.mouse.wheel(0, by);
  // Where it comes to rest, once it has moved: the same at three readings in a row.
  const read = [was];
  for (let tries = 0; tries < 80; tries++) {
    await page.waitForTimeout(100);
    read.push(await scrolled(within));
    const [a, b, c] = read.slice(-3);
    if (c !== was && a === b && b === c) return c as number;
  }
  throw new Error("the wheel moved nothing");
}

test(
  "a window is as it was left when another has been in front, and a file on its way goes on; the browser, behind, is closed",
  withGateway(async (gateway) => {
    withFiles(gateway);
    const large = Buffer.alloc(2_600_000, "0123456789abcdef");
    gateway.putFile("storefront/data.bin", large, 2);
    const said = Array.from({ length: 300 }, (_, n) => `built part ${n}\n`).join("");
    startTerminals(gateway, [
      { cmd: "npm run dev", running: true, said: `${said}ready on 4173\n` },
    ]);
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    const dock = frame.getByRole("navigation", { name: "Dock" });
    const files = frame.getByRole("group", { name: "Files" });
    const terminal = frame.getByRole("group", { name: "Terminal" });
    const lines = () => terminal.locator(".xterm-rows").innerText();
    const reads = () =>
      gateway.live.files.asked.filter((one) => one.type === "list" || one.type === "changed")
        .length;
    // The browser is in front first. Behind another window its view is closed.
    await until(() => gateway.live.screens.size === 1, "the browser's view");
    await dock.getByRole("button", { name: "Files" }).click();
    await until(() => gateway.live.screens.size === 0, "no browser view behind Files");
    await files.getByRole("button", { name: "storefront" }).click();
    const down = await wheel(page, files, files.getByRole("button", { name: /part-20/ }), 500);

    // The terminal comes in front, scrolled back. Files, behind it, isn't seen or reached.
    await dock.getByRole("button", { name: "Terminal" }).click();
    await terminal.getByText("ready on 4173").waitFor();
    assert.equal(await frame.getByRole("button", { name: /part-\d/ }).count(), 0);
    assert.equal(await frame.getByRole("button", { name: /part-20/ }).isVisible(), false);
    const back = await wheel(page, terminal, terminal.getByText("ready on 4173"), -1200);
    const read = await lines();
    assert.ok(!read.includes("ready on 4173"), "scrolled back past its last line");

    // Files comes back where it was: the folder, and as far down it.
    await dock.getByRole("button", { name: "Files" }).click();
    await files.getByRole("button", { name: /part-20/ }).waitFor();
    assert.equal(await where(files), "Research/storefront");
    assert.equal(await scrolled(files), down, "as far down the folder as it was");
    assert.equal(opened(gateway, "files"), 1, "the same view, not one opened again");

    // So does the terminal: the lines it showed, and the wheel goes on from there. Files is
    // unseen at once: nothing of the window behind eases out over the one in front.
    const seen = await page.evaluate(async () => {
      document
        .querySelector<HTMLElement>('main nav[aria-label="Dock"] button[aria-label="Terminal"]')
        ?.click();
      // How many Expands are seen at once, at most, over the frames in which it changes.
      let most = 0;
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(requestAnimationFrame);
        const now = [...document.querySelectorAll('main button[aria-label="Expand"]')].filter(
          (one) => getComputedStyle(one).visibility === "visible",
        ).length;
        most = Math.max(most, now);
      }
      return most;
    });
    assert.equal(seen, 1, "only one window's Expand is ever seen: the one in front");
    // Nothing unseen eases: a part that eased its way out of sight would stay seen meanwhile.
    const easing = await frame.evaluate(
      (within) =>
        [...within.querySelectorAll("*")].filter((one) => {
          const style = getComputedStyle(one);
          return (
            style.visibility === "hidden" &&
            style.transitionProperty !== "none" &&
            style.transitionDuration.split(",").some((time) => Number.parseFloat(time) > 0)
          );
        }).length,
    );
    assert.equal(easing, 0);
    await terminal.locator(".xterm-rows").waitFor();
    assert.equal(await lines(), read);
    assert.equal(await scrolled(terminal), back);
    const on = await wheel(page, terminal, terminal.locator(".xterm-rows"), -60);
    assert.ok(on < back && back - on < 200, "from where it was, not from the top");

    // A file on its way out goes on while another window is in front. Its first part is held
    // until the terminal is in front; the rest is asked for and saved from behind it.
    await dock.getByRole("button", { name: "Files" }).click();
    await files.getByRole("button", { name: /data\.bin/ }).click();
    gateway.live.files.reads = "held";
    await files.getByRole("button", { name: "Download" }).click();
    await until(() => gateway.live.files.parts.length === 1, "its first part to be asked for");
    await dock.getByRole("button", { name: "Terminal" }).click();
    await terminal.locator(".xterm-rows").waitFor();
    const before = reads();
    const saved = page.waitForEvent("download");
    gateway.endReads();
    const file = await saved;
    assert.equal(file.suggestedFilename(), "data.bin");
    assert.ok((await readFile(await file.path())).equals(large), "every byte, from behind");

    // Behind, it reads nothing again, however long; in front it does, and the file is still open.
    await page.waitForTimeout(6000); // Longer than a folder goes between readings.
    assert.equal(reads(), before, "nothing read again while it isn't seen");
    await dock.getByRole("button", { name: "Files" }).click();
    await until(() => reads() > before, "the folder to be read again in front");
    assert.equal(await where(files), "Research/storefront/data.bin");
    assert.equal(opened(gateway, "files"), 1);
    assert.equal(opened(gateway, "terminal"), 1, "the same terminal view throughout");

    // The browser is opened again when it is next in front.
    await dock.getByRole("button", { name: "Browser" }).click();
    await until(() => gateway.live.screens.size === 1, "the browser's view again");
    await page.close();
  }),
);

test(
  "opened in the layer a window is as it was left, its one view moved there and back, and leaving the computer closes it",
  withGateway(async (gateway) => {
    withFiles(gateway);
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame
      .getByRole("navigation", { name: "Dock" })
      .getByRole("button", { name: "Files" })
      .click();
    await frame.getByRole("button", { name: "storefront" }).click();
    await frame.getByRole("button", { name: /README\.md/ }).waitFor();
    const down = await wheel(page, frame, frame.getByRole("button", { name: /part-20/ }), 400);
    await frame.getByRole("button", { name: "Expand" }).click();
    const win = layerWindow(page);
    const files = win.getByRole("group", { name: "Files" });
    await files.getByRole("button", { name: /part-30/ }).waitFor();
    assert.equal(await where(files), "Research/storefront", "the folder it was in");
    assert.equal(await scrolled(files), down, "and as far down it");
    assert.equal(
      await win.getByRole("button", { name: "Expand" }).count(),
      0,
      "as large as it gets",
    );
    assert.equal(await frame.getByRole("button", { name: /part-30/ }).count(), 0);
    assert.equal(opened(gateway, "files"), 1, "the one view moved; none was opened");
    assert.equal(gateway.live.files.sockets.size, 1);
    assert.equal(opened(gateway, "browser"), 1, "none was opened for the browser, behind it");

    // Closed, it is back in the page's frame, as it was.
    await win.getByRole("button", { name: "Close Research's computer" }).click();
    await win.waitFor({ state: "detached" });
    await frame.getByRole("button", { name: /part-30/ }).waitFor();
    assert.equal(await where(frame), "Research/storefront");
    assert.equal(await scrolled(frame), down);
    await frame.getByRole("button", { name: "Expand" }).waitFor();
    assert.equal(opened(gateway, "files"), 1);

    // Leaving the computer closes its view: nothing is kept for a frame that isn't drawn.
    assert.equal(gateway.live.files.sockets.size, 1);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Home" })
      .click();
    await until(() => gateway.live.files.sockets.size === 0, "its view is closed");
    await page.close();
  }),
);
