// The fixed pages in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
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
const row = (page: Page, name: string) =>
  page.getByRole("list", { name: "Your agents" }).getByRole("listitem").filter({ hasText: name });
const box = (locator: Locator) => locator.boundingBox();

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
  "Agents says what each agent is doing, from its status, its chat and its connections",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await row(page, "Research").getByText("Using github__search_issues").waitFor();
    assert.match(
      await row(page, "Research").innerText(),
      /Using github__search_issues[\s\S]*6 min/,
    );
    assert.match(await row(page, "Reviewer").innerText(), /Reviewed #482 with 3 comments\s+12 min/);
    await row(page, "Triage").getByText("linear is down, so its tools are left out").waitFor();
    await row(page, "Weekly report").getByRole("img", { name: "Stopped" }).waitFor();
    await row(page, "Broken").getByText("Its program exited.").waitFor();
    await page.close();
  }),
);

test(
  "a row follows its agent's events, and keeps its box and place",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const research = row(page, "Research");
    await research.getByText("Using github__search_issues").waitFor();
    const before = await box(research);
    gateway.setChatStatus("a-research", { state: "thinking" });
    await research.getByText("Thinking").waitFor();
    assert.deepEqual(await box(research), before);
    gateway.setChatStatus("a-research", {
      state: "error",
      detail: { code: "usage_limit", message: "You've reached your plan's limit." },
    });
    await research.getByText("You've reached your plan's limit.").waitFor();
    await research.getByRole("img", { name: "Has a problem" }).waitFor();
    gateway.setChatStatus("a-research", { state: "idle" });
    gateway.addMessage("a-research", {
      id: "m9",
      role: "assistant",
      text: "Three causes explain it.",
      at: new Date().toISOString(),
    });
    await research.getByText("Three causes explain it.").waitFor();
    assert.deepEqual(await box(research), before);
    await page.close();
  }),
);

test(
  "Create offers what `agents.creatable` returns and asks only what the choice needs",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("button", { name: "Create" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Assistant/ }).waitFor();
    await page.waitForTimeout(250);
    const size = await box(dialog);
    await dialog.getByRole("button", { name: /^Assistant/ }).click();
    assert.deepEqual(await dialog.locator('[data-slot="field-label"]').allInnerTexts(), ["Name"]);
    assert.deepEqual(await box(dialog), size, "the dialog keeps its box");
    await dialog.getByRole("button", { name: "Back" }).click();

    await dialog.getByRole("button", { name: /^Code reviewer/ }).click();
    assert.deepEqual(await dialog.locator('[data-slot="field-label"]').allInnerTexts(), [
      "Name",
      "Repository",
      "Note",
    ]);
    const create = dialog.getByRole("button", { name: "Create" });
    assert.equal(await create.isDisabled(), true, "an ask with no answer holds it back");
    await dialog.getByLabel("Repository").fill("acme/storefront");
    await create.click();
    await page.waitForURL(/#\/a\/a-6$/);
    assert.deepEqual(gateway.calls.find((c) => c.method === "create")?.input, {
      provider: "bundled",
      creatable: "reviewer",
      name: "Code reviewer",
      answers: { repo: "acme/storefront" },
    });
    await page.close();
  }),
);

test(
  "a refused Create stays open and says why",
  withGateway(async (gateway) => {
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    const page = await open(gateway);
    await page.getByRole("button", { name: "Create" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Assistant/ }).click();
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("alert").getByText("The provider isn't connected.").waitFor();
    assert.equal(await dialog.getByLabel("Name").inputValue(), "Assistant");
    await page.close();
  }),
);

test(
  "the agent page shows each MCP's place and origin, its skills, and its activity",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research/settings");
    const mcps = page.getByRole("region", { name: "MCPs" });
    await mcps.getByText("Created for this agent by Local").waitFor();
    await mcps.getByText("Connected by you").waitFor();
    await mcps.getByText("notes-server ~/notes").waitFor();
    await mcps.getByRole("img", { name: "Remote" }).waitFor();
    await mcps.getByRole("img", { name: "On this computer" }).waitFor();

    const name = mcps.getByText("github", { exact: true });
    const before = await box(name);
    await mcps.getByRole("button", { name: "github tools" }).click();
    await mcps.getByText("search_issues").waitFor();
    assert.deepEqual(await box(name), before, "opening its tools doesn't move the row");

    await page.getByRole("region", { name: "Skills" }).getByText("cite-sources").waitFor();
    const activity = page.getByRole("region", { name: "Activity" });
    await activity.getByText("Using github__search_issues").waitFor();
    await activity.getByText("6 min · github").waitFor();
    await page.close();
  }),
);

test(
  "skills and connections are exposed and removed from the agent page",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer/settings");
    const mcps = page.getByRole("region", { name: "MCPs" });
    await mcps.getByText("github", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add an MCP" }).click();
    // Neither what it has nor what was created for another agent.
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), [
      "Linear",
      "Postgres analytics",
      "Connect a new MCP…",
    ]);
    await page.getByRole("menuitem", { name: "Postgres analytics" }).click();
    await mcps.getByText("postgres_analytics", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Add a skill" }).click();
    await page.getByRole("menuitem", { name: "weekly-numbers" }).click();
    const skills = page.getByRole("region", { name: "Skills" });
    await skills.getByText("weekly-numbers").waitFor();
    await skills.getByText("weekly-numbers").hover();
    await page.getByRole("button", { name: "Remove weekly-numbers" }).click();
    await skills.getByText("weekly-numbers").waitFor({ state: "detached" });

    await mcps.getByRole("button", { name: "postgres_analytics tools" }).click();
    await mcps.getByRole("button", { name: "Remove from Reviewer" }).last().click();
    await mcps.getByText("postgres_analytics", { exact: true }).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "the model is read and chosen through the agent's chat",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer/settings");
    const model = page.getByRole("combobox", { name: "Model" });
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Model"]')?.hasAttribute("disabled"),
    );
    assert.equal(await model.innerText(), "Default");
    await model.click();
    await page.getByRole("option", { name: "Deep" }).click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Model"]')?.textContent === "Deep",
    );
    assert.equal(gateway.agents.get("a-reviewer")?.chat.current, "deep");
    await model.click();
    await page.getByRole("option", { name: "Default" }).click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Model"]')?.textContent === "Default",
    );
    assert.equal(gateway.agents.get("a-reviewer")?.chat.current, undefined);
    await page.close();
  }),
);

test(
  "an agent is stopped, started and deleted from its page, after asking",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    await page.getByRole("button", { name: "Stop Reviewer" }).click();
    await page.getByRole("main").getByText("Stopped", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Start Reviewer" }).click();
    await page.getByRole("main").getByText("Reviewed #482 with 3 comments").first().waitFor();
    const menu = page.getByRole("button", { name: "Reviewer options" });
    await menu.click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Reviewer?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(gateway.agents.has("a-reviewer"));
    await menu.click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/#\/$/);
    await row(page, "Research").waitFor();
    assert.equal(gateway.agents.has("a-reviewer"), false);
    await page.close();
  }),
);

test(
  "the left bar holds the agents, the plus and Settings; the main page controls each agent",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Research" }).waitFor();
    assert.deepEqual(
      (await nav.getByRole("button").allInnerTexts()).map((t) => t.trim()),
      ["Agents", "", "Research", "Reviewer", "Triage", "Weekly report", "Broken", "Settings"],
    );
    const settings = await nav.getByRole("button", { name: "Settings" }).boundingBox();
    assert.ok(settings && settings.y + settings.height > 860, "at the bottom");
    await nav.getByRole("button", { name: "Create" }).click();
    await page.getByRole("dialog", { name: "Create" }).waitFor();
    await page.keyboard.press("Escape");

    const weekly = row(page, "Weekly report");
    await weekly.getByRole("button", { name: "Start Weekly report" }).click();
    await weekly.getByRole("button", { name: "Stop Weekly report" }).waitFor();
    assert.equal(gateway.agents.get("a-weekly")?.status.state, "running");
    gateway.refuseNext("agents.stop", "failed", "It wouldn't stop.");
    await weekly.getByRole("button", { name: "Stop Weekly report" }).click();
    await weekly.getByText("It wouldn't stop.").waitFor();
    assert.equal(await page.getByRole("main").getByText("github", { exact: true }).count(), 0);
    await page.close();
  }),
);

test(
  "an agent's page says what it's for, holds room, and leads to what it's made of",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Research" }).waitFor();
    await main.getByText("Chats and uses what you connect").waitFor();
    await main
      .getByRole("button", { name: /^Made from/ })
      .getByText("Assistant")
      .waitFor();
    await main.getByRole("button", { name: /^MCPs/ }).getByText("2").waitFor();
    for (const held of ["Computer", "Browser", "Updates"])
      assert.equal((await main.getByRole("region", { name: held }).innerText()).trim(), held);
    await main.getByRole("button", { name: "Research settings" }).click();
    await page.waitForURL(/\/a\/a-research\/settings$/);
    await main.getByRole("region", { name: "MCPs" }).getByText("github", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("button", { name: "Research" })
      .click();
    await page.waitForURL(/\/a\/a-research$/);
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
      await page.getByRole("button", { name: "Reviewer options" }).click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      await menu.waitFor();
      const value = await luma(menu);
      assert.ok(theme === "light" ? value > 180 : value < 110, `${theme}: ${value}`);
      await page.close();
    }
  }),
);

test(
  "no page shows a scrollbar or overflows sideways, wide or phone",
  withGateway(async (gateway) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ])
      for (const hash of ["#/", "#/a/a-research", "#/a/a-research/settings", "#/a/a-triage"]) {
        const page = await open(gateway, hash, viewport);
        await page.getByRole("main").getByText(/./).first().waitFor();
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
          for (const el of document.querySelectorAll<HTMLElement>("main, main *"))
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
