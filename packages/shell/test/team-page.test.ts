// The team page in a real browser, over the stand-in gateway: your agents at the left, each saying
// how it stands, and the chosen one's details beside them, or one at a time where there is no room.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

const NARROW = 800;
const PHONE = 390;

async function open(gateway: Gateway, hash = "#/team", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await noted(gateway);
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
const team = (page: Page) => page.getByRole("main").getByRole("region", { name: "Team" });
const rows = (page: Page) => team(page).getByRole("list", { name: "Agents" }).getByRole("button");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
/** Each row's name and line, top to bottom; a row's face comes first. */
const listed = async (page: Page) =>
  (await rows(page).allInnerTexts()).map((text) => text.split("\n").filter(Boolean).slice(1));
/** The details' head and line: the agent's page as it is. */
const heading = (page: Page, name: string) =>
  page.getByRole("main").getByRole("heading", { name, level: 1 });
const stateOf = (page: Page) => page.getByRole("main").getByRole("status", { name: "State" });
/** Waits for what the page will come to, which arrives a call at a time. */
async function until<T>(read: () => Promise<T> | T, expected: T) {
  for (let tries = 0; ; tries++) {
    const now = await read();
    try {
      assert.deepEqual(now, expected);
      return;
    } catch (error) {
      if (tries > 200) throw error;
      await new Promise((done) => setTimeout(done, 40));
    }
  }
}
const NAMES = ["Research", "Reviewer", "Triage", "Weekly report", "Broken"];

test(
  "wide, the team page lists the agents in the order they are read, opens on the first, and marks its row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await until(async () => (await listed(page)).map(([name]) => name), NAMES);
    await heading(page, "Research").waitFor();
    assert.equal(await row(page, "Research").getAttribute("aria-current"), "true");
    assert.equal(await row(page, "Reviewer").getAttribute("aria-current"), null);
    await page.close();
  }),
);

test(
  "each row says how its agent stands in the words its details say, and a line that says something is wrong in the colour that says so",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await until(async () => (await listed(page)).length, NAMES.length);
    for (const name of ["Research", "Weekly report", "Broken", "Reviewer"]) {
      await row(page, name).click();
      await heading(page, name).waitFor();
      const said = (await stateOf(page).innerText()).split("\n")[0]?.trim();
      assert.ok(said, `${name}'s details say how it stands`);
      await until(async () => (await listed(page)).find(([one]) => one === name)?.[1], said);
    }
    // Working, stopped, and something wrong each say so.
    const lines = Object.fromEntries((await listed(page)).map(([name, line]) => [name, line]));
    assert.equal(lines.Research, "Working");
    assert.equal(lines["Weekly report"], "Stopped");
    const color = (name: string) =>
      row(page, name)
        // After its face, its name and its line.
        .locator(":scope > span:nth-of-type(2) > span:nth-of-type(2)")
        .evaluate((line) => getComputedStyle(line).color);
    const bad = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--bad)";
      document.body.append(probe);
      const said = getComputedStyle(probe).color;
      probe.remove();
      return said;
    });
    assert.equal(await color("Broken"), bad);
    assert.notEqual(await color("Reviewer"), bad);
    await page.close();
  }),
);

test(
  'the list is as Chat\'s: 300 wide, under a small label, "Agents", with a plus, "Create", at its end, which opens the creation window; it has no search field',
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await until(async () => (await listed(page)).length, NAMES.length);
    const seen = await team(page).evaluate((section) => {
      const head = section.querySelector("header") as Element;
      const words = head.querySelector("h1") as Element;
      const icon = head.querySelector('button[aria-label="Create"]');
      return {
        across: section.getBoundingClientRect().width,
        words: words.textContent,
        size: getComputedStyle(words).fontSize,
        end: icon
          ? Math.round(head.getBoundingClientRect().right - icon.getBoundingClientRect().right)
          : null,
        icon: !!icon?.querySelector("svg.lucide-plus"),
      };
    });
    assert.deepEqual(seen, {
      across: 300,
      words: "Agents",
      size: "13px",
      end: 12,
      icon: true,
    });
    assert.equal(await team(page).getByRole("searchbox").count(), 0);
    await team(page).getByRole("button", { name: "Create" }).click();
    await page.getByRole("dialog", { name: "Create" }).waitFor();
    await page.close();
  }),
);

test(
  "choosing an agent shows its details beside the list, and its tabs stay in the team page; the agent's own address shows them there too",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await row(page, "Reviewer").click();
    await page.waitForURL(/#\/team\/a-reviewer$/);
    await heading(page, "Reviewer").waitFor();
    assert.equal(await row(page, "Reviewer").getAttribute("aria-current"), "true");
    await team(page).waitFor();
    await page.getByRole("main").getByRole("tab", { name: "Overview" }).click();
    await page.waitForURL(/#\/team\/a-reviewer\/overview$/);
    await page.getByRole("main").getByRole("tabpanel", { name: "Overview" }).waitFor();
    await team(page).waitFor();
    // The agent's own address shows the same, in the team page, and its tabs are the team page's.
    await page.evaluate(() => {
      location.hash = "#/a/a-research";
    });
    await heading(page, "Research").waitFor();
    await team(page).waitFor();
    assert.equal(await row(page, "Research").getAttribute("aria-current"), "true");
    await page.getByRole("main").getByRole("tab", { name: "Overview" }).click();
    await page.waitForURL(/#\/team\/a-research\/overview$/);
    await page.close();
  }),
);

for (const [where, width] of [
  ["narrower", NARROW],
  ["on a phone", PHONE],
] as const)
  test(
    `${where}, the team page shows its list first, a row shows the agent's details alone, and Team returns to the list`,
    withGateway(async (gateway) => {
      const page = await open(gateway, "#/team", width);
      await until(async () => (await listed(page)).length, NAMES.length);
      assert.equal(await page.getByRole("main").getByRole("heading", { level: 1 }).count(), 1);
      await row(page, "Reviewer").click();
      await heading(page, "Reviewer").waitFor();
      assert.equal(await team(page).count(), 0);
      await page.getByRole("main").getByRole("button", { name: "Team", exact: true }).click();
      await page.waitForURL(/#\/team$/);
      await row(page, "Reviewer").waitFor();
      assert.equal(await heading(page, "Reviewer").count(), 0);
      await page.close();
    }),
  );

test(
  "with no agents, the team page says so with Create beside it; when they can't be read, it says that",
  withGateway(async (gateway) => {
    gateway.agents.clear();
    let page = await open(gateway);
    await team(page).getByText("No agents", { exact: true }).waitFor();
    await team(page).getByRole("button", { name: "Create", exact: true }).nth(1).click();
    await page.getByRole("dialog", { name: "Create" }).waitFor();
    await page.close();

    gateway.refuseEvery("agents.list", "unavailable", "The manager isn't answering.");
    page = await open(gateway);
    await team(page).getByText("Can't be read right now", { exact: true }).waitFor();
    assert.equal(await team(page).getByText("No agents").count(), 0);
    await page.close();
  }),
);

test(
  "Message in an agent's details opens the floating chat on its conversation",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team/a-reviewer");
    await heading(page, "Reviewer").waitFor();
    await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    await panel.getByRole("heading", { name: "Reviewer" }).waitFor();
    await panel.getByRole("textbox", { name: "Message" }).waitFor();
    await page.close();
  }),
);

test(
  "an agent's head has no …, in the team page and at its own address; a stopped agent is started from its line",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team/a-weekly");
    await heading(page, "Weekly report").waitFor();
    const more = page.getByRole("main").getByRole("button", { name: /^More for/ });
    assert.equal(await more.count(), 0);
    await stateOf(page).getByText("Stopped", { exact: true }).waitFor();
    await stateOf(page).getByRole("button", { name: "Start" }).click();
    await stateOf(page).getByText("Idle", { exact: true }).waitFor();
    await until(
      async () => (await listed(page)).find(([name]) => name === "Weekly report")?.[1],
      "Idle",
    );
    await page.evaluate(() => {
      location.hash = "#/a/a-research";
    });
    await heading(page, "Research").waitFor();
    await page.getByRole("main").getByRole("button", { name: "Setup" }).waitFor();
    assert.equal(await more.count(), 0);
    await page.close();
  }),
);
