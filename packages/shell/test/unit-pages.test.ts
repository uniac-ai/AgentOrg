// What a stack becomes: templates kept in Settings, and the units an agent's pages name.
import assert from "node:assert/strict";
import test from "node:test";
import { card, choose, fromTemplate, open, panel, withBrowser, withGateway } from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";

withBrowser();

test(
  "Settings lists the templates: use one, copy one, delete one",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    const list = page.getByRole("list", { name: "Templates" });
    const assistant = list.getByRole("listitem").filter({ hasText: "Assistant" });
    await assistant.getByText("Computer, Web").waitFor();
    // One that came with the app has no way to delete it; one a person saved has.
    assert.equal(await assistant.getByRole("button", { name: /^Delete/ }).count(), 0);
    assert.equal(
      await list
        .getByRole("listitem")
        .filter({ hasText: "From elsewhere" })
        .getByRole("button", { name: "Delete From elsewhere" })
        .count(),
      1,
    );
    await assistant.getByRole("button", { name: "Use" }).click();
    assert.equal(
      await panel(page)
        .getByRole("button", { name: /^Assistant/ })
        .getAttribute("aria-current"),
      "true",
    );
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

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
  "a template's row says what it is and what it is built from, in the shell's own type; the way to delete it shows when it is pointed at",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    const main = page.getByRole("main");
    await main.getByRole("tab", { name: "Templates", selected: true }).waitFor();
    assert.equal(
      (await main.getByRole("button", { name: "New template", exact: true }).innerText()).trim(),
      "New template",
      "what the section offers, in words where there is room",
    );
    const row = main
      .getByRole("list", { name: "Templates" })
      .getByRole("listitem")
      .filter({ hasText: "From elsewhere" });
    assert.deepEqual(
      (await row.innerText()).split("\n").filter((word) => word.trim()),
      ["From elsewhere", "Made on another home", "mystery", "Use"],
    );
    const title = row.getByText("From elsewhere", { exact: true });
    assert.deepEqual(
      await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]),
      ["15px", "500"],
    );
    const [name, units, use] = [
      await title.boundingBox(),
      await row.getByText("mystery").boundingBox(),
      await row.getByRole("button", { name: "Use" }).boundingBox(),
    ];
    assert.ok(name && units && use);
    assert.ok(units.x > name.x + name.width && use.x > units.x + units.width, "across one row");
    const remove = row.getByRole("button", { name: "Delete From elsewhere" });
    const seen = () => remove.evaluate((e) => getComputedStyle(e).opacity);
    await page.mouse.move(5, 5);
    assert.equal(await seen(), "0");
    await row.hover();
    // It fades in.
    await remove.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.equal(await seen(), "1");
    // On a phone the name comes first, whole, then what can be done with it; what it is built
    // from goes under them.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.clientWidth === 390);
    const [first, after, under] = [
      await title.boundingBox(),
      await row.getByRole("button", { name: "Use" }).boundingBox(),
      await row.getByText("mystery").boundingBox(),
    ];
    assert.ok(first && after && under);
    assert.ok(first.width > 120, `the name has room (${first.width}px)`);
    assert.ok(after.x >= first.x + first.width, "then Use, beside it");
    assert.ok(under.y >= first.y + first.height, "what it is built from, under them");
    assert.equal(
      await title.evaluate((e) => e.scrollWidth <= e.clientWidth),
      true,
      "its name isn't cut",
    );
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
    await choose(page, "What it reaches", /^No files or terminal/);
    await panel(page).getByRole("button", { name: "Build options" }).click();
    await page.getByRole("menuitem", { name: /^Save as template/ }).click();
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
  "an agent's setup says what it was built from, each unit with its answers, and names the unit behind what one made",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await panel(page).getByLabel("Name").fill("Foreman");
    await choose(page, "Where it resides", /^This computer/);
    await card(page, "Computer")
      .getByLabel("Workspace directory", { exact: true })
      .fill("/work/foreman");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    const sheet = await openSetup(page, "Foreman");
    const built = sheet.getByRole("region", { name: "Built from Assistant" });
    assert.deepEqual((await built.getByRole("listitem").first().innerText()).split("\n"), [
      "Computer",
      "This computer",
      "Files and terminal",
      "With a browser",
      "/work/foreman",
    ]);
    await sheet
      .getByRole("region", { name: "MCPs" })
      .getByText("Computer", { exact: true })
      .waitFor();
    await page.close();
  }),
);

test(
  "a connection you made is told by where it is, not by a unit that only exposes it",
  withGateway(async (gateway) => {
    const triage = gateway.agents.get("a-triage");
    assert.ok(triage);
    triage.mcp = [{ slot: "linear", connection: "c-linear", instance: "i-link" }];
    triage.units = [
      {
        provider: "units",
        needs: {},
        status: { state: "connected" },
        instance: "i-link",
        unit: "connection",
        title: "Connection",
        values: { connection: "c-linear" },
      },
    ];
    const page = await open(gateway);
    await page.goto(`${gateway.url}/#/a/a-triage`);
    const mcps = (await openSetup(page, "Triage")).getByRole("region", { name: "MCPs" });
    await mcps.getByText("linear", { exact: true }).waitFor();
    assert.equal(await mcps.getByText("Connection", { exact: true }).count(), 0);
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
    await panel(page).getByLabel("Name").fill("Foreman");
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
    // Under the field, apart from the list's hidden copy of each answer's words.
    await computer.locator("p", { hasText: "It acts as you on this Mac." }).waitFor();
    assert.equal(
      await computer.getByRole("combobox", { name: "Where it resides" }).innerText(),
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
