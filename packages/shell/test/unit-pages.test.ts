// What a stack becomes: templates kept in Settings, and the units an agent's pages name.
import assert from "node:assert/strict";
import test from "node:test";
import {
  browser,
  card,
  choose,
  chooser,
  fromTemplate,
  open,
  panel,
  SESSION,
  unfold,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

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
    await unfold(page, "Web");
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
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
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

test(
  "a form that changed while it was open shows what's now chosen before anything is made",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    gateway.findProblems([{ unit: 0, field: "where", message: "No service is running here." }]);
    await create.click();
    await computer.getByText("No service is running here.").waitFor();

    gateway.findProblems([]);
    gateway.changeForm("computer", (field) => {
      if (field.id === "where") field.default = "local";
    });
    await create.click();
    await computer
      .locator("[data-slot=field-description]", { hasText: "It acts as you on this Mac." })
      .waitFor();
    assert.equal(
      await computer.getByRole("combobox", { name: "Where it runs" }).innerText(),
      "This computer",
    );
    assert.equal(await computer.getByText("No service is running here.").count(), 0);
    assert.equal(gateway.calls.filter((c) => c.method === "create").length, 0, "not yet");

    await create.click();
    await page.waitForURL(/#\/a\/a-6$/);
    assert.equal(gateway.calls.filter((c) => c.method === "create").length, 1);
    await page.close();
  }),
);
