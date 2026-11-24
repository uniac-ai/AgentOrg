// Create for an agent, one card: the template it starts from, its avatar and name, and what it's
// for; what the template gives is shown beside the card, and not asked. It sends the template's
// stack as saved, and what Create's check refuses is said above Create. A template is still built
// in New template's window. In a real browser over the stand-in gateway, whose check answers as
// management's does.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import {
  agentsRead,
  badge,
  card,
  detail,
  edge,
  type Gateway,
  newTemplate,
  open,
  panel,
  plus,
  startFrom,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import type { Template } from "./stand-in.ts";

withBrowser();

const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";
const INSTALL =
  "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.";

/** A template kept as it was saved. */
const kept = (title: string, unit: string, values: Record<string, string>): Template => ({
  id: title.toLowerCase().replaceAll(" ", "-"),
  title,
  description: "Saved before",
  base: { provider: "AgentOrg", creatable: "assistant" },
  units: [{ provider: "AgentOrg", unit, values }],
});

/** Create from Team's own button, once it has opened, and where it starts from chosen. */
async function create(page: Page, from?: string) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  if (from) await startFrom(page, from);
}
const made = (gateway: Gateway) => gateway.calls.filter((c) => c.method === "create").length;

/**
 * What Create's check refused, read at one moment: its words, whether they are above Create, and
 * whether they are in the problem colour.
 */
const refusal = (page: Page) =>
  panel(page).evaluate((e) => {
    const said = e.querySelector('[role="alert"]');
    const button = [...e.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Create",
    );
    if (!said || !button) return null;
    const probe = document.createElement("i");
    probe.style.color = "var(--bad)";
    e.append(probe);
    const bad = getComputedStyle(probe).color;
    probe.remove();
    return {
      words: said.textContent,
      above: said.getBoundingClientRect().bottom <= button.getBoundingClientRect().top,
      bad: getComputedStyle(said).color === bad,
    };
  });

test(
  "Create sends the name, what it's for and the avatar, with the template's stack as saved",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await create(page, "Assistant");
    await panel(page).getByLabel("Name").fill("Foreman");
    await panel(page).getByLabel("What it's for").fill("Keeps dependencies current");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/#\/team\/a-6$/);
    const { avatar, ...rest } = gateway.calls.find((c) => c.method === "create")?.input ?? {};
    assert.match(String(avatar), /^v1[a-z0-9.-]*$/, "the avatar chosen, as its string");
    assert.deepEqual(rest, {
      stack: {
        base: { provider: "bundled", creatable: "assistant" },
        units: [
          { provider: "units", unit: "computer", values: { access: "terminal", browser: true } },
          { provider: "units", unit: "web", values: {} },
        ],
        template: "assistant",
      },
      name: "Foreman",
      purpose: "Keeps dependencies current",
    });
    await page.close();
  }),
);

test(
  "in Create only the name, what it's for, the avatar and the template can change: what it can do is shown beside the card, each unit by its logo and its name, and no field of a unit is a control",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await create(page);
    const window_ = panel(page);
    await edge(page).click();
    const controls = await window_.evaluate((d) =>
      [
        ...d.querySelectorAll(
          'input, textarea, select, [role="combobox"], [role="checkbox"], [role="switch"], [role="radio"], [role="spinbutton"], [role="slider"]',
        ),
      ]
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => e.getAttribute("aria-label")),
    );
    assert.deepEqual(controls, ["Name", "What it's for"]);
    const can = detail(page);
    assert.deepEqual(
      (await can.getByRole("listitem").allInnerTexts()).map((text) => text.split("\n")[0]),
      ["Computer", "Web"],
    );
    assert.equal(await can.getByRole("button").count(), 0, "shown, not pressed");
    // No options, no rail, no menu of units.
    assert.equal(await window_.locator('form[aria-label="Build"]').count(), 0);
    assert.equal(await window_.getByRole("navigation", { name: "Sections" }).count(), 0);
    assert.equal(await window_.getByRole("button", { name: "Add a unit" }).count(), 0);
    assert.equal(await window_.getByRole("button", { name: "Build options" }).count(), 0);
    // The template it starts from is said by its badge.
    assert.equal(await badge(page).getAttribute("aria-label"), "Template: Assistant");
    await page.close();
  }),
);

test(
  "what Create's check refuses is said above Create in the service's words: the Computer that can't be had, a template's answer its unit no longer asks",
  withGateway(async (gateway) => {
    gateway.stateComputer(INSTALL);
    gateway.computerRefuses(INSTALL);
    // Its answer is one the Computer that states this computer asks.
    gateway.addTemplate(kept("Kept here", "computer", { access: "terminal" }));
    let page = await open(gateway);
    await create(page, "Kept here");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await panel(page).getByRole("alert").getByText(INSTALL, { exact: true }).waitFor();
    assert.deepEqual(await refusal(page), { words: INSTALL, above: true, bad: true });
    assert.equal(made(gateway), 0, "nothing made");
    await page.close();

    gateway.computerRefuses();
    gateway.stateComputer(READY);
    gateway.addTemplate(
      kept("Kept made", "computer", { kind: "new", made: "container", access: "terminal" }),
    );
    page = await open(gateway);
    await create(page, "Kept made");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    const words = "This unit has no field kind. This unit has no field made.";
    await panel(page).getByRole("alert").getByText(words, { exact: true }).waitFor();
    assert.deepEqual(await refusal(page), { words, above: true, bad: true });
    assert.equal(made(gateway), 0, "nothing made");
    await page.close();
  }),
);

test(
  "Team's own Create opens on the Assistant, as its card alone",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    await window_.getByRole("form", { name: "Create" }).waitFor();
    assert.equal(await badge(page).textContent(), "Assistant");
    assert.equal(await detail(page).count(), 0);
    await page.close();
  }),
);

test(
  "a template whose unit needs a key it doesn't hold is refused with the check's words, and nothing is made",
  withGateway(async (gateway) => {
    gateway.addTemplate(kept("Kept search", "web", { service: "tavily" }));
    const page = await open(gateway);
    await create(page, "Kept search");
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await panel(page).getByRole("alert").getByText("Key must be given.", { exact: true }).waitFor();
    assert.equal(made(gateway), 0, "nothing made");
    await page.close();
  }),
);

test(
  "New template keeps its window: the card, the options in sections with their rail, and Save template",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    const window_ = panel(page);
    assert.deepEqual(await window_.locator('form[aria-label="Build"] section h3').allInnerTexts(), [
      "Base",
      "Computer",
      "Web",
      "Add",
    ]);
    await card(page, "Computer").getByRole("combobox", { name: "What it reaches" }).waitFor();
    await window_.getByRole("navigation", { name: "Sections" }).waitFor();
    await window_.getByRole("complementary", { name: /as it will be$/ }).waitFor();
    await window_.getByRole("button", { name: "Save template" }).waitFor();
    assert.equal(await window_.getByRole("button", { name: "Build options" }).count(), 0);
    await page.close();
  }),
);
