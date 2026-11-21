// Something an agent holds with no part outside it: no slots of the person's to it, and nothing to
// fill in for the unit it comes from. The agent draws as any other, and its Setup and Overview
// name the unit with its own line, in a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  agentsRead,
  card,
  type Gateway,
  newTemplate,
  open,
  panel,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";
import type { Agent, Units } from "./stand-in.ts";

withBrowser();

/** A unit that asks nothing: what it builds is the agent's own, with nothing outside it. */
const NOTES: Units["units"][number] = {
  provider: "units",
  providerName: "AgentOrg",
  id: "notes",
  title: "Notes",
  description: "A few lines it keeps about your work",
  once: true,
  needs: [],
  gives: { slots: [], skills: [], results: [] },
  form: [],
};

/** Notes offered, and Reviewer built from it: what it holds of it has no slots of the person's. */
function holding(gateway: Gateway) {
  gateway.offerUnit(NOTES);
  const reviewer = gateway.agents.get("a-reviewer") as Agent;
  reviewer.units = [
    {
      instance: "i-notes",
      provider: "units",
      unit: "notes",
      title: "Notes",
      values: {},
      needs: {},
      status: { state: "connected" },
    },
  ];
  reviewer.held = [
    { title: "Notes", state: "connected", surfaces: 0, slots: [], from: "i-notes", person: false },
  ];
}
/** The page's errors from here on. */
function errorsOf(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
const main = (page: Page) => page.getByRole("main");
const builtFrom = (sheet: Locator) => sheet.getByRole("region", { name: /^Built from/ });
/** Setup's units, each as its row reads: its title, then the lines under it. */
const rows = (sheet: Locator) =>
  builtFrom(sheet)
    .locator("li")
    .evaluateAll((all) =>
      all.map((li) => [...li.children].map((line) => line.textContent?.trim() ?? "")),
    );
/** What a row's "…" offers. */
async function optionsOf(page: Page, sheet: Locator, title: string) {
  await builtFrom(sheet)
    .getByRole("button", { name: `${title} options` })
    .click();
  const items = await page.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });
  return items;
}

test(
  "an agent holding what the person has no slots to draws: in Team, on its page and in Chat",
  withGateway(async (gateway) => {
    holding(gateway);
    const page = await open(gateway);
    const errors = errorsOf(page);
    await agentsRead(page);
    await page.getByRole("list", { name: "Agents" }).getByText("Reviewer", { exact: true }).click();
    await main(page).getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    // Nothing of it to open: no Computer of its own.
    assert.deepEqual(await main(page).getByRole("tab").allInnerTexts(), ["Chats", "Overview"]);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Chat" })
      .click();
    await page.getByRole("list", { name: "Chats" }).getByText("Reviewer", { exact: true }).click();
    await main(page).getByText("Reviewed").first().waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }),
);

test(
  "Overview's line names a unit with nothing to fill in, as any unit",
  withGateway(async (gateway) => {
    holding(gateway);
    const page = await open(gateway);
    const errors = errorsOf(page);
    await page.goto(`${gateway.url}/#/a/a-reviewer/overview`);
    const section = main(page).getByRole("region", { name: "Built from", exact: true });
    await section.getByText("Notes", { exact: true }).waitFor();
    assert.deepEqual(await section.locator("span").allTextContents(), ["Empty", "Notes"]);
    assert.deepEqual(errors, []);
    await page.close();
  }),
);

test(
  "Setup: a unit that asks nothing shows its own line, and its … holds Remove only",
  withGateway(async (gateway) => {
    holding(gateway);
    const page = await open(gateway);
    await page.goto(`${gateway.url}/#/a/a-reviewer/overview`);
    const sheet = await openSetup(page, "Reviewer");
    assert.deepEqual(await rows(sheet), [["Notes", "A few lines it keeps about your work"]]);
    assert.deepEqual(await optionsOf(page, sheet, "Notes"), ["Remove"]);
    // Removed as any unit is.
    await builtFrom(sheet).getByRole("button", { name: "Notes options" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await builtFrom(sheet).getByText("Just the base").waitFor();
    assert.deepEqual((gateway.agents.get("a-reviewer") as Agent).units, []);
    await page.close();
  }),
);

test(
  "a unit that asks nothing is offered as any unit: added from Setup with its line, and in Create",
  withGateway(async (gateway) => {
    gateway.offerUnit(NOTES);
    const page = await open(gateway);
    await page.goto(`${gateway.url}/#/a/a-triage/overview`);
    const sheet = await openSetup(page, "Triage");
    await builtFrom(sheet).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: "Notes", exact: true }).click();
    // Its window has nothing to ask: its line, and Save at once.
    const window = page.getByRole("dialog", { name: "Triage's notes" });
    await window.getByText("A few lines it keeps about your work").waitFor();
    await window.getByRole("button", { name: "Save" }).click();
    await window.waitFor({ state: "detached" });
    await builtFrom(sheet).getByText("Notes", { exact: true }).waitFor();
    assert.deepEqual(await rows(sheet), [["Notes", "A few lines it keeps about your work"]]);
    assert.deepEqual(await optionsOf(page, sheet, "Notes"), ["Remove"]);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    // Create's stack offers it too, with its line, and holds it as any unit.
    await newTemplate(page);
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    const notes = page.getByRole("menuitem", { name: /^Notes/ });
    assert.deepEqual(await notes.locator("span").allTextContents(), [
      "Notes",
      "A few lines it keeps about your work",
    ]);
    await notes.click();
    await card(page, "Notes").waitFor();
    await page.close();
  }),
);
