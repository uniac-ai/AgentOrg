// An agent's setup in a real browser, over the stand-in gateway: its MCPs, tools and skills, adding
// and taking them off, and its model.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";
import { box, open, state, withGateway } from "./pages-kit.ts";

withBrowser();

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
  "skills and connections are added in an agent's setup and taken off there, and each add menu ends with the way to a new one",
  withGateway(async (gateway) => {
    const sheet = await openSetup(await open(gateway, "#/a/a-reviewer"), "Reviewer");
    const page = sheet.page();
    const mcps = sheet.getByRole("region", { name: "MCPs" });
    await mcps.getByText("github", { exact: true }).waitFor();
    await sheet.getByRole("button", { name: "Add an MCP" }).click();
    // Neither what it has nor what was created for another agent; last, the way to a new one.
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), [
      "Linear",
      "Postgres analytics",
      "Connect a new MCP…",
    ]);
    await page.getByRole("menu").getByRole("separator").waitFor();
    await page.getByRole("menuitem", { name: "Postgres analytics" }).click();
    await mcps.getByText("postgres_analytics", { exact: true }).waitFor();

    const skills = sheet.getByRole("region", { name: "Skills" });
    await skills.getByText("No skills").waitFor();
    for (const skill of ["cite-sources", "weekly-numbers"]) {
      await sheet.getByRole("button", { name: "Add a skill" }).click();
      await page.getByRole("menuitem", { name: skill }).click();
      await skills.getByText(skill, { exact: true }).waitFor();
    }
    // With all of them it has nothing left to add, and still the way to a new one.
    await sheet.getByRole("button", { name: "Add a skill" }).click();
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), [
      "Nothing else to add",
      "Add a new skill…",
    ]);
    assert.equal(await page.getByRole("menuitem").first().isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    // A skill the person added is taken off from its row, the way shown when it is pointed at.
    const off = skills.getByRole("button", { name: "Remove cite-sources from Reviewer" });
    const seen = () => off.evaluate((e) => getComputedStyle(e).opacity);
    await page.mouse.move(5, 5);
    assert.equal(await seen(), "0");
    await skills.getByText("cite-sources", { exact: true }).hover();
    await off.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.equal(await seen(), "1");
    await off.click();
    await skills.getByText("cite-sources", { exact: true }).waitFor({ state: "detached" });
    await skills.getByText("weekly-numbers", { exact: true }).waitFor();

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
  "in an agent's setup a connection that is down says why under its name, a skill a unit gave stays, and the way to a new one opens Settings",
  withGateway(async (gateway) => {
    gateway.agents
      .get("a-triage")
      ?.skills.push({ name: "files", description: "Works with files", instance: "i-0" });
    // Why it is down, as its connection says it, set as a sentence of its own.
    const linear = gateway.connections.get("c-linear");
    if (linear?.status.state === "down") linear.status.detail = "its server didn't answer";
    const page = await open(gateway, "#/a/a-triage");
    let sheet = await openSetup(page, "Triage");
    const mcps = sheet.getByRole("region", { name: "MCPs" });
    const why = mcps.getByText("Its server didn't answer", { exact: true });
    await why.waitFor();
    const name = await box(mcps.getByText("linear", { exact: true }));
    const under = await box(why);
    assert.ok(name && under && under.y >= name.y + name.height && under.x === name.x, "under it");
    assert.equal(
      await why.evaluate((e) => getComputedStyle(e).color),
      await sheet.evaluate((e) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--bad)";
        e.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    );
    // Its tools closed, it is said all the same.
    assert.equal(await mcps.getByText("Remove from Triage").count(), 0);
    const skills = sheet.getByRole("region", { name: "Skills" });
    await skills.getByText("files", { exact: true }).waitFor();
    assert.equal(await skills.getByRole("button", { name: /^Remove / }).count(), 0);

    // The way to a new one puts the setup away and opens Settings straight on its section.
    const settings = page.getByRole("dialog", { name: "Settings" });
    const chosen = (name: string) =>
      settings
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name })
        .and(page.locator('[aria-current="true"]'));
    await sheet.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "Connect a new MCP…" }).click();
    await chosen("MCP connections").waitFor();
    await sheet.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    sheet = await openSetup(page, "Triage");
    await sheet.getByRole("button", { name: "Add a skill" }).click();
    await page.getByRole("menuitem", { name: "Add a new skill…" }).click();
    await chosen("Skills").waitFor();
    await sheet.waitFor({ state: "detached" });
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
