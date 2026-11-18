// Skills, MCP connections and Settings in a real browser, over the stand-in gateway. Settings is a
// window over the place; its old addresses open it on what they name.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { openSetup, sampleAgents } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  // Settings' old addresses open its window: nothing in it is measured until it has opened. One
  // that opens a section's form opens it over the window, which is then hidden behind it.
  if (/^#\/(settings|skills|mcps)/.test(hash) && !hash.endsWith("/add"))
    await opened(settings(page));
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
/** The Settings window. */
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const row = (page: Page, name: string) =>
  settings(page).getByRole("listitem").filter({ hasText: name });
/** One of Settings' sections, chosen by its row. */
const choose = (page: Page, name: string) =>
  settings(page)
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name })
    .click();
/** The forms a section opens over the window. */
const addSkill = (page: Page) => page.getByRole("dialog", { name: "Add skill" });
const connectForm = (page: Page) => page.getByRole("dialog", { name: "Connect an MCP" });
/** A dialog has finished opening: its own animations, as it grows to its size, are over. */
const opened = (dialog: Locator) =>
  dialog.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).then(() => undefined),
  );
const labels = (page: Page) =>
  connectForm(page).locator('[data-slot="field-label"]').allInnerTexts();

test(
  "Skills lists what's there and what uses each, and adds one from a folder",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    await row(page, "cite-sources").getByRole("button", { name: "Research" }).waitFor();
    await row(page, "weekly-numbers").getByText("Not used yet").waitFor();
    await page.getByRole("button", { name: "Add skill" }).click();
    const dialog = addSkill(page);
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
    // An address is said without its scheme; a command as it is run.
    await github.getByText("api.githubcopilot.com/mcp", { exact: true }).waitFor();
    await row(page, "Notes for Research").getByText("notes-server ~/notes").waitFor();
    await github.getByRole("button", { name: "Reviewer" }).waitFor();
    await github.getByText("2 tools").waitFor();
    await row(page, "Notes for Research").getByText("Created for Research by Local").waitFor();
    await row(page, "Linear").getByText("Down").waitFor();
    await row(page, "Postgres analytics").getByRole("img", { name: "On this computer" }).waitFor();
    await page.close();
  }),
);

test(
  "a connection a unit made says which unit and for which agent",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    // A second one, made for the same agent by another of its units.
    const research = gateway.agents.get("a-research");
    const made = gateway.connections.get("c-postgres");
    const web = research?.mcp.find((one) => one.connection === "c-postgres");
    assert.ok(research && made?.origin && web);
    made.origin = { ...made.origin, madeFor: "a-research" };
    web.instance = "i-web";
    const page = await open(gateway, "#/mcps");
    await row(page, "Postgres analytics").getByText("Web for Research").waitFor();
    await row(page, "Notes for Research").getByText("Computer for Research").waitFor();
    await row(page, "GitHub acme").getByText("Connected by you").waitFor();
    await page.close();
  }),
);

test(
  "a connection that is down says why under its name, and one that isn't says nothing there",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps");
    const linear = row(page, "Linear");
    const why = linear.getByText("The server didn't answer.", { exact: true });
    await why.waitFor();
    const name = await linear.getByText("Linear", { exact: true }).boundingBox();
    const said = await why.boundingBox();
    assert.ok(name && said && said.y > name.y + name.height && said.x === name.x, "under the name");
    const found = gateway.connections.get("c-linear");
    assert.ok(found);
    found.status = { state: "connected", tools: [] };
    await why.waitFor({ state: "detached", timeout: 7000 });
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
    const dialog = connectForm(page);
    await dialog.getByLabel("Name").waitFor();
    await opened(dialog);
    const size = await dialog.boundingBox();
    assert.equal(size?.height, 460, "as tall as the design has it");
    assert.deepEqual(await labels(page), ["Name", "Address", "Public addresses only", "Token"]);
    const connect = dialog.getByRole("button", { name: "Connect" });
    assert.equal(await connect.isDisabled(), true);
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /starts/ }).click();
    assert.deepEqual(await labels(page), ["Name", "Command", "Args", "CWD", "Secrets"]);
    assert.deepEqual(await dialog.boundingBox(), size, "the dialog keeps its box");

    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: /address/ }).click();
    await dialog.getByLabel("Name").fill("Notion");
    await dialog.getByLabel("Address", { exact: true }).fill("https://mcp.notion.com/mcp");
    await dialog.getByLabel("Token").fill("secret-value");
    await connect.click();
    await dialog.waitFor({ state: "detached" });
    await row(page, "Notion").getByText("Connected by you").waitFor();
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "url",
      params: { url: "https://mcp.notion.com/mcp", public: false },
      name: "Notion",
      secrets: { token: "secret-value" },
    });
    assert.ok(!(await page.content()).includes("secret-value"), "never shown again");
    await page.close();
  }),
);

test(
  "a yes-or-no field is a switch, off at first, and goes as true or false",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    const only = dialog.getByRole("switch", { name: "Public addresses only" });
    assert.equal(await only.getAttribute("aria-checked"), "false");
    assert.equal(await dialog.getByRole("textbox", { name: "Public addresses only" }).count(), 0);
    await dialog.getByLabel("Name").fill("Search");
    await dialog.getByLabel("Address", { exact: true }).fill("https://mcp.example.com/mcp");
    await only.click();
    assert.equal(await only.getAttribute("aria-checked"), "true");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(gateway.calls.findLast((c) => c.method === "create")?.input, {
      provider: "local",
      kind: "url",
      params: { url: "https://mcp.example.com/mcp", public: true },
      name: "Search",
    });
    await page.close();
  }),
);

test(
  "a field says what it does under it, as its kind's schema says",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
    const about = dialog.getByText(
      "It reaches only https servers on the public internet, never this machine or its network, and follows no redirect.",
      { exact: true },
    );
    await about.waitFor();
    await opened(dialog);
    const label = await dialog.getByText("Public addresses only", { exact: true }).boundingBox();
    const said = await about.boundingBox();
    assert.ok(label && said && said.y > label.y + label.height && said.x === label.x, "under it");
    // A field whose schema says nothing has nothing under it.
    assert.equal(await dialog.locator("p").count(), 1);
    await page.close();
  }),
);

test(
  "a command takes its arguments one per line and its secrets by name",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/mcps/add");
    const dialog = connectForm(page);
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
    const dialog = connectForm(page);
    await dialog.getByLabel("Name").fill("Bad");
    await dialog.getByLabel("Address", { exact: true }).fill("nope");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.getByRole("alert").getByText("url: its parameters don't fit.").waitFor();
    assert.equal(await dialog.getByLabel("Address", { exact: true }).inputValue(), "nope");
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
    await page
      .getByRole("dialog", { name: "Delete weekly-numbers?" })
      .getByText("Nothing uses it.")
      .waitFor();
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
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    const sections = settings(page).getByRole("navigation", { name: "Settings" });
    assert.deepEqual(await sections.getByRole("button").allInnerTexts(), [
      "Templates",
      "Skills",
      "MCP connections",
      "Providers",
      "Account",
    ]);
    await choose(page, "Skills");
    await row(page, "cite-sources").waitFor();
    await choose(page, "Providers");
    const agents = page.getByRole("region", { name: "Agent providers" });
    await agents.getByText("AgentOrg").waitFor();
    await agents.getByText("Assistant, Code reviewer").waitFor();
    const mcp = page.getByRole("region", { name: "MCP providers" });
    await mcp.getByText("Local", { exact: true }).waitFor();
    await mcp.getByRole("button", { name: "4 connections" }).waitFor();
    await choose(page, "Account");
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
  "the bar doesn't move between places or when Settings opens over them, and no section overflows or shows a scrollbar",
  withGateway(async (gateway) => {
    for (const width of [1440, 390])
      for (const hash of ["#/skills", "#/mcps", "#/settings/providers", "#/settings/account"]) {
        const page = await open(gateway, hash, width);
        await settings(page).getByRole("region").locator("li, section").first().waitFor();
        await page.waitForTimeout(150);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
          for (const el of document.querySelectorAll<HTMLElement>(
            '[role="dialog"], [role="dialog"] *',
          ))
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
    // By its markup: under the open window the bar is out of reach, but still there.
    const place = (name: string) =>
      page.locator(`nav[aria-label="Main"] button[aria-label^="${name}"]`);
    const first = place("Chat");
    await first.waitFor();
    const before = await first.boundingBox();
    for (const name of ["Team", "Chat"]) {
      await place(name).click();
      assert.deepEqual(await first.boundingBox(), before);
      // The bar marks where you are.
      await place(name).and(page.locator('[aria-current="page"]')).waitFor();
      assert.deepEqual(await first.boundingBox(), before);
    }
    // Settings opens over the place, which the bar still marks, and the bar stays.
    await place("Settings").click();
    await opened(settings(page));
    assert.deepEqual(await first.boundingBox(), before);
    assert.equal(await place("Settings").getAttribute("aria-current"), null);
    assert.equal(await place("Chat").getAttribute("aria-current"), "page");
    await page.close();
  }),
);

test(
  "Settings' sections are set in the window's type, and connections with none to list say so in the first row's place",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    const title = row(page, "cite-sources").getByText("cite-sources", { exact: true });
    await title.waitFor();
    assert.deepEqual(
      await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]),
      ["14px", "500"],
    );
    await choose(page, "MCP connections");
    const name = row(page, "GitHub acme").getByText("GitHub acme", { exact: true });
    await name.waitFor();
    assert.equal(await name.evaluate((e) => getComputedStyle(e).fontSize), "14px");
    for (const [tab, words] of [
      ["Providers", "AgentOrg"],
      ["Account", "sam@example.com"],
    ] as const) {
      await choose(page, tab);
      const said = settings(page).getByText(words, { exact: true });
      await said.waitFor();
      assert.equal(await said.evaluate((e) => getComputedStyle(e).fontSize), "14px", tab);
    }
    // With none, as when the last is removed, the list says so in its first row's place.
    for (const agent of gateway.agents.values()) agent.mcp = [];
    for (const connection of [...gateway.connections.keys()])
      gateway.connections.delete(connection);
    const before = gateway.calls.length;
    await choose(page, "MCP connections");
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
    for (const end = Date.now() + 8000; ; ) {
      const read = gateway.calls
        .slice(before)
        .some((c) => c.slot === "connections" && c.method === "list");
      if (read) break;
      assert.ok(Date.now() < end, "the connections are read again");
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(100);
    const list = settings(page).getByRole("region", { name: "MCP connections" }).getByRole("list");
    await list.getByText("No connections", { exact: true }).waitFor();
    assert.equal(await list.getByRole("listitem").count(), 1);
    assert.equal((await list.innerText()).trim(), "No connections");
    await page.close();
  }),
);

test(
  "Account says who is signed in to ChatGPT with the way out; signed out, it says so with the way in the banner has",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/settings/account");
    const chatgpt = settings(page).getByRole("region", { name: "ChatGPT" });
    await chatgpt.getByText("sam@example.com").waitFor();
    assert.deepEqual(
      (await chatgpt.innerText()).split("\n").filter((word) => word.trim()),
      ["ChatGPT", "sam@example.com", "Plus", "Manage usage", "Sign out"],
    );
    for (const state of ["ineligible", "signed_in", "signed_out"] as const) {
      gateway.setAccount(state);
      if (state === "signed_in") {
        await chatgpt.getByText("sam@example.com").waitFor();
        continue;
      }
      await chatgpt.getByText("Signed out", { exact: true }).waitFor();
      assert.deepEqual(
        (await chatgpt.innerText()).split("\n").filter((word) => word.trim()),
        state === "signed_out"
          ? [
              "ChatGPT",
              "Signed out",
              "Agents can't work until you sign in with ChatGPT.",
              "Continue with ChatGPT",
            ]
          : [
              "ChatGPT",
              "Signed out",
              "This ChatGPT account isn't eligible to use its plan in this app.",
              "Use another account",
            ],
      );
      // The same way in as the banner's, under the words, as wide as they have room for: the
      // window's section is narrow.
      const way = await chatgpt.getByRole("button").boundingBox();
      const words = await chatgpt
        .getByText("Signed out", { exact: true })
        .locator("..")
        .boundingBox();
      assert.ok(way && words && Math.round(way.height) === 40);
      assert.equal(Math.round(way.width), Math.round(words.width));
      assert.ok(way.y >= words.y + words.height, "under the words");
    }
    // Pressed, it waits for ChatGPT's page as the banner's does, and takes this tab there.
    // ChatGPT's page is answered here: nothing leaves this computer.
    await page
      .context()
      .route("https://auth.example/**", (route) => route.fulfill({ status: 200, body: "ChatGPT" }));
    const holding = gateway.hold("login.start");
    await chatgpt.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await chatgpt.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
    holding();
    await page.waitForURL(/^https:\/\/auth\.example\/authorize/);
    await page.close();
  }),
);

test(
  "a section's contents move with the wheel from anywhere over them, under the window's top line, which stays",
  withGateway(async (gateway) => {
    // Too short for the list.
    const page = await open(gateway, "#/skills", 1440, 160);
    const window = settings(page);
    const first = row(page, "cite-sources");
    await first.waitFor();
    await opened(window);
    const top = async (of: ReturnType<Page["locator"]>) => (await of.boundingBox())?.y ?? 0;
    const head = window.getByRole("button", { name: "Add skill" });
    const area = await window.getByRole("region", { name: "Skills" }).boundingBox();
    assert.ok(area);
    const [rowWas, headWas] = [await top(first), await top(head)];
    for (const [side, x] of [
      ["left", area.x + 10],
      ["middle", area.x + area.width / 2],
      ["right", area.x + area.width - 10],
    ] as const) {
      await page.mouse.move(x, area.y + area.height - 10);
      await page.mouse.wheel(0, 20);
      await page.waitForFunction(
        ([was, name]) => {
          const rows = [...document.querySelectorAll('[role="dialog"] li')];
          const one = rows.find((li) => li.textContent?.includes(name as string));
          return !!one && one.getBoundingClientRect().y < (was as number);
        },
        [rowWas, "cite-sources"] as const,
      );
      assert.equal(await top(head), headWas, `the top line stays, the wheel at the ${side}`);
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(
        ([was, name]) => {
          const rows = [...document.querySelectorAll('[role="dialog"] li')];
          const one = rows.find((li) => li.textContent?.includes(name as string));
          return one?.getBoundingClientRect().y === was;
        },
        [rowWas, "cite-sources"] as const,
      );
    }
    await page.close();
  }),
);

test(
  "a list with no rows says which nothing it is, in the first row's place: none yet, or none that can be read",
  withGateway(async (gateway) => {
    const first = (page: Page) =>
      settings(page).getByRole("region").locator("ul").first().getByRole("listitem").first();
    const lists = [
      ["#/settings/templates", "No templates", "agents.templates"],
      ["#/skills", "No skills", "skills.list"],
      ["#/mcps", "No connections", "connections.list"],
    ] as const;
    gateway.emptyLists();
    for (const [hash, none] of lists) {
      const page = await open(gateway, hash);
      await first(page).getByText(none, { exact: true }).waitFor();
      assert.equal(await settings(page).getByText("Can't be read right now").count(), 0);
      await page.close();
    }
    for (const [hash, none, call] of lists) {
      gateway.refuseEvery(call, "unavailable", "Not answering.");
      const page = await open(gateway, hash);
      await first(page).getByText("Can't be read right now", { exact: true }).waitFor();
      assert.equal(await settings(page).getByText(none).count(), 0, "not that it has none");
      await page.close();
    }
  }),
);
