// The build panel in a real browser, over the stand-in gateway: every call is checked against the
// real `agents@1`.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/`);
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
const plus = (page: Page) => page.getByRole("button", { name: /^Create/ }).first();
const panel = (page: Page) => page.getByRole("dialog", { name: /^(Create|New template)$/ });
const chooser = panel;
const card = (page: Page, name: string) =>
  panel(page).getByRole("list", { name: "Units" }).getByRole("listitem", { name });
async function fromTemplate(page: Page, name: string) {
  await page.getByRole("list", { name: "Your agents" }).waitFor();
  await plus(page).click();
  await chooser(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await panel(page).waitFor();
}
async function choose(page: Page, field: string, option: RegExp) {
  await panel(page).getByRole("combobox", { name: field }).click();
  await page.getByRole("option", { name: option }).click();
}
const gives = (page: Page, name: string) => card(page, name).locator("[data-gives]").innerText();

test(
  "a template's values are prefills: each can change, and so can its units",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    await computer.getByText("Files and terminal", { exact: true }).waitFor();
    assert.equal(await computer.getByRole("switch", { name: "Browser" }).isChecked(), true);
    await choose(page, "Files and commands", /^Read files/);
    await computer.getByRole("switch", { name: "Browser" }).click();
    await card(page, "Web").getByRole("button", { name: "Remove Web" }).click();
    assert.equal(await card(page, "Web").count(), 0);
    await page.close();
  }),
);

test(
  "the card says what it gives as the answers change, and what each answer grants",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    assert.match(
      await gives(page, "Computer"),
      /computer, browser\s+terminal, files, computer, browser/,
    );
    await choose(page, "Files and commands", /^Read files/);
    assert.match(await gives(page, "Computer"), /computer, browser\s+files, computer, browser/);
    await card(page, "Computer").getByRole("switch", { name: "Browser" }).click();
    assert.doesNotMatch(await gives(page, "Computer"), /browser/);
    await choose(page, "Where it runs", /^This computer/);
    const text = await card(page, "Computer").innerText();
    assert.match(text, /It acts as you on this Mac\./);
    assert.match(text, /Reads files in the working directory/);
    await page.close();
  }),
);

test(
  "fields come and go with the answers, and Create waits for what's required",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    await panel(page).getByLabel("Name").fill("Foreman");
    assert.equal(await create.isDisabled(), true, "where is still open");
    const folder = computer.getByLabel("Working directory", { exact: true });
    assert.equal(await folder.count(), 0);
    await choose(page, "Where it runs", /^This computer/);
    assert.equal(await create.isDisabled(), true, "the folder is required once it's shown");
    await folder.fill("/work/x");
    assert.equal(await create.isDisabled(), false);
    await choose(page, "Where it runs", /^Its own container/);
    await computer.getByLabel("Image").waitFor();
    await computer.getByLabel("Path in the container").waitFor();
    assert.equal(await folder.count(), 0);
    assert.equal(await create.isDisabled(), false, "a field that isn't shown asks for nothing");
    await page.close();
  }),
);

test(
  "Create sends what's shown, with secrets apart, and opens the new agent",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    await panel(page).getByLabel("Name").fill("Foreman");
    await panel(page).getByLabel("What it's for").fill("Keeps dependencies current");
    await choose(page, "Where it runs", /^Its own container/);
    await computer.getByLabel("Image").fill("typed/earlier");
    await choose(page, "Where it runs", /^This computer/);
    await computer.getByLabel("Working directory", { exact: true }).fill("/work/foreman");
    await choose(page, "Search service", /^Tavily/);
    const key = card(page, "Web").getByLabel("Key");
    assert.equal(await key.getAttribute("type"), "password");
    await key.fill("the-key");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/#\/a\/a-6$/);
    await page.getByRole("main").getByText("Keeps dependencies current").waitFor();
    assert.deepEqual(gateway.calls.find((c) => c.method === "create")?.input, {
      stack: {
        base: { provider: "bundled", creatable: "assistant" },
        units: [
          {
            provider: "units",
            unit: "computer",
            values: {
              access: "terminal",
              browser: true,
              where: "local",
              workspace: "/work/foreman",
            },
          },
          {
            provider: "units",
            unit: "web",
            values: { service: "tavily" },
            secrets: { key: "the-key" },
          },
        ],
        template: "assistant",
      },
      name: "Foreman",
      purpose: "Keeps dependencies current",
    });
    assert.equal(await panel(page).count(), 0, "Create closes the panel");
    await page.close();
  }),
);

test(
  "what the check finds shows where it is, and a refusal says why",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    await chooser(page).getByRole("button", { name: "Empty" }).click();
    await panel(page).getByLabel("Name").fill("Solo");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Web/ }).click();
    gateway.findProblems([
      { unit: 0, field: "service", message: "That service isn't answering." },
      { unit: 0, message: "Something about the unit." },
      { message: "Something about the stack." },
    ]);
    await create.click();
    const web = card(page, "Web");
    await web.getByText("That service isn't answering.").waitFor();
    await web.getByText("Something about the unit.").waitFor();
    await panel(page).getByRole("alert").getByText("Something about the stack.").waitFor();
    assert.equal(gateway.calls.filter((c) => c.method === "create").length, 0);
    gateway.findProblems([]);
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    await panel(page).getByLabel("Name").fill("Solo two");
    assert.equal(
      await web.getByText("That service isn't answering.").count(),
      0,
      "a change clears them",
    );
    await create.click();
    await panel(page).getByRole("alert").getByText("The provider isn't connected.").waitFor();
    assert.equal(await panel(page).getByLabel("Name").inputValue(), "Solo two");
    await page.close();
  }),
);

test(
  "every field type draws, and a type the host doesn't know gets the plain control",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    await chooser(page).getByRole("button", { name: "Empty" }).click();
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Agent control/ }).click();
    const control = card(page, "Agent control");
    await control.getByText("Needs a computer above it").waitFor();
    await control.getByRole("button", { name: "Add it" }).click();
    assert.deepEqual(
      await panel(page)
        .getByRole("list", { name: "Units" })
        .getByRole("listitem")
        .evaluateAll((items) => items.map((i) => i.getAttribute("aria-label"))),
      ["Base", "Computer", "Agent control"],
    );
    assert.equal(await control.getByText("Needs a computer above it").count(), 0);
    const limit = control.getByLabel("Agents alive");
    assert.equal(await limit.inputValue(), "3");
    assert.equal(await limit.getAttribute("max"), "20");
    await control.getByText("at once").waitFor();
    assert.equal(await control.getByRole("combobox", { name: "Place" }).count(), 0);
    await control
      .getByRole("group", { name: "Where they work" })
      .getByText("A new computer")
      .click();
    await control.getByRole("combobox", { name: "Place" }).click();
    assert.equal(await page.getByRole("option", { name: "Notes for Research" }).count(), 0);
    await page.getByRole("option", { name: "Postgres analytics" }).click();
    assert.equal(await control.getByLabel("Colour").getAttribute("type"), null);
    assert.equal(await control.getByLabel("Ceiling").getAttribute("type"), "number");
    await page.close();
  }),
);

test(
  "Create is one window: choosing opens a panel beside the list, smoothly, and it starts clean each time",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    const window_ = panel(page);
    await window_.getByRole("button", { name: "Empty" }).waitFor();
    await page.waitForTimeout(350);
    const small = await window_.boundingBox();
    assert.ok(small);
    assert.equal(await window_.locator("#build-name").count(), 0);
    const transition = await window_.evaluate((el) => getComputedStyle(el).transitionProperty);
    assert.match(transition, /width/);
    assert.match(transition, /height/);

    const assistant = window_.getByRole("button", { name: /^Assistant/ });
    await assistant.click();
    await window_.locator("#build-name").waitFor();
    assert.equal(await assistant.isVisible(), true, "the list stays");
    assert.equal(await assistant.getAttribute("aria-pressed"), "true");
    await page.waitForTimeout(450);
    const big = await window_.boundingBox();
    assert.ok(
      big && big.width > small.width && big.height > small.height,
      "the same window, larger",
    );
    const list = await window_.getByRole("list", { name: "Start from" }).boundingBox();
    const name = await window_.locator("#build-name").boundingBox();
    assert.ok(list && name && name.x > list.x + list.width - 1, "the panel is on its right");

    assert.equal(
      await window_.locator("#build-name").evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.type("Foreman");
    assert.equal(await window_.locator("#build-name").inputValue(), "Foreman");
    await window_.getByRole("button", { name: "Empty" }).click();
    assert.equal(
      await window_.locator("#build-name").inputValue(),
      "Foreman",
      "choosing again keeps it",
    );
    await assistant.click();

    // What opens from inside it counts as inside it.
    await window_.getByRole("combobox", { name: "Where it runs" }).click();
    await page.getByRole("option", { name: /^This computer/ }).click();
    await window_.getByRole("button", { name: "Add a unit" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(await window_.locator("#build-name").inputValue(), "Foreman");

    for (const close of [
      () => page.mouse.click(8, 8),
      () => window_.getByRole("button", { name: "Close" }).click(),
    ]) {
      await close();
      await window_.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Create", exact: true }).first().click();
      await window_.getByRole("button", { name: "Empty" }).waitFor();
      assert.equal(await window_.locator("#build-name").count(), 0, "the plus starts clean");
      await assistant.click();
      await window_.locator("#build-name").waitFor();
      assert.equal(await window_.locator("#build-name").inputValue(), "");
    }
    await window_.getByRole("button", { name: "Close" }).click();
    await window_.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Create", exact: true }).first().click();
    await window_.getByRole("button", { name: "Empty" }).waitFor();
    assert.equal(await assistant.getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByRole("button", { name: /in progress/ }).count(), 0);
    await page.close();
  }),
);

test(
  "the name is offered, greyed, and used if nothing is typed; only the units scroll",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    await panel(page).getByRole("button", { name: "Empty" }).click();
    const name = panel(page).locator("#build-name");
    await name.waitFor();
    assert.equal(await name.inputValue(), "");
    const offered = await name.getAttribute("placeholder");
    assert.ok(offered, "a name is offered");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    assert.equal(await create.isDisabled(), false, "nothing required is empty");

    for (let i = 0; i < 6; i++) {
      await panel(page).getByRole("button", { name: "Add a unit" }).click();
      await page.getByRole("menuitem", { name: /^Web/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    await page.waitForTimeout(450);
    const before = await name.boundingBox();
    const units = panel(page).getByRole("list", { name: "Units" });
    await units.evaluate((el) => {
      (el.parentElement as HTMLElement).scrollTop = 500;
    });
    assert.ok(
      await units.evaluate((el) => (el.parentElement as HTMLElement).scrollTop > 0),
      "they scroll",
    );
    assert.deepEqual(await name.boundingBox(), before, "the name stays");
    for (let i = 0; i < 6; i++)
      await panel(page).getByRole("button", { name: "Remove Web" }).first().click();

    await create.click();
    await page.waitForURL(/#\/a\/a-6$/);
    const sent = gateway.calls.find((c) => c.method === "create")?.input as {
      name: string;
      purpose?: string;
    };
    assert.equal(sent.name, offered);
    assert.equal(sent.purpose, undefined, "what it's for is optional");
    await page.close();
  }),
);

test(
  "what the chosen answer grants stays on the card; what a field is waits to be asked",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await choose(page, "Where it runs", /^This computer/);
    const computer = card(page, "Computer");
    assert.match(await computer.innerText(), /It acts as you on this Mac\./);
    assert.doesNotMatch(await computer.innerText(), /A browser of its own/);
    await computer.getByRole("button", { name: "About Browser" }).hover();
    await page.getByRole("tooltip").getByText("A browser of its own").first().waitFor();
    await page.close();
  }),
);

test(
  "a unit no connected provider offers says so, holds back Create, and can be removed",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "From elsewhere");
    await panel(page).getByLabel("Name").fill("Copy");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    await card(page, "mystery").getByText("Not available here.").waitFor();
    assert.equal(await create.isDisabled(), true);
    await panel(page).getByRole("button", { name: "Remove mystery" }).click();
    assert.equal(await create.isDisabled(), false);
    await page.close();
  }),
);

test(
  "Settings lists the templates: use one, copy one, delete one",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    const list = page.getByRole("list", { name: "Templates" });
    const assistant = list.getByRole("listitem").filter({ hasText: "Assistant" });
    await assistant.getByText("Computer, Web").waitFor();
    await assistant.getByRole("button", { name: "Use" }).click();
    assert.equal(
      await panel(page)
        .getByRole("button", { name: /^Assistant/ })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.keyboard.press("Escape");
    await chooser(page).waitFor({ state: "detached" });

    await assistant.getByRole("button", { name: "New template from Assistant" }).click();
    assert.equal(await panel(page).getByLabel("Name").inputValue(), "Assistant copy");
    await panel(page).getByRole("button", { name: "Save template" }).click();
    await list.getByRole("listitem").filter({ hasText: "Assistant copy" }).waitFor();
    assert.equal(await panel(page).count(), 0);
    assert.deepEqual(gateway.calls.find((c) => c.method === "saveTemplate")?.input, {
      id: "assistant-copy",
      title: "Assistant copy",
      description: "Does what you ask on a computer",
      from: "assistant",
      base: { provider: "AgentOrg", creatable: "assistant" },
      units: [
        { provider: "AgentOrg", unit: "computer", values: { access: "terminal", browser: true } },
        { provider: "AgentOrg", unit: "web" },
      ],
    });

    const copy = list.getByRole("listitem").filter({ hasText: "Assistant copy" });
    await copy.hover();
    await copy.getByRole("button", { name: "Delete Assistant copy" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await copy.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "a saved template keeps no secret and nothing that isn't shown, and the stack stays open",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await choose(page, "Search service", /^Tavily/);
    await card(page, "Web").getByLabel("Key").fill("the-key");
    await choose(page, "Files and commands", /^None/);
    await panel(page)
      .getByRole("button", { name: /^Save as template/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "Save as template" });
    await dialog.getByLabel("Template name").fill("Browse only");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
    const saved = gateway.calls.find((c) => c.method === "saveTemplate")?.input;
    assert.equal(JSON.stringify(saved).includes("the-key"), false);
    assert.deepEqual((saved as { units: unknown[] }).units, [
      { provider: "AgentOrg", unit: "computer", values: { access: "none", browser: true } },
      { provider: "AgentOrg", unit: "web", values: { service: "tavily" } },
    ]);
    assert.equal(await card(page, "Web").getByLabel("Key").inputValue(), "the-key");
    await page.close();
  }),
);

test(
  "an agent's page names what its units are, and its settings say which unit gave what",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await panel(page).getByLabel("Name").fill("Foreman");
    await choose(page, "Where it runs", /^This computer/);
    await card(page, "Computer")
      .getByLabel("Working directory", { exact: true })
      .fill("/work/foreman");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await page
      .getByRole("main")
      .getByText("Computer: This computer, Files and terminal, Browser, /work/foreman")
      .waitFor();
    await page
      .getByRole("main")
      .getByText("It acts as you on this Mac. Runs any command")
      .waitFor();
    await page.getByRole("button", { name: "Foreman settings" }).click();
    await page
      .getByRole("region", { name: "MCPs" })
      .getByRole("button", { name: "Computer", exact: true })
      .waitFor();
    await page
      .getByRole("region", { name: "Skills" })
      .getByText("Computer", { exact: true })
      .waitFor();
    await page.close();
  }),
);

test(
  "a directory field walks this machine's folders, and goes when the unit stops showing it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    await choose(page, "Where it runs", /^This computer/);
    const browse = computer.getByRole("button", { name: "Browse for Working directory" });
    await browse.click();
    const dialog = page.getByRole("dialog", { name: "Working directory" });
    const folders = dialog.getByRole("list", { name: "Folders" });
    await folders.getByRole("button", { name: "Documents" }).waitFor();
    await page.waitForTimeout(250);
    await dialog.getByText("/home/me", { exact: true }).waitFor();
    const size = await dialog.boundingBox();
    await folders.getByRole("button", { name: "Agents" }).click();
    await folders.getByRole("button", { name: "Foreman" }).click();
    await dialog.getByText("/home/me/Agents/Foreman", { exact: true }).waitFor();
    assert.deepEqual(await dialog.boundingBox(), size, "the dialog keeps its box");
    await dialog.getByRole("button", { name: "Up" }).click();
    await dialog.getByText("/home/me/Agents", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Choose" }).click();
    assert.equal(
      await computer.getByLabel("Working directory", { exact: true }).inputValue(),
      "/home/me/Agents",
    );

    await browse.click();
    await page
      .getByRole("dialog", { name: "Working directory" })
      .getByText("/home/me/Agents", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");

    await computer.getByLabel("Working directory", { exact: true }).fill("/not/made/yet");
    await browse.click();
    await page
      .getByRole("dialog", { name: "Working directory" })
      .getByText("/home/me", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");

    await choose(page, "Where it runs", /^Its own container/);
    assert.equal(await browse.count(), 0);
    await computer.getByLabel("Path in the container").fill("/work/typed");
    await page.close();
  }),
);

test(
  "what came with a unit says so, and a unit that only exposes what you have doesn't name itself",
  withGateway(async (gateway) => {
    const triage = gateway.agents.get("a-triage");
    assert.ok(triage);
    triage.skills = [
      { name: "cite-sources", description: "Links claims", instance: "i-skill" },
      { name: "files", description: "Works with files", instance: "i-computer" },
    ];
    triage.mcp = [{ slot: "linear", connection: "c-linear", instance: "i-link" }];
    const status = { state: "connected" as const };
    const common = { provider: "units", needs: {}, status };
    triage.units = [
      {
        ...common,
        instance: "i-skill",
        unit: "skill",
        title: "Skill",
        values: { skill: "cite-sources" },
      },
      { ...common, instance: "i-computer", unit: "computer", title: "Computer", values: {} },
      {
        ...common,
        instance: "i-link",
        unit: "connection",
        title: "Connection",
        values: { connection: "c-linear" },
      },
    ];
    gateway.refuseNext("agents.unexpose", "state", "This came with a unit: remove the unit.");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-triage/settings`);
    const skills = page.getByRole("region", { name: "Skills" });
    await skills.getByText("Computer", { exact: true }).waitFor();
    assert.equal(await skills.getByText("Skill", { exact: true }).count(), 0);
    await page.getByRole("region", { name: "MCPs" }).getByText("Connected by you").waitFor();
    await skills.locator(".group\\/skill").last().hover();
    await skills.getByRole("button", { name: "Remove files" }).click();
    await page
      .getByRole("main")
      .getByRole("alert")
      .getByText("This came with a unit: remove the unit.")
      .waitFor();
    await skills.getByText("files", { exact: true }).waitFor();
    await page.close();
  }),
);
