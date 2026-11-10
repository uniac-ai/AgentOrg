// The Create window itself: how it opens, what it offers, and what it shows first.
import assert from "node:assert/strict";
import test from "node:test";
import {
  browser,
  card,
  choose,
  fromTemplate,
  open,
  panel,
  plus,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

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

    for (let i = 0; i < 10; i++) {
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
    for (let i = 0; i < 10; i++)
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
  "the rows don't touch, and the chosen one chosen again closes the panel",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    const window_ = panel(page);
    const empty = window_.getByRole("button", { name: "Empty" });
    const assistant = window_.getByRole("button", { name: /^Assistant/ });
    await empty.waitFor();
    await page.waitForTimeout(350);
    const small = await window_.boundingBox();
    const [a, b] = [await empty.boundingBox(), await assistant.boundingBox()];
    assert.ok(a && b && small);
    assert.ok(b.y >= a.y + a.height + 2, "a gap between them");

    await assistant.click();
    const name = window_.locator("#build-name");
    await name.waitFor();
    await page.waitForTimeout(450);
    const big = await window_.boundingBox();
    assert.ok(big && big.width > small.width);
    const [c, d] = [await empty.boundingBox(), await assistant.boundingBox()];
    assert.ok(c && d && d.y >= c.y + c.height + 2, "and once the panel is open");

    await assistant.click();
    assert.equal(await assistant.getAttribute("aria-pressed"), "false");
    assert.equal(await name.count(), 1, "the panel stays while the window shrinks around it");
    await name.waitFor({ state: "detached" });
    await page.waitForTimeout(100);
    assert.deepEqual(await window_.boundingBox(), small, "back as it was");

    await empty.click();
    await name.waitFor();
    assert.equal(await empty.getAttribute("aria-pressed"), "true");
    await empty.click();
    await assistant.click();
    await page.waitForTimeout(500);
    assert.equal(await name.count(), 1, "choosing while it closes keeps it open");
    assert.equal(await assistant.getAttribute("aria-pressed"), "true");
    await page.close();
  }),
);

test(
  "a unit with nothing to fill starts as one row of its choices, and opens on asking",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    assert.equal(await card(page, "Web").getByRole("combobox").count(), 0, "folded");
    assert.equal(await card(page, "Web").locator("[data-summary]").innerText(), "Exa");
    assert.equal(await card(page, "Web").locator("[data-grants]").innerText(), "No key needed.");
    assert.equal(
      await card(page, "Computer").getByRole("combobox", { name: "Where it runs" }).count(),
      1,
      "something to fill",
    );
    await card(page, "Web").getByText("Web", { exact: true }).click();
    await card(page, "Web").getByRole("combobox", { name: "Search service" }).waitFor();
    assert.equal(await card(page, "Web").locator("[data-grants]").count(), 0);
    await page.close();
  }),
);

test(
  "a folded unit's line of what it grants stays, and a problem on it opens it",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      if (field.id === "where") field.default = "local";
      if (field.id === "workspace") delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    assert.equal(await computer.getByRole("combobox").count(), 0, "preselected, so folded");
    assert.equal(
      await computer.locator("[data-summary]").innerText(),
      "This computer, Files and terminal, Browser",
    );
    assert.match(
      await computer.locator("[data-grants]").innerText(),
      /It acts as you on this Mac\./,
    );
    assert.equal(
      await panel(page).getByRole("button", { name: "Create", exact: true }).isDisabled(),
      false,
    );

    gateway.findProblems([{ unit: 0, field: "where", message: "No service is running here." }]);
    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await computer.getByText("No service is running here.").waitFor();
    await computer.getByRole("combobox", { name: "Where it runs" }).waitFor();
    await page.close();
  }),
);

test(
  "a unit added by hand starts open, even with nothing to fill",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("list", { name: "Your agents" }).waitFor();
    await plus(page).click();
    await panel(page).getByRole("button", { name: "Empty" }).click();
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Web/ }).click();
    await card(page, "Web").getByRole("combobox", { name: "Search service" }).waitFor();
    assert.equal(await card(page, "Web").locator("[data-summary]").count(), 0);
    await page.close();
  }),
);

test(
  "a field's greyed text follows the name, isn't a value, and typing replaces it",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      if (field.id === "workspace") delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await choose(page, "Where it runs", /^This computer/);
    const name = panel(page).locator("#build-name");
    const offered = await name.getAttribute("placeholder");
    const folder = card(page, "Computer").getByLabel("Working directory", { exact: true });
    assert.equal(await folder.getAttribute("placeholder"), `~/Agents/${offered}`);
    assert.equal(await folder.inputValue(), "");
    await name.fill("Foreman");
    assert.equal(await folder.getAttribute("placeholder"), "~/Agents/Foreman");

    await panel(page).getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/#\/a\/a-6$/);
    const sent = gateway.calls.find((c) => c.method === "create")?.input as {
      stack: { units: { values: Record<string, unknown> }[] };
    };
    assert.equal("workspace" in (sent.stack.units[0]?.values ?? {}), false, "left unset");
    await page.close();
  }),
);
