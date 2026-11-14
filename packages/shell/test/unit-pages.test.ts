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
    // Each answer is read with the question it answers.
    assert.deepEqual((await built.getByRole("listitem").first().innerText()).split("\n"), [
      "Computer",
      "Where it resides",
      "This computer",
      "What it reaches",
      "Files and terminal",
      "With a browser",
      "On",
      "Workspace directory",
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
  "a unit is changed, removed or added from the agent's setup, and a change that is refused puts back what it was built from",
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
    const units = built.getByRole("listitem");
    const dialog = page.getByRole("dialog", { name: "Foreman's computer" });
    const change = async () => {
      await built.getByRole("button", { name: "Computer options" }).click();
      await page.getByRole("menuitem", { name: "Change…" }).click();
      await dialog.waitFor();
    };
    const made = () => gateway.calls.filter((c) => /^(add|remove)Unit$/.test(c.method));

    // Changed, it is taken out and put back as answered now, with what it was answered before, in
    // the place it had: the top.
    await change();
    assert.equal(
      await dialog.getByLabel("Workspace directory", { exact: true }).inputValue(),
      "/work/foreman",
    );
    await dialog.getByRole("combobox", { name: "What it reaches" }).click();
    await page.getByRole("option", { name: /^Read-only files/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await units.filter({ hasText: "Read-only files" }).waitFor();
    assert.deepEqual(
      made().map((c) => c.method),
      ["removeUnit", "addUnit"],
    );
    const added = made()[1]?.input as
      | { unit: { values: Record<string, unknown> }; at?: number }
      | undefined;
    assert.equal(added?.unit.values.workspace, "/work/foreman");
    assert.equal(added?.at, 0);
    assert.match(await units.first().innerText(), /^Computer\n/);

    // Refused, what it was built from goes back, and the sheet says why.
    gateway.refuseNext("agents.addUnit", "invalid", "That folder can't be used.");
    await change();
    await dialog.getByLabel("Workspace directory", { exact: true }).fill("/nowhere");
    await dialog.getByRole("button", { name: "Save" }).click();
    await sheet.getByRole("alert").getByText("That folder can't be used.").waitFor();
    // Put back where it was, too.
    const back = made().at(-1)?.input as { unit: { unit: string }; at?: number } | undefined;
    assert.deepEqual([back?.unit.unit, back?.at], ["computer", 0]);
    await units.filter({ hasText: "/work/foreman" }).waitFor();
    assert.equal(await units.filter({ hasText: "/nowhere" }).count(), 0);
    assert.equal(await units.filter({ hasText: "Read-only files" }).count(), 1);

    // Removed, it goes; added, it comes back below the rest. One held at most once isn't offered
    // while there is one.
    await built.getByRole("button", { name: "Web options" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    // While a menu is open the sheet is hidden from the accessibility tree: it is read once it's shut.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await units.filter({ hasText: "Search service" }).waitFor({ state: "detached" });
    assert.equal(await units.count(), 1);
    await built.getByRole("button", { name: "Add a unit" }).click();
    const offered = await page.getByRole("menuitem").allInnerTexts();
    assert.ok(offered.includes("Web") && !offered.includes("Computer"), offered.join(", "));
    await page.getByRole("menuitem", { name: "Web" }).click();
    const web = page.getByRole("dialog", { name: "Foreman's web" });
    await web.getByRole("button", { name: "Save" }).click();
    await units.last().getByText("Search service").waitFor();
    assert.equal(await units.last().innerText(), "Web\nSearch service\nExa");
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
