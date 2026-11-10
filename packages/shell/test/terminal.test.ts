// The computer's terminals on one surface (`terminal@1`), over the stand-in's `/live`.
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
const AT = "2026-11-10T10:00:00Z";

/** Research's computer, with its terminals to operate or only to watch. */
function withTerminals(gateway: Gateway, operate = true) {
  const research = gateway.agents.get("a-research") as Agent;
  research.units = [
    {
      instance: "i-computer",
      provider: "units",
      unit: "computer",
      title: "Computer",
      values: {},
      needs: {},
      status: {
        state: "connected",
        surfaces: [{ surface: "terminal", protocol: "terminal@1", operate }],
      },
    },
  ];
  // One command that ended, and one the agent left running.
  const start = (id: string, cmd: string) =>
    gateway.terminal({
      type: "start",
      id,
      by: "agent",
      cmd,
      workdir: "/work/app",
      tty: false,
      at: AT,
    });
  start("c1", "npm ci");
  gateway.terminal({ type: "output", id: "c1", stream: "stdout", text: "added 812 packages\n" });
  gateway.terminal({ type: "exit", id: "c1", exitCode: 0, at: AT });
  start("c2", "npm run dev");
  gateway.terminal({ type: "output", id: "c2", stream: "stdout", text: "ready on :4173\n" });
  return start;
}
async function open(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
const round2 = (n: number) => Math.round(n * 100) / 100;
const pane = (page: Page) => page.getByRole("group", { name: "Terminals" });
/** The terminal in front says this. */
const says = (page: Page, text: string) =>
  page.waitForFunction(
    (wanted) =>
      document
        .querySelector('[aria-label="Terminals"] .xterm-rows')
        ?.textContent?.replaceAll("\u00a0", " ")
        .includes(wanted),
    text,
  );
const front = (page: Page, name: string) =>
  pane(page).getByRole("tab", { name, selected: true }).waitFor();
const until = async (check: () => boolean, what: string) => {
  for (let n = 0; n < 80 && !check(); n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), what);
};
const sent = (gateway: Gateway, type: string) =>
  gateway.live.terminal.input.filter((input) => input.type === type);

test(
  "every terminal has a tab, earlier ones replayed, and the newest is in front until you pick one",
  withGateway(async (gateway) => {
    const start = withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    assert.deepEqual(await pane(page).getByRole("tab").allInnerTexts(), ["npm ci", "npm run dev"]);
    await says(page, "$ npm run dev");
    await says(page, "ready on :4173");
    assert.equal(await pane(page).getByLabel("Folder").innerText(), "/work/app");
    // What still runs says so on its tab; what ended says nothing.
    const running = (name: string) =>
      pane(page).getByRole("tab", { name }).getByRole("img", { name: "Running" }).count();
    assert.deepEqual([await running("npm ci"), await running("npm run dev")], [0, 1]);
    const box = () =>
      pane(page)
        .locator(".xterm-host")
        .evaluate((e) => JSON.stringify(e.getBoundingClientRect()));
    const before = await box();

    start("c3", "npm test");
    await front(page, "npm test");
    await pane(page).getByRole("tab", { name: "npm ci" }).click();
    await front(page, "npm ci");
    await says(page, "added 812 packages");
    // Picked, it stays in front: a new one takes its tab and no more.
    start("c4", "git status");
    await pane(page).getByRole("tab", { name: "git status" }).waitFor();
    await front(page, "npm ci");
    // What a terminal writes after its exit is still its own.
    gateway.terminal({ type: "output", id: "c1", stream: "stderr", text: "late warning\n" });
    await says(page, "late warning");
    assert.equal(await box(), before, "tabs coming and going move nothing");
    await page.close();
  }),
);

test(
  "the window's rows are where the design puts them: tabs with the plus, where it is, then the terminal",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    const origin = await pane(page).boundingBox();
    assert.ok(origin);
    /** A part's box from the window's top left, as [x, y, width, height]. */
    const boxOf = async (part: Locator) => {
      const box = await part.boundingBox();
      assert.ok(box, `${part} is on the page`);
      return {
        x: round2(box.x - origin.x),
        y: round2(box.y - origin.y),
        w: round2(box.width),
        h: round2(box.height),
      };
    };
    const tabs = pane(page).getByRole("tab");
    // A first row 44 tall: tabs 32 tall and 4 apart, then the plus, 28 across.
    const [first, second] = [await boxOf(tabs.nth(0)), await boxOf(tabs.nth(1))];
    assert.deepEqual([first.x, first.y, first.h], [8, 6, 32]);
    assert.deepEqual([second.x, second.y, second.h], [round2(first.x + first.w + 4), 6, 32]);
    // The mark of what runs is 12 across. It turns, so its own size is read, not its box.
    assert.deepEqual(
      await tabs
        .nth(1)
        .getByRole("img", { name: "Running" })
        .evaluate((e) => [getComputedStyle(e).width, getComputedStyle(e).height]),
      ["12px", "12px"],
    );
    const plus = await boxOf(pane(page).getByRole("button", { name: "New terminal" }));
    assert.deepEqual(plus, { x: round2(second.x + second.w + 4), y: 8, w: 28, h: 28 });
    // A second row 40 tall, holding the folder 32 tall, inset 8.
    const folder = await boxOf(pane(page).getByLabel("Folder"));
    assert.deepEqual([folder.x, folder.y, folder.h], [8, 48, 32]);
    // Then the terminal, in 12.5px type on lines of 19.
    const host = await boxOf(pane(page).locator(".xterm-host"));
    assert.deepEqual([host.x, host.y], [0, 84]);
    assert.deepEqual(
      await pane(page)
        .locator(".xterm-rows")
        .evaluate((rows) => [
          getComputedStyle(rows).fontSize,
          (rows.children[0] as HTMLElement).getBoundingClientRect().height,
        ]),
      ["12.5px", 19],
    );
    assert.equal(await tabs.nth(1).evaluate((e) => getComputedStyle(e).fontSize), "13px");
    await page.close();
  }),
);

test(
  "the plus opens a shell of your own in front, at the viewer's size, and it takes your typing",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    await pane(page).getByRole("button", { name: "New terminal" }).click();
    await front(page, "zsh");
    const [asked] = sent(gateway, "open");
    assert.ok(Number(asked?.columns) > 20 && Number(asked?.rows) > 5, JSON.stringify(asked));
    await says(page, "work $");
    assert.equal(
      await pane(page)
        .getByRole("tab", { name: "zsh" })
        .getByRole("img", { name: "Running" })
        .count(),
      0,
      "a shell at its prompt isn't said to be running",
    );
    assert.equal(await pane(page).getByLabel("Folder").innerText(), "/work");
    // Looked at here, it's this viewer's size.
    await until(() => sent(gateway, "resize").length > 0, "its size");
    assert.deepEqual(sent(gateway, "resize").at(-1), {
      type: "resize",
      id: "p3",
      columns: asked?.columns,
      rows: asked?.rows,
    });

    await pane(page).locator(".xterm").click();
    await page.keyboard.type("ls\r", { delay: 15 });
    await says(page, "work $ ls");
    assert.deepEqual(
      sent(gateway, "input").map((input) => [input.id, input.text]),
      [
        ["p3", "l"],
        ["p3", "s"],
        ["p3", "\r"],
      ],
    );

    // A long paste goes in pieces, none large enough to close the socket, and none ending
    // between the two halves of a character.
    const pasted = `${"x".repeat(9_999)}\u{1F600}${"x".repeat(15_000)}`;
    await page.keyboard.insertText(pasted);
    await until(() => sent(gateway, "input").length === 6, "the paste");
    const parts = sent(gateway, "input")
      .slice(3)
      .map((input) => String(input.text));
    assert.deepEqual(
      parts.map((part) => part.length),
      [9_999, 10_000, 5_002],
    );
    assert.equal(parts.join(""), pasted);
    await page.close();
  }),
);

test(
  "a command takes a line at a time, Ctrl-C at once, no cursor keys, and nothing once it has ended",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    await pane(page).locator(".xterm").click();
    // Nothing echoes from a command, so the line is shown and mended here, and sent on Enter.
    await page.keyboard.type("yx", { delay: 15 });
    await page.keyboard.press("Backspace");
    await says(page, "ready on :4173y");
    assert.equal(sent(gateway, "input").length, 0, "nothing goes before Enter");
    // A key that would move a cursor has none to move, and adds nothing to the line.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    // An interrupt goes at once and leaves the line it was pressed in behind.
    await page.keyboard.type("ab", { delay: 15 });
    await page.keyboard.press("Control+c");
    await page.keyboard.type("c\r", { delay: 15 });
    await until(() => sent(gateway, "input").length === 3, "the lines and the interrupt");
    assert.deepEqual(
      sent(gateway, "input").map((input) => [input.id, input.text]),
      [
        ["c2", "y\n"],
        ["c2", "\u0003"],
        ["c2", "c\n"],
      ],
    );
    await says(page, "ab^C");
    assert.equal(sent(gateway, "resize").length, 0, "a command has no size");

    gateway.terminal({ type: "exit", id: "c2", exitCode: 130, at: AT });
    await pane(page)
      .getByRole("tab", { name: "npm run dev" })
      .getByRole("img", { name: "Running" })
      .waitFor({ state: "detached" });
    // What was typed into it is still there when it's drawn again.
    await says(page, "ready on :4173y");
    await pane(page).locator(".xterm").click();
    await page.keyboard.type("z\r", { delay: 15 });
    // The plus is sent after it, so whatever the ended one sent would be there by now.
    await pane(page).getByRole("button", { name: "New terminal" }).click();
    await until(() => sent(gateway, "open").length === 1, "the plus");
    assert.equal(sent(gateway, "input").length, 3, "ended, it takes no more");
    await page.close();
  }),
);

test(
  "what the service refuses is said in the viewer in its own words, until you do something else",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    gateway.live.terminal.full = true;
    const page = await open(gateway);
    await front(page, "npm run dev");
    const box = await pane(page).locator(".xterm-host").boundingBox();
    await pane(page).getByRole("button", { name: "New terminal" }).click();
    const refusal = pane(page).getByRole("alert");
    await refusal.waitFor();
    assert.equal(await refusal.innerText(), "64 terminals are running, which is the most at once.");
    assert.deepEqual(await pane(page).locator(".xterm-host").boundingBox(), box, "moving nothing");
    await front(page, "npm run dev");
    await pane(page).getByRole("tab", { name: "npm ci" }).click();
    await refusal.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "terminals you may only watch have no plus and take no typing",
  withGateway(async (gateway) => {
    withTerminals(gateway, false);
    const page = await open(gateway);
    await front(page, "npm run dev");
    await says(page, "ready on :4173");
    assert.equal(gateway.live.opened.at(-1)?.mode, "watch");
    assert.equal(await pane(page).getByRole("button", { name: "New terminal" }).count(), 0);
    await pane(page).locator(".xterm").click();
    await page.keyboard.type("y\r", { delay: 15 });
    await page.waitForTimeout(150);
    assert.equal(
      await pane(page)
        .locator(".xterm-rows")
        .innerText()
        .then((t) => t.includes("y\n")),
      false,
    );
    assert.equal(gateway.live.terminal.input.length, 0);
    // The tabs are still yours to pick.
    await pane(page).getByRole("tab", { name: "npm ci" }).click();
    await says(page, "added 812 packages");
    await page.close();
  }),
);

test(
  "a socket the service drops is opened again by itself and drawn once, with the same tab in front",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    await pane(page).getByRole("tab", { name: "npm ci" }).click();
    await front(page, "npm ci");
    const opened = () => gateway.live.opened.filter((o) => o.surface === "terminal").length;
    const drop = () => {
      for (const ws of gateway.live.terminal.sockets) ws.terminate();
    };
    // Dropped with no close frame, as the service drops a viewer too far behind.
    gateway.terminal({ type: "output", id: "c1", stream: "stdout", text: "one more line\n" });
    drop();
    await until(() => opened() === 2 && gateway.live.terminal.sockets.size === 1, "opened again");
    // What the new socket writes from here on is drawn, after everything it was first sent.
    gateway.terminal({ type: "output", id: "c1", stream: "stdout", text: "after the reopen\n" });
    await says(page, "after the reopen");
    await says(page, "one more line");
    await front(page, "npm ci");
    assert.deepEqual(await pane(page).getByRole("tab").allInnerTexts(), ["npm ci", "npm run dev"]);
    assert.equal(await pane(page).getByRole("button", { name: "Open again" }).count(), 0);
    assert.equal(
      (await pane(page).locator(".xterm-rows").innerText()).split("added 812 packages").length,
      2,
      "what the new socket sent is drawn once, not on top of what was there",
    );

    // Dropped again as soon as it opened, it isn't opened a third time: it says so, and waits.
    drop();
    await pane(page).getByRole("button", { name: "Open again" }).waitFor();
    assert.equal(opened(), 2);
    await pane(page).getByRole("button", { name: "Open again" }).click();
    await until(
      () => opened() === 3 && gateway.live.terminal.sockets.size === 1,
      "opened when asked",
    );
    gateway.terminal({ type: "output", id: "c1", stream: "stdout", text: "and once more\n" });
    await says(page, "and once more");
    await front(page, "npm ci");
    await page.close();
  }),
);

test(
  "a socket ended on purpose says why and waits to be opened again",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const page = await open(gateway);
    await front(page, "npm run dev");
    for (const ws of gateway.live.terminal.sockets) ws.close(1001, "It stopped.");
    await pane(page).getByText("It stopped.").waitFor();
    await pane(page).getByRole("button", { name: "Open again" }).click();
    await pane(page).getByText("It stopped.").waitFor({ state: "detached" });
    const opened = () => gateway.live.opened.filter((o) => o.surface === "terminal").length;
    await until(() => opened() === 2 && gateway.live.terminal.sockets.size === 1, "opened again");
    // A terminal only the new socket can tell of comes to the front, after those it was first sent.
    gateway.terminal({
      type: "start",
      id: "c3",
      by: "agent",
      cmd: "npm test",
      workdir: "/work/app",
      tty: false,
      at: AT,
    });
    await front(page, "npm test");
    assert.deepEqual(await pane(page).getByRole("tab").allInnerTexts(), [
      "npm ci",
      "npm run dev",
      "npm test",
    ]);
    await page.close();
  }),
);

test(
  "drawing a shell again sends nothing for it: not what its screen answers, nor a size once it has ended",
  withGateway(async (gateway) => {
    withTerminals(gateway);
    const shell = (id: string, text: string) => {
      gateway.terminal({
        type: "start",
        id,
        by: "person",
        cmd: "zsh",
        workdir: "/work",
        tty: true,
        at: AT,
      });
      gateway.terminal({ type: "output", id, text });
    };
    // One that ended, and one whose text asks the screen what it is, as an editor does.
    shell("s1", "work $ exit\r\n");
    gateway.terminal({ type: "exit", id: "s1", exitCode: 0, at: AT });
    shell("s2", "work $ \u001b[c\u001b[6n");
    const page = await open(gateway);
    await says(page, "work $");
    await until(() => sent(gateway, "resize").length === 1, "the running shell's size");
    await pane(page).getByRole("tab", { name: "zsh" }).first().click();
    await says(page, "work $ exit");
    // The plus is sent last, so anything the two shells caused would be there by now.
    await pane(page).getByRole("button", { name: "New terminal" }).click();
    await until(() => sent(gateway, "open").length === 1, "the plus");
    assert.deepEqual(sent(gateway, "input"), [], "the screen's answers aren't typing");
    assert.deepEqual(
      sent(gateway, "resize").map((input) => input.id),
      ["s2"],
      "an ended shell is given no size",
    );
    assert.equal(await pane(page).getByRole("alert").count(), 0, "so nothing is refused");
    await page.close();
  }),
);

test(
  "the tab in front is in view however many there are",
  withGateway(async (gateway) => {
    const start = withTerminals(gateway);
    for (let n = 0; n < 14; n++) start(`m${n}`, `npm run build:package-${n}`);
    const page = await open(gateway);
    await front(page, "npm run build:package-13");
    const inView = () =>
      pane(page)
        .getByRole("tab", { selected: true })
        .evaluate((tab) => {
          const [row, own] = [
            (tab.parentElement as HTMLElement).getBoundingClientRect(),
            tab.getBoundingClientRect(),
          ];
          return own.left >= row.left - 0.5 && own.right <= row.right + 0.5;
        });
    assert.equal(await inView(), true);
    await pane(page)
      .getByRole("tab")
      .first()
      .evaluate((tab) => tab.scrollIntoView());
    await pane(page).getByRole("tab", { name: "npm ci" }).click();
    await front(page, "npm ci");
    assert.equal(await inView(), true);
    await page.close();
  }),
);
