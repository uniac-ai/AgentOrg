// The window that builds a stack, New template's, and what Create's check says, in a real browser
// over the stand-in gateway: every call is checked against the real `agents@1`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsRead,
  card,
  choose,
  gives,
  newTemplate,
  open,
  panel,
  plus,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";

withBrowser();

test(
  "a template's values are prefills: each can change, and so can its units",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    assert.equal(
      await computer.getByRole("combobox", { name: "What it reaches" }).innerText(),
      "Files and terminal",
    );
    assert.equal(await computer.getByRole("switch", { name: "With a browser" }).isChecked(), true);
    await choose(page, "What it reaches", /^Read-only files/);
    await computer.getByRole("switch", { name: "With a browser" }).click();
    await card(page, "Web").getByRole("button", { name: "Remove Web" }).click();
    assert.equal(await card(page, "Web").count(), 0);
    await page.close();
  }),
);

test(
  "the card says what it gives as the answers change, and what each answer grants",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    assert.match(
      await gives(page, "Computer"),
      /computer, browser\s+terminal, files, computer, browser/,
    );
    await choose(page, "What it reaches", /^Read-only files/);
    assert.match(await gives(page, "Computer"), /computer, browser\s+files, computer, browser/);
    await card(page, "Computer").getByRole("switch", { name: "With a browser" }).click();
    assert.doesNotMatch(await gives(page, "Computer"), /browser/);
    await choose(page, "Where it resides", /^This computer/);
    const text = await card(page, "Computer").innerText();
    assert.match(text, /It acts as you on this Mac\./);
    assert.match(text, /Reads files in the workspace directory/);
    await page.close();
  }),
);

test(
  "fields come and go with the answers, and Save template waits for none of them",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    // A template may leave its answers open: they are asked where it's used.
    const save = panel(page).getByRole("button", { name: "Save template" });
    assert.equal(await save.isDisabled(), false, "where is still open");
    const folder = computer.getByLabel("Workspace directory", { exact: true });
    assert.equal(await folder.count(), 0);
    await choose(page, "Where it resides", /^This computer/);
    await folder.waitFor();
    await choose(page, "Where it resides", /^Its own container/);
    await computer.getByLabel("Image").waitFor();
    await computer.getByLabel("Path in the container").waitFor();
    assert.equal(await folder.count(), 0);
    assert.equal(await save.isDisabled(), false);
    await page.close();
  }),
);

test(
  "a unit added in Setup sends what's shown, with a secret apart",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.goto(`${new URL(page.url()).origin}/#/a/a-triage`);
    const sheet = await openSetup(page, "Triage");
    await sheet.getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: "Web" }).click();
    const web = page.getByRole("dialog", { name: "Triage's web" });
    await web.getByRole("combobox", { name: "Search service" }).click();
    await page.getByRole("option", { name: /^Tavily/ }).click();
    const key = web.getByLabel("Key");
    assert.equal(await key.getAttribute("type"), "password");
    await key.fill("the-key");
    await web.getByRole("button", { name: "Save" }).click();
    await web.waitFor({ state: "detached" });
    for (let i = 0; i < 600 && !gateway.calls.some((c) => c.method === "addUnit"); i++)
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    assert.deepEqual(gateway.calls.find((c) => c.method === "addUnit")?.input, {
      agent: "a-triage",
      unit: {
        provider: "units",
        unit: "web",
        values: { service: "tavily" },
        secrets: { key: "the-key" },
      },
    });
    await page.close();
  }),
);

test(
  "what Create's check finds is said above Create, of a unit and of the whole, and a refusal says why",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    await panel(page).locator("#build-name").waitFor();
    await panel(page).getByLabel("Name").fill("Solo");
    const create = panel(page).getByRole("button", { name: "Create", exact: true });
    gateway.findProblems([
      { unit: 0, field: "service", message: "That service isn't answering." },
      { unit: 0, message: "Something about the unit." },
      { message: "Something about the stack." },
    ]);
    await create.click();
    const said = panel(page).getByRole("alert");
    await said
      .getByText(
        "That service isn't answering. Something about the unit. Something about the stack.",
        { exact: true },
      )
      .waitFor();
    assert.equal(gateway.calls.filter((c) => c.method === "create").length, 0);
    gateway.findProblems([]);
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    await panel(page).getByLabel("Name").fill("Solo two");
    assert.equal(await said.count(), 0, "a change clears them");
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
    await newTemplate(page);
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Agent control/ }).click();
    const control = card(page, "Agent control");
    await control.getByText("Needs a computer above it").waitFor();
    await control.getByRole("button", { name: "Add it" }).click();
    assert.deepEqual(
      await panel(page).locator('form[aria-label="Build"] section h3').allInnerTexts(),
      ["Base", "Computer", "Agent control", "Add"],
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
    // A number with a unit word has the word beside it; one without is as wide as its field.
    const [box, word] = [
      await limit.boundingBox(),
      await control.getByText("at once").boundingBox(),
    ];
    assert.ok(box && word && word.x >= box.x + box.width, "the word is on its right");
    assert.ok(word.y < box.y + box.height && word.y + word.height > box.y, "on its row");
    const ceiling = control.getByLabel("Ceiling");
    assert.equal(
      (await ceiling.boundingBox())?.width,
      (await control.getByLabel("Colour").boundingBox())?.width,
      "a number with no word is as wide as any box",
    );
    assert.ok(box.width < ((await ceiling.boundingBox())?.width ?? 0));
    await page.close();
  }),
);

test(
  "a unit no connected provider offers says so, holds back Save template, and can be removed",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "From elsewhere");
    const create = panel(page).getByRole("button", { name: "Save template" });
    await card(page, "mystery").getByText("Not available here.").waitFor();
    assert.equal(await create.isDisabled(), true);
    await panel(page).getByRole("button", { name: "Remove mystery" }).click();
    assert.equal(await create.isDisabled(), false);
    await page.close();
  }),
);
