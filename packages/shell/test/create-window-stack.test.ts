// New template's stack: each unit's section, its heading, fold and remove, which units are
// offered, and the card's row for each unit chosen.
import assert from "node:assert/strict";
import test from "node:test";
import { card, newTemplate, open, panel, withBrowser, withGateway } from "./build-kit.ts";
import { boxOf, chosen, identity, named, opened, openTemplate } from "./create-window-kit.ts";

withBrowser();

test(
  "a unit's section starts open whoever brought it, folds to its heading alone, and opens again on asking",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    const web = card(page, "Web");
    await web.getByRole("combobox", { name: "Search service" }).waitFor();
    const fold = web.getByRole("button", { name: "Fold Web" });
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await fold.click();
    assert.equal(await web.getByRole("combobox").count(), 0);
    assert.equal(
      await web.evaluate((e) => e.children[1]?.childElementCount),
      0,
      "its heading alone",
    );
    assert.equal((await web.innerText()).trim(), "Web", "with nothing said beside its name");
    await web.getByRole("button", { name: "Open Web" }).click();
    await web.getByRole("combobox", { name: "Search service" }).waitFor();

    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Web/ }).click();
    await card(page, "Web").nth(1).getByRole("combobox", { name: "Search service" }).waitFor();
    await page.close();
  }),
);

test(
  "a unit a stack holds once isn't offered while the stack has it, and one it may hold again is",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const offered = async () => {
      await panel(page).getByRole("button", { name: "Add a unit" }).click();
      const names = (await page.getByRole("menuitem").allInnerTexts()).map(
        (text) => text.split("\n")[0],
      );
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
      return names;
    };
    // An empty stack is offered every unit.
    await newTemplate(page);
    const all = await offered();
    assert.ok(all.includes("Computer") && all.includes("Web"), all.join(", "));
    // Assistant brings a computer and web search: the computer is held once, web search isn't.
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    const held = await offered();
    assert.ok(!held.includes("Computer"), `Computer isn't offered: ${held.join(", ")}`);
    assert.ok(held.includes("Web"));
    assert.equal(held.length, all.length - 1);
    // Taken out of the stack, it is offered again.
    await card(page, "Computer").getByRole("button", { name: "Remove Computer" }).click();
    await card(page, "Computer").waitFor({ state: "detached" });
    assert.deepEqual(await offered(), all);
    await page.close();
  }),
);

test(
  "New template's card has a row for each unit chosen, its logo and its title, following the options; with no units it has none and says nothing in their place",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openTemplate(page);
    const can = identity(page).getByRole("list", { name: "What it can do" });
    const rows = () => can.getByRole("listitem").allInnerTexts();
    assert.deepEqual(await rows(), []);
    assert.equal(await can.isVisible(), false, "nothing in their place");
    await named(page, /^Assistant/).click();
    await card(page, "Web").waitFor();
    assert.deepEqual(await rows(), ["Computer", "Web"]);
    assert.equal(
      await can.getByRole("listitem").first().locator("svg").filter({ visible: true }).count(),
      1,
      "its logo",
    );
    await window_.getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Agent control/ }).click();
    assert.deepEqual(await rows(), ["Computer", "Web", "Agent control"]);
    await card(page, "Web").getByRole("button", { name: "Remove Web" }).click();
    assert.deepEqual(await rows(), ["Computer", "Agent control"]);
    await page.close();
  }),
);

test(
  "each section has its heading, a logo and a title; a unit's has its fold and its remove there",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
    await opened(page);
    for (const name of ["Base", "Computer", "Web", "Add"]) {
      const heading = card(page, name).locator("[data-heading]");
      assert.equal((await boxOf(heading)).height, 40, name);
      assert.equal(await heading.locator("svg").first().isVisible(), true, `${name}'s logo`);
      assert.equal(await heading.getByRole("heading", { name, exact: true }).count(), 1);
    }
    const computer = card(page, "Computer").locator("[data-heading]");
    await computer.getByRole("button", { name: "Fold Computer" }).waitFor();
    await computer.getByRole("button", { name: "Remove Computer" }).waitFor();
    // Its questions are what they were.
    await card(page, "Computer").getByRole("combobox", { name: "Where it resides" }).waitFor();
    await page.close();
  }),
);
