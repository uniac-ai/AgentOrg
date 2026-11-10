// The live terminal surfaces, keyed on their protocols, over the stand-in's `/live`.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
type Surface = { surface: string; protocol: string; operate: boolean; unavailable?: string };
const TERMINAL: Surface[] = [
  { surface: "commands", protocol: "commands@1", operate: false },
  { surface: "terminal", protocol: "pty@1", operate: true },
];

/** Research's computer, with these surfaces. */
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
const rows = (page: Page, pane: string) =>
  page.getByRole("group", { name: pane }).locator(".xterm-rows").innerText();

test(
  "the agent's commands stream as they run, earlier ones replayed, any one a pick away",
  withGateway(async (gateway) => {
    withSurfaces(gateway, TERMINAL);
    gateway.command({ type: "start", id: "r1", cmd: "npm ci", at: "2026-11-10T10:00:00Z" });
    gateway.command({ type: "output", id: "r1", stream: "stdout", text: "added 812 packages\n" });
    gateway.command({ type: "exit", id: "r1", exitCode: 0, at: "2026-11-10T10:00:20Z" });
    const page = await open(gateway);
    const terminal = page.getByRole("region", { name: "Terminal" });
    await terminal.waitFor();
    assert.equal(
      await page.getByRole("region", { name: "Computer" }).count(),
      0,
      "the frame is the terminal now",
    );
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Agent\'s commands"] .xterm-rows')
        ?.textContent?.includes("added 812"),
    );

    gateway.command({ type: "start", id: "r2", cmd: "npm test", at: "2026-11-10T10:01:00Z" });
    gateway.command({ type: "output", id: "r2", stream: "stdout", text: "RUN v3\n" });
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Agent\'s commands"] .xterm-rows')
        ?.textContent?.includes("RUN v3"),
    );
    gateway.command({ type: "output", id: "r2", stream: "stdout", text: "✓ 38 passed\n" });
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Agent\'s commands"] .xterm-rows')
        ?.textContent?.includes("38 passed"),
    );
    assert.doesNotMatch(
      await rows(page, "Agent's commands"),
      /added 812/,
      "the newest one is shown",
    );

    await terminal.getByRole("combobox", { name: "Command" }).click();
    await page.getByRole("option", { name: /npm ci/ }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Agent\'s commands"] .xterm-rows')
        ?.textContent?.includes("added 812"),
    );
    assert.deepEqual(gateway.live.opened.map((o) => [o.surface, o.mode]).sort(), [
      ["commands", "watch"],
      ["terminal", "operate"],
    ]);
    await page.close();
  }),
);

test(
  "your shell takes typing and its size, and says when it closed",
  withGateway(async (gateway) => {
    withSurfaces(gateway, TERMINAL);
    const page = await open(gateway);
    const shell = page.getByRole("group", { name: "Your shell" });
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="Your shell"] .xterm-rows')?.textContent?.includes("$"),
    );
    await shell.locator(".xterm").click();
    await page.keyboard.type("ls\r", { delay: 15 });
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Your shell"] .xterm-rows')
        ?.textContent?.includes("$ ls"),
    );
    assert.equal(gateway.live.typed.join(""), "ls\r");
    const size = gateway.live.resized.at(-1);
    assert.ok(size && size.columns > 20 && size.rows > 5, `a size: ${JSON.stringify(size)}`);

    gateway.endShells(1000, "The shell exited.");
    await shell.getByText("The shell exited.").waitFor();
    await shell.getByRole("button", { name: "Open again" }).click();
    await shell.getByText("The shell exited.").waitFor({ state: "detached" });
    const opened = () => gateway.live.opened.filter((o) => o.surface === "terminal").length;
    for (let n = 0; n < 80 && opened() < 2; n++) await page.waitForTimeout(50);
    assert.equal(opened(), 2);
    await page.close();
  }),
);

test(
  "a surface that can't be opened here says why, and one the page has no viewer for isn't drawn",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [
      TERMINAL[0] as Surface,
      {
        surface: "terminal",
        protocol: "pty@1",
        operate: true,
        unavailable: "A shell needs node-pty.",
      },
      { surface: "radio", protocol: "radio@9", operate: false },
    ]);
    const page = await open(gateway);
    await page
      .getByRole("region", { name: "Terminal" })
      .getByText("A shell needs node-pty.")
      .waitFor();
    assert.equal(await page.getByRole("group", { name: "radio" }).count(), 0);
    assert.equal(
      gateway.live.opened.some((o) => o.surface === "terminal"),
      false,
      "not opened",
    );
    await page.close();
  }),
);

test(
  "an agent with no live surfaces keeps the frames of its record",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("region", { name: "Computer" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Terminal" }).count(), 0);
    await page.close();
  }),
);

test(
  "the terminal fits a phone, panes stacked",
  withGateway(async (gateway) => {
    withSurfaces(gateway, TERMINAL);
    const page = await open(gateway, { width: 390, height: 844 });
    const [a, b] = [
      page.getByRole("group", { name: "Agent's commands" }),
      page.getByRole("group", { name: "Your shell" }),
    ];
    await b.waitFor();
    const [one, two] = [await a.boundingBox(), await b.boundingBox()];
    assert.ok(one && two && two.y >= one.y + one.height - 1, "stacked");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.close();
  }),
);
