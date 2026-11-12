// Skills, MCP connections and Settings in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { openSetup } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash: string, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
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
const row = (page: Page, name: string) =>
  page.getByRole("main").getByRole("listitem").filter({ hasText: name });
const labels = (page: Page) =>
  page.getByRole("dialog").locator('[data-slot="field-label"]').allInnerTexts();

test(
  "Skills lists what's there and what uses each, and adds one from a folder",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    await row(page, "cite-sources").getByRole("button", { name: "Research" }).waitFor();
    await row(page, "weekly-numbers").getByText("Not used yet").waitFor();
    await page.getByRole("button", { name: "Add skill" }).click();
    const dialog = page.getByRole("dialog");
    gateway.refuseNext("skills.add", "invalid", "That folder has no SKILL.md.");
    await dialog.getByRole("textbox").fill("/skills/empty");
    await dialog.getByRole("button", { name: "Add" }).click();
    await dialog.getByRole("alert").getByText("That folder has no SKILL.md.").waitFor();
    await dialog.getByRole("textbox").fill("/skills/changelog");
    await dialog.getByRole("button", { name: "Add" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "changelog").getByText("Not used yet").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "add")?.input, {
      path: "/skills/changelog",
    });
    await page.close();
  }),
);

test(
  "MCP connections says where each is, how it got there, what uses it, and how it stands",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    const github = row(page, "GitHub acme");
    await github.getByText("Connected by you").waitFor();
    await github.getByText("https://api.githubcopilot.com/mcp").waitFor();
    await github.getByRole("button", { name: "Reviewer" }).waitFor();
    await github.getByText("2 tools").waitFor();
    await row(page, "Notes for Research").getByText("Created for Research by Local").waitFor();
    await row(page, "Linear").getByText("Down").waitFor();
    await row(page, "Postgres analytics").getByRole("img", { name: "On this computer" }).waitFor();
    await page.close();
  }),
);

test(
  "a connection stands down on its own page as soon as it's read again",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await row(page, "Postgres analytics").getByText("1 tool").waitFor();
    const found = gateway.connections.get("c-postgres");
    assert.ok(found);
    found.status = { state: "down", tools: [] };
    await row(page, "Postgres analytics").getByText("Down").waitFor({ timeout: 7000 });
    await page.close();
  }),
);

test(
  "Connect asks what each kind's schemas ask, and a secret goes only in `secrets`",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").waitFor();
    await page.waitForTimeout(250);
    const size = await dialog.boundingBox();
    assert.deepEqual(await labels(page), ["Name", "Address", "Token"]);
    const connect = dialog.getByRole("button", { name: "Connect" });
    assert.equal(await connect.isDisabled(), true);
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /starts/ }).click();
    assert.deepEqual(await labels(page), ["Name", "Command", "Args", "CWD", "Secrets"]);
    assert.deepEqual(await dialog.boundingBox(), size, "the dialog keeps its box");

    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /address/ }).click();
    await dialog.getByLabel("Name").fill("Notion");
    await dialog.getByLabel("Address").fill("https://mcp.notion.com/mcp");
    await dialog.getByLabel("Token").fill("secret-value");
    await connect.click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "Notion").getByText("Connected by you").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "url",
      params: { url: "https://mcp.notion.com/mcp" },
      name: "Notion",
      secrets: { token: "secret-value" },
    });
    assert.ok(!(await page.content()).includes("secret-value"), "never shown again");
    await page.close();
  }),
);

test(
  "a command takes its arguments one per line and its secrets by name",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /starts/ }).click();
    await dialog.getByLabel("Name").fill("Search");
    await dialog.getByLabel("Command").fill("search-mcp");
    await dialog.getByLabel("Args").fill("--index\n/my docs");
    await dialog.getByRole("button", { name: "Add a secret" }).click();
    const connect = dialog.getByRole("button", { name: "Connect" });
    assert.equal(await connect.isDisabled(), true, "a half-written secret holds it back");
    await dialog.getByLabel("Secret name").fill("API_KEY");
    await dialog.getByLabel("Secret value").fill("k");
    await connect.click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "command",
      params: { command: "search-mcp", args: ["--index", "/my docs"] },
      name: "Search",
      secrets: { API_KEY: "k" },
    });
    await page.close();
  }),
);

test(
  "a refused connection keeps the form and says why",
  withGateway(async (gateway) => {
    gateway.refuseNext("connections.create", "invalid", "url: its parameters don't fit.");
    const page = await open(gateway, "#/mcps/add");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Bad");
    await dialog.getByLabel("Address").fill("nope");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.getByRole("alert").getByText("url: its parameters don't fit.").waitFor();
    assert.equal(await dialog.getByLabel("Address").inputValue(), "nope");
    await page.close();
  }),
);

test(
  "a connection is exposed under a slug of its name, or the Hub's name on a clash",
  withGateway(async (gateway) => {
    gateway.connections.set("c-other", {
      connection: "c-other",
      name: "GitHub",
      origin: {
        provider: "local",
        kind: "url",
        target: "https://example.com",
        madeBy: "person",
        at: new Date().toISOString(),
      },
      status: { state: "connected", tools: [] },
    });
    const page = await open(gateway, "#/a/a-reviewer");
    await openSetup(page, "Reviewer");
    await page.getByRole("region", { name: "MCPs" }).getByText("github", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "GitHub", exact: true }).click();
    await page.getByRole("region", { name: "MCPs" }).getByText("generated_tools").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "expose")?.input, {
      agent: "a-reviewer",
      connection: "c-other",
    });
    await page.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "Postgres analytics" }).click();
    await page.getByRole("region", { name: "MCPs" }).getByText("postgres_analytics").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "expose")?.input, {
      agent: "a-reviewer",
      connection: "c-postgres",
      as: "postgres_analytics",
    });
    await page.close();
  }),
);

test(
  "a skill is deleted after asking, and the confirm says who loses it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    await row(page, "cite-sources").getByRole("button", { name: "Research" }).waitFor();
    const before = await row(page, "cite-sources").boundingBox();
    await row(page, "cite-sources").hover();
    assert.deepEqual(await row(page, "cite-sources").boundingBox(), before, "hover moves nothing");
    await page.getByRole("button", { name: "Delete cite-sources" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete cite-sources?" });
    await dialog.getByText("Research loses it. This can't be undone.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      gateway.calls.some((c) => c.method === "remove"),
      false,
    );

    gateway.refuseNext("skills.remove", "failed", "It couldn't be removed.");
    await row(page, "cite-sources").hover();
    await page.getByRole("button", { name: "Delete cite-sources" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("alert").getByText("It couldn't be removed.").waitFor();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "cite-sources").waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "remove")?.input, {
      name: "cite-sources",
    });
    assert.deepEqual(gateway.agents.get("a-research")?.skills, []);

    await row(page, "weekly-numbers").hover();
    await page.getByRole("button", { name: "Delete weekly-numbers" }).click();
    await page.getByRole("dialog").getByText("Nothing uses it.").waitFor();
    await page.close();
  }),
);

test(
  "a connection is deleted after asking, naming every agent that loses it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    await row(page, "GitHub acme").getByRole("button", { name: "Reviewer" }).waitFor();
    await row(page, "GitHub acme").hover();
    await page.getByRole("button", { name: "Delete GitHub acme" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete GitHub acme?" });
    await dialog.getByText("Research and Reviewer lose it. This can't be undone.").waitFor();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "GitHub acme").waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "remove")?.input, {
      connection: "c-github",
    });
    assert.deepEqual(gateway.agents.get("a-reviewer")?.mcp, []);
    await page.close();
  }),
);

test(
  "Settings holds skills, MCP connections, providers and the account",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await page.getByRole("tab", { name: "Skills" }).waitFor();
    await page.getByRole("button", { name: "Dismiss" }).click();
    assert.deepEqual(await page.getByRole("tab").allInnerTexts(), [
      "Templates",
      "Skills",
      "MCP connections",
      "Providers",
      "Account",
    ]);
    await page.getByRole("tab", { name: "Skills" }).click();
    await row(page, "cite-sources").waitFor();
    await page.getByRole("tab", { name: "Providers" }).click();
    const agents = page.getByRole("region", { name: "Agent providers" });
    await agents.getByText("AgentOrg").waitFor();
    await agents.getByText("Assistant, Code reviewer").waitFor();
    const mcp = page.getByRole("region", { name: "MCP providers" });
    await mcp.getByText("Local", { exact: true }).waitFor();
    await mcp.getByRole("button", { name: "4 connections" }).waitFor();
    await page.getByRole("tab", { name: "Account" }).click();
    const chatgpt = page.getByRole("region", { name: "ChatGPT" });
    await chatgpt.getByText("sam@example.com").waitFor();
    await chatgpt.getByText("Plus").waitFor();
    await page.getByRole("combobox", { name: "Color" }).click();
    await page.getByRole("option", { name: "Light" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await chatgpt.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(100);
    assert.ok(gateway.calls.some((c) => c.slot === "login" && c.method === "logout"));
    await page.close();
  }),
);

test(
  "the left bar doesn't move between pages, and no page overflows or shows a scrollbar",
  withGateway(async (gateway) => {
    for (const width of [1440, 390])
      for (const hash of ["#/skills", "#/mcps", "#/settings/providers", "#/settings/account"]) {
        const page = await open(gateway, hash, width);
        await page.getByRole("main").getByText(/./).first().waitFor();
        await page.waitForTimeout(150);
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
        assert.deepEqual(bad, [], `${width} ${hash}`);
        await page.close();
      }
    const page = await open(gateway, "#/");
    const nav = page.getByRole("navigation", { name: "Main" });
    const first = nav.getByRole("button").nth(0);
    await first.waitFor();
    const before = await first.boundingBox();
    for (const name of [/^Settings$/, /Research$/, /^Templates$/, /^Home$/]) {
      await nav.getByRole("button", { name }).click();
      assert.deepEqual(await first.boundingBox(), before);
      // The bar marks where you are.
      await nav.getByRole("button", { name }).and(page.locator('[aria-current="page"]')).waitFor();
      assert.deepEqual(await first.boundingBox(), before);
    }
    await page.close();
  }),
);
