// The fixed pages in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { openSetup } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(
  gateway: Gateway,
  hash = "#/",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** An agent in the left bar, by its state and its name. */
const inBar = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true });
const box = (locator: Locator) => locator.boundingBox();
/** How an agent's page says it stands. */
const state = (page: Page) => page.getByRole("main").getByRole("status", { name: "State" });

const withGateway =
  (run: (gateway: Gateway) => Promise<void>, options?: Parameters<typeof standIn>[0]) =>
  async () => {
    const gateway = await standIn(options);
    try {
      await run(gateway);
    } finally {
      await gateway.close();
    }
  };

test(
  "an agent's page says how it stands and no more: working or idle, or what is wrong",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    await state(page).getByText("Working", { exact: true }).waitFor();
    // What it is doing is read in its chats, not on its line.
    assert.equal((await state(page).innerText()).trim(), "Working");
    for (const name of [
      "Working Research",
      "Idle Reviewer",
      "Has a problem Triage",
      "Stopped Weekly report",
      "Has a problem Broken",
    ])
      await inBar(page, name).waitFor();
    await inBar(page, "Idle Reviewer").click();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    await inBar(page, "Has a problem Triage").click();
    await state(page).getByText("linear is down, so its tools are left out").waitFor();
    await inBar(page, "Has a problem Broken").click();
    await state(page).getByText("Its program exited.").waitFor();
    await page.close();
  }),
);

test(
  "an agent's state follows its events, and a chat's problem is that chat's to say",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const row = (on: Page) =>
      on.getByRole("main").getByRole("list", { name: "Chats with Research" }).getByRole("button");
    await state(page).getByText("Working", { exact: true }).waitFor();
    // An agent at work says so in the bar, whatever page is open.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await inBar(page, "Working Reviewer").waitFor();
    // What it was answering failed. The agent is idle, with nothing wrong of its own: the chat's
    // row says the problem, whichever chat it is, and the chat holds what can be done.
    gateway.failChat("a-research", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await row(page).getByText("You've reached your plan's limit.").waitFor();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    assert.equal(await state(page).getByRole("button").count(), 0);
    await inBar(page, "Idle Research").waitFor();
    gateway.addChat("a-research", {
      id: "c-later",
      title: "Started later",
      said: [],
      problem: { code: "failed", message: "The model refused it." },
    });
    await row(page).getByText("The model refused it.").waitFor();
    assert.equal((await state(page).innerText()).trim(), "Idle");
    // A page opened late reads the same.
    const late = await open(gateway, "#/a/a-research");
    await row(late).getByText("You've reached your plan's limit.").waitFor();
    await state(late).getByText("Idle", { exact: true }).waitFor();
    await late.close();
    // Its next reply ends the problem.
    gateway.addMessage("a-research", {
      id: "m9",
      role: "assistant",
      text: "Three causes explain it.",
      at: new Date().toISOString(),
    });
    await row(page).getByText("You've reached your plan's limit.").waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "an agent's setup shows each MCP's slot and where it is, its tools, and its skills",
  withGateway(async (gateway) => {
    const sheet = await openSetup(await open(gateway, "#/a/a-research"), "Research");
    const mcps = sheet.getByRole("region", { name: "MCPs" });
    await mcps.getByText("notes-server ~/notes").waitFor();
    // A remote one is its address, without the scheme.
    await mcps.getByText("api.githubcopilot.com/mcp", { exact: true }).waitFor();
    await mcps.getByRole("img", { name: "Remote" }).waitFor();
    await mcps.getByRole("img", { name: "On this computer" }).waitFor();

    const name = mcps.getByText("github", { exact: true });
    const before = await box(name);
    await mcps.getByRole("button", { name: "github tools" }).click();
    await mcps.getByText("search_issues").waitFor();
    assert.deepEqual(await box(name), before, "opening its tools doesn't move the row");

    await sheet.getByRole("region", { name: "Skills" }).getByText("cite-sources").waitFor();
    // With no units it is just its base.
    await sheet.getByRole("region", { name: "Built from" }).getByText("Just the base").waitFor();
    await sheet.page().close();
  }),
);

test(
  "an agent's setup opens on what its page already read, before it is read again",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    await state(page).getByText("Idle", { exact: true }).waitFor();
    const release = gateway.hold("agents.get");
    const sheet = await openSetup(page, "Reviewer");
    await sheet
      .getByRole("region", { name: "MCPs" })
      .getByText("github", { exact: true })
      .waitFor();
    release();
    await page.close();
  }),
);

test(
  "skills and connections are added in an agent's setup, and a connection is removed there",
  withGateway(async (gateway) => {
    const sheet = await openSetup(await open(gateway, "#/a/a-reviewer"), "Reviewer");
    const page = sheet.page();
    const mcps = sheet.getByRole("region", { name: "MCPs" });
    await mcps.getByText("github", { exact: true }).waitFor();
    await sheet.getByRole("button", { name: "Add an MCP" }).click();
    // Neither what it has nor what was created for another agent.
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), [
      "Linear",
      "Postgres analytics",
    ]);
    await page.getByRole("menuitem", { name: "Postgres analytics" }).click();
    await mcps.getByText("postgres_analytics", { exact: true }).waitFor();

    const skills = sheet.getByRole("region", { name: "Skills" });
    await skills.getByText("No skills").waitFor();
    for (const skill of ["cite-sources", "weekly-numbers"]) {
      await sheet.getByRole("button", { name: "Add a skill" }).click();
      await page.getByRole("menuitem", { name: skill }).click();
      await skills.getByText(skill, { exact: true }).waitFor();
    }
    // With all of them it has nothing left to add, and no skill is taken off here.
    await sheet.getByRole("button", { name: "Add a skill" }).click();
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), ["Nothing else to add"]);
    assert.equal(await page.getByRole("menuitem").isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(await skills.getByRole("button").count(), 1, "only the way to add one");

    await mcps.getByRole("button", { name: "postgres_analytics tools" }).click();
    await mcps.getByRole("button", { name: "Remove from Reviewer" }).last().click();
    await mcps.getByText("postgres_analytics", { exact: true }).waitFor({ state: "detached" });
    // A change that is refused says why, in the sheet.
    gateway.refuseNext("agents.unexpose", "state", "This came with a unit: remove the unit.");
    await mcps.getByRole("button", { name: "github tools" }).click();
    await mcps.getByRole("button", { name: "Remove from Reviewer" }).click();
    await sheet.getByRole("alert").getByText("This came with a unit: remove the unit.").waitFor();
    assert.equal(await mcps.getByText("github", { exact: true }).count(), 1);
    await page.close();
  }),
);

test(
  "the model is the agent's, read and chosen through management",
  withGateway(async (gateway) => {
    const sheet = await openSetup(await open(gateway, "#/a/a-reviewer"), "Reviewer");
    const page = sheet.page();
    const model = sheet.getByRole("combobox", { name: "Model" });
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Model"]')?.hasAttribute("disabled"),
    );
    assert.equal(await model.innerText(), "Default");
    await model.click();
    await page.getByRole("option", { name: "Deep" }).click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Model"]')?.textContent === "Deep",
    );
    assert.equal(gateway.agents.get("a-reviewer")?.model, "deep");
    assert.ok(
      gateway.calls.some(
        (c) => c.slot === "agents" && c.method === "setModel" && c.input.agent === "a-reviewer",
      ),
    );
    await model.click();
    await page.getByRole("option", { name: "Default" }).click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Model"]')?.textContent === "Default",
    );
    assert.equal(gateway.agents.get("a-reviewer")?.model, undefined);
    await page.close();
  }),
);

test(
  "an agent is stopped, started and deleted from its page, after asking",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const menu = page.getByRole("button", { name: "More for Reviewer" });
    const stop = page.getByRole("menuitem", { name: "Stop" });
    await menu.click();
    await stop.click();
    // Stopped, it is started where it says so, and there is nothing to stop or to message.
    await state(page).getByText("Stopped", { exact: true }).waitFor();
    const message = page.getByRole("main").getByRole("button", { name: "Message" });
    assert.equal(await message.isDisabled(), true);
    await menu.click();
    assert.equal(await stop.getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Escape");
    await state(page).getByRole("button", { name: "Start" }).click();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    assert.equal(await state(page).getByRole("button").count(), 0);
    assert.equal(await message.isDisabled(), false);
    // A stop that is refused says why, on its line.
    gateway.refuseNext("agents.stop", "failed", "It wouldn't stop.");
    await menu.click();
    await stop.click();
    await state(page).getByText("It wouldn't stop.").waitFor();
    // Deleting it is in its setup, after asking.
    const sheet = await openSetup(page, "Reviewer");
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Reviewer?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(gateway.agents.has("a-reviewer"));
    // A delete that is refused says why where it was asked, and is asked anew the next time.
    gateway.refuseNext("agents.remove", "failed", "It wouldn't go.");
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("alert").getByText("It wouldn't go.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    await dialog.getByRole("button", { name: "Delete" }).waitFor();
    assert.equal(await dialog.getByRole("alert").count(), 0);
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/#\/$/);
    // It is gone from the bar too.
    await inBar(page, "Idle Reviewer").waitFor({ state: "detached" });
    await inBar(page, "Working Research").waitFor();
    assert.equal(gateway.agents.has("a-reviewer"), false);
    await page.close();
  }),
);

test(
  "the left bar holds the agents, the plus and Settings",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Research" }).waitFor();
    assert.deepEqual(
      (await nav.getByRole("button").allInnerTexts()).map((t) => t.split("\n").at(-1)),
      [
        "Home",
        "",
        "Research",
        "Reviewer",
        "Triage",
        "Weekly report",
        "Broken",
        "Templates",
        "Settings",
      ],
    );
    // A face is the agent's initials, and its state is in the row's name whether or not it shows.
    const weeklyRow = nav.getByRole("button", { name: "Stopped Weekly report", exact: true });
    assert.equal((await weeklyRow.innerText()).split("\n")[0], "WR");
    await nav.getByRole("button", { name: "Working Research", exact: true }).waitFor();
    const settings = await nav.getByRole("button", { name: "Settings" }).boundingBox();
    assert.ok(settings && settings.y + settings.height > 860, "at the bottom");
    await nav.getByRole("button", { name: "Create" }).click();
    await page
      .getByRole("dialog", { name: "Create" })
      .getByRole("button", { name: "Empty" })
      .waitFor();
    await page.keyboard.press("Escape");

    await page.close();
  }),
);

test(
  "an agent's page is who it is, how it stands, and its chats; what it's made of is one press away",
  withGateway(async (gateway) => {
    gateway.addChat("a-reviewer", {
      id: "c-old",
      title: "An old review",
      said: [{ id: "o1", role: "assistant", text: "Merged.", at: "2026-01-01T10:00:00Z" }],
      archived: true,
    });
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await main.getByText("Chats and uses what you connect").waitFor();
    // With no computer it has one thing to show, so no tabs: its chats, the archived left out.
    assert.equal(await main.getByRole("tablist").count(), 0);
    const chats = main.getByRole("list", { name: "Chats with Reviewer" });
    await chats.getByRole("button").first().waitFor();
    assert.equal(await chats.getByText("An old review").count(), 0);
    await chats.getByRole("button").first().click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    await panel.getByText("Reviewed #482 with 3 comments").first().waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    // Message and New chat both start a chat with it.
    for (const name of ["Message", "New chat"]) {
      await main.getByRole("button", { name }).click();
      await panel.getByPlaceholder("Message Reviewer").waitFor();
      await panel.getByRole("button", { name: "Close chats" }).click();
    }
    // What it's made of is a sheet over its page, closed again with Escape.
    const sheet = await openSetup(page, "Reviewer");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.match(page.url(), /#\/a\/a-reviewer$/);
    // An agent that isn't there says so, and nothing else.
    await page.goto(`${gateway.url}/#/a/a-nobody`);
    await inBar(page, "Idle Reviewer").waitFor();
    await main.getByText("This agent isn't here").waitFor();
    assert.equal((await main.innerText()).trim(), "This agent isn't here\nHome");
    await page.close();
  }),
);

test(
  "every portaled surface takes the theme",
  withGateway(async (gateway) => {
    const luma = (locator: Locator) =>
      locator.evaluate((node) => {
        const canvas = document
          .createElement("canvas")
          .getContext("2d") as CanvasRenderingContext2D;
        canvas.fillStyle = getComputedStyle(node).backgroundColor;
        canvas.fillRect(0, 0, 1, 1);
        const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data as unknown as number[];
        return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
      });
    for (const theme of ["dark", "light"]) {
      const page = await open(gateway, theme === "light" ? "#/?light" : "#/a/a-reviewer");
      if (theme === "light") {
        await page.evaluate(() => localStorage.setItem("agentorg.theme", "light"));
        await page.goto(`${gateway.url}/#/a/a-reviewer`);
        await page.reload();
      }
      await page.getByRole("button", { name: "More for Reviewer" }).click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      await menu.waitFor();
      const value = await luma(menu);
      assert.ok(theme === "light" ? value > 180 : value < 110, `${theme}: ${value}`);
      await page.close();
    }
  }),
);

test(
  "no page shows a scrollbar or overflows sideways, wide or phone, nor an agent's setup over its page",
  withGateway(async (gateway) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ])
      for (const [hash, sheet] of [["#/"], ["#/a/a-research"], ["#/a/a-triage", "Triage"]]) {
        const page = await open(gateway, hash, viewport);
        await page.getByRole("main").getByText(/./).first().waitFor();
        if (sheet) {
          const box = await (await openSetup(page, sheet)).boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, "inside the window");
        }
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
          for (const el of document.querySelectorAll<HTMLElement>(
            'main, main *, [role="dialog"], [role="dialog"] *',
          ))
            if (
              /auto|scroll/.test(getComputedStyle(el).overflowY) &&
              el.offsetWidth - el.clientWidth > 0
            )
              out.push(el.className);
          return out;
        });
        assert.deepEqual(bad, [], `${viewport.width} ${hash}`);
        await page.close();
      }
  }),
);

test(
  "an agent that isn't here says so, with the way Home",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-nobody");
    const main = page.getByRole("main");
    await main.getByText("This agent isn't here", { exact: true }).waitFor();
    assert.equal(await main.getByRole("heading").count(), 0, "nothing of an agent is drawn");
    await main.getByRole("button", { name: "Home", exact: true }).click();
    await page.waitForURL(/#\/$/);
    // One deleted while its page is open says the same.
    await page.goto(`${gateway.url}/#/a/a-triage`);
    await main.getByRole("heading", { name: "Triage" }).waitFor();
    gateway.agents.delete("a-triage");
    await main.getByText("This agent isn't here", { exact: true }).waitFor({ timeout: 15_000 });
    await page.close();
  }),
);

test(
  "an agent's page doesn't say it isn't here when the list can't be read, nor before the list is read again after it is made",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer" }).waitFor();
    // The list can't be read for a while: the page stays as it was, and never says it isn't here.
    const before = gateway.calls.filter((c) => c.method === "list" && c.slot === "agents").length;
    gateway.refuseEvery("agents.list", "unavailable", "Not answering.");
    for (let end = Date.now() + 12_000; ; ) {
      const now = gateway.calls.filter((c) => c.method === "list" && c.slot === "agents").length;
      if (now > before) break;
      assert.ok(Date.now() < end, "the list is read again");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);
    assert.equal(await main.getByText("This agent isn't here").count(), 0);
    gateway.answerAgain("agents.list");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: /Reviewer/ })
      .waitFor({ timeout: 15_000 });
    // Made, and gone to, before the list has been read again: its page waits for it.
    const holding = gateway.hold("agents.list");
    await page.evaluate(() => {
      location.hash = "#/a/a-new";
    });
    await page.waitForTimeout(600);
    const said = await main.getByText("This agent isn't here").count();
    holding();
    assert.equal(said, 0, "nothing said before the list is read since the page opened");
    await page.close();
  }),
);
