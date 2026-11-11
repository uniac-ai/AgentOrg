// The build panel in a real browser, over the stand-in gateway: every call is checked against the
// real `agents@1`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsRead,
  browser,
  card,
  choose,
  chooser,
  fromTemplate,
  gives,
  open,
  panel,
  plus,
  unfold,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

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
    await unfold(page, "Web");
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
    await agentsRead(page);
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
    await agentsRead(page);
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
