// The Create window itself: how it opens, what it offers, and what it shows first.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  agentsRead,
  browser,
  card,
  choose,
  fromTemplate,
  open,
  panel,
  plus,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

const named = (page: Page, name: string | RegExp) => panel(page).getByRole("button", { name });
const chosen = (page: Page, name: string | RegExp) =>
  named(page, name).getAttribute("aria-current");
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  return box;
};

test(
  "Create is one window, open on an empty stack: what to start from on the left, the stack beside it, clean each time",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    const name = window_.locator("#build-name");
    await name.waitFor();
    assert.equal(await chosen(page, "Empty"), "true", "nothing is chosen for the person");
    assert.equal(await name.inputValue(), "");
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.deepEqual([box.width, box.height], [840, 700]);
    const from = await boxOf(window_.getByRole("navigation", { name: "Start from" }));
    assert.deepEqual([from.x - box.x, from.y - box.y, from.width, from.height], [0, 0, 250, 700]);
    assert.ok((await boxOf(name)).x > from.x + from.width, "the stack is on its right");
    assert.equal(
      await window_.getByRole("list", { name: "Units" }).getByRole("listitem").count(),
      1,
      "an empty stack is its base alone",
    );

    await name.fill("Foreman");
    await window_.getByLabel("What it's for").fill("Keeps things current");
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    assert.equal(await chosen(page, /^Assistant/), "true");
    assert.equal(await chosen(page, "Empty"), null);
    assert.deepEqual(await boxOf(window_), box, "the same window, the same size");
    assert.equal(await name.inputValue(), "Foreman", "choosing again keeps what was typed");
    assert.equal(await window_.getByLabel("What it's for").inputValue(), "Keeps things current");
    await named(page, "Empty").click();
    await card(page, "Computer").waitFor({ state: "detached" });
    assert.equal(await name.inputValue(), "Foreman");
    await named(page, /^Assistant/).click();

    // What opens from inside it counts as inside it.
    await choose(page, "Where it resides", /^This computer/);
    await window_.getByRole("button", { name: "Add a unit" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(await name.inputValue(), "Foreman");

    for (const close of [
      () => page.mouse.click(8, 8),
      () => window_.getByRole("button", { name: "Close" }).click(),
    ]) {
      await close();
      await window_.waitFor({ state: "detached" });
      await plus(page).click();
      await name.waitFor();
      assert.equal(await name.inputValue(), "", "the plus starts clean");
      assert.equal(await chosen(page, "Empty"), "true");
      assert.equal(await card(page, "Computer").count(), 0);
      await named(page, /^Assistant/).click();
      await name.fill("Again");
    }
    // Opened from a template on its page, it is as clean.
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    await page.getByRole("main").getByRole("button", { name: "Use" }).first().click();
    await card(page, "Computer").waitFor();
    assert.equal(await name.inputValue(), "", "what was typed went with the window");
    await page.close();
  }),
);

test(
  "an agent is offered a name no agent has, used when none is typed; a template has to be named; what it's for is optional",
  withGateway(async (gateway) => {
    // An agent already has the first name, in another case: the next is offered.
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.name = "scout";
    // Until the agents are read, none is offered and nothing can be made unnamed.
    const release = gateway.hold("agents.list");
    const page = await open(gateway);
    await plus(page).click();
    const name = panel(page).locator("#build-name");
    await name.waitFor();
    assert.equal((await name.getAttribute("placeholder")) ?? "", "");
    assert.equal(await named(page, "Create").isDisabled(), true);
    release();
    await agentsRead(page);
    await page.waitForFunction(
      () => document.querySelector("#build-name")?.getAttribute("placeholder") === "Wren",
    );
    // A read that fails lists none: the name offered is still one no agent has.
    gateway.refuseNext("agents.list", "unavailable", "Not now.");
    gateway.setAccount("signed_in");
    await page.locator('ul[aria-label="Agents"] li').first().waitFor({ state: "detached" });
    assert.equal(await name.getAttribute("placeholder"), "Wren", "greyed, the name it is offered");
    assert.equal(await name.evaluate((e) => e === document.activeElement), true, "the keyboard");
    const create = named(page, "Create");
    assert.equal(await create.isDisabled(), false, "it can be made at once");
    await name.fill("  ");
    assert.equal(await create.isDisabled(), false, "blanks are no name: the offered one is used");
    await name.fill(" Solo ");
    assert.equal(await create.isDisabled(), false);
    await create.click();
    await page.waitForURL(/#\/a\/a-6$/);
    const sent = gateway.calls.find((c) => c.method === "create")?.input as {
      name: string;
      purpose?: string;
    };
    assert.equal(sent.name, "Solo");
    assert.equal(sent.purpose, undefined);
    // Nothing typed, the offered name is the agent's.
    await panel(page).waitFor({ state: "detached" });
    await plus(page).click();
    await name.waitFor();
    await named(page, "Create").click();
    await page.waitForURL(/#\/a\/a-7$/);
    assert.equal(
      (gateway.calls.findLast((c) => c.method === "create")?.input as { name?: string } | undefined)
        ?.name,
      "Wren",
    );
    // A template is offered none, and waits for one.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    await page.getByRole("main").getByRole("button", { name: "New template", exact: true }).click();
    await name.waitFor();
    assert.equal(await name.getAttribute("placeholder"), null);
    assert.equal(await named(page, "Save template").isDisabled(), true);
    await page.close();
  }),
);

test(
  "the stack scrolls between the window's head and its foot, which stay",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    await window_.locator("#build-name").waitFor();
    for (let i = 0; i < 10; i++) {
      await window_.getByRole("button", { name: "Add a unit" }).click();
      await page.getByRole("menuitem", { name: /^Web/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    const create = named(page, "Create");
    const options = window_.getByRole("button", { name: "Build options" });
    const before = [await boxOf(create), await boxOf(options)];
    const units = window_.getByRole("list", { name: "Units" });
    const scrolled = await units.evaluate((el) => {
      const scroller = el.parentElement as HTMLElement;
      scroller.scrollTop = 500;
      return scroller.scrollTop;
    });
    assert.ok(scrolled > 0, "it scrolls");
    assert.deepEqual([await boxOf(create), await boxOf(options)], before);
    const box = await boxOf(window_);
    assert.deepEqual([box.width, box.height], [840, 700], "and the window is as it was");
    await page.close();
  }),
);

test(
  "each answer says what it means before it is chosen, and under its field once it is; a field with no answer says what it is",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    // The caution colour, read while the card can be reached: an open list hides the rest.
    const caution = await computer.evaluate((e) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--warn)";
      e.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    // Nothing chosen, the field says what it is under itself; the list says it of each answer.
    const what = computer.locator("p", { hasText: "Where its computer runs." });
    await what.waitFor();
    assert.notEqual(await what.evaluate((e) => getComputedStyle(e).color), caution);
    assert.equal(
      await computer.locator("p", { hasText: "It acts as you on this Mac." }).count(),
      0,
    );
    await panel(page).getByRole("combobox", { name: "Where it resides" }).click();
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), [
      "This computer\nIt acts as you on this Mac.",
      "Its own container\nIsolated from your files.",
    ]);
    // In the open list, only the answer its unit marks as a caution is in the caution colour.
    const colourOf = (text: string) =>
      page
        .getByRole("option")
        .getByText(text, { exact: true })
        .evaluate((e) => getComputedStyle(e).color);
    assert.equal(await colourOf("It acts as you on this Mac."), caution);
    assert.notEqual(await colourOf("Isolated from your files."), caution);
    await page.getByRole("option", { name: /^This computer/ }).hover();
    assert.equal(await colourOf("It acts as you on this Mac."), caution, "pointed at, too");
    await page.getByRole("option", { name: /^This computer/ }).click();
    // What is said under the field: a line of its own, apart from the list's hidden copy.
    const note = computer.locator("p", { hasText: "It acts as you on this Mac." });
    await note.waitFor();
    assert.equal(await what.count(), 0, "in place of what the field is");
    const where = await boxOf(computer.getByRole("combobox", { name: "Where it resides" }));
    assert.ok((await boxOf(note)).y >= where.y + where.height, "under the answer");
    assert.equal(
      await note.evaluate((e) => getComputedStyle(e).color),
      await computer.evaluate((e) => {
        const probe = document.createElement("i");
        probe.style.color = "var(--warn)";
        e.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
      "in the colour of a caution, which its unit marks it as",
    );
    // An answer its unit doesn't mark says what it means in the muted colour.
    await choose(page, "Where it resides", /^Its own container/);
    const plain = computer.locator("p", { hasText: "Isolated from your files." });
    await plain.waitFor();
    assert.equal(await note.count(), 0);
    assert.equal(
      await plain.evaluate((e) => getComputedStyle(e).color),
      await computer.getByText("Where it resides", { exact: true }).evaluate((e) => {
        const probe = document.createElement("i");
        probe.className = "text-muted-foreground";
        e.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
      "muted",
    );
    assert.notEqual(
      await plain.evaluate((e) => getComputedStyle(e).color),
      await computer.evaluate((e) => {
        const probe = document.createElement("i");
        probe.style.color = "var(--warn)";
        e.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    );
    // A field with no answer to choose says what it is, muted, under its control.
    const browser = computer.getByText("A browser of its own. It can open any site.");
    await browser.waitFor();
    assert.notEqual(await browser.evaluate((e) => getComputedStyle(e).color), caution);
    assert.equal(await computer.getByRole("button", { name: /^(About|Browse)/ }).count(), 0);
    const folder = computer.getByLabel("Workspace directory", { exact: true });
    await page.close();
  }),
);

test(
  "an answer its provider can't give now is greyed with the provider's reason, and isn't chosen",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      const own = field.options?.find((o) => o.value === "container");
      if (own) own.unavailable = "Docker isn't running.";
    });
    gateway.changeForm("control", (field) => {
      const made = field.options?.find((o) => o.value === "new");
      if (made) made.unavailable = "No provider here makes computers.";
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const where = panel(page).getByRole("combobox", { name: "Where it resides" });
    await where.click();
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), [
      "This computer\nIt acts as you on this Mac.",
      "Its own container\nDocker isn't running.",
    ]);
    const greyed = page.getByRole("option", { name: /^Its own container/ });
    assert.equal(await greyed.getAttribute("aria-disabled"), "true");
    await greyed.click({ force: true });
    await page.keyboard.press("Escape");
    assert.equal((await where.innerText()).trim(), "Choose");
    // A box its provider can't give now can't be ticked, and says why.
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Agent control/ }).click();
    const places = card(page, "Agent control").getByRole("group", { name: "Where they work" });
    await places.getByText("No provider here makes computers.").waitFor();
    assert.equal(await places.getByRole("checkbox", { name: "A new computer" }).isDisabled(), true);
    assert.equal(
      await places.getByRole("checkbox", { name: "Its own computer" }).isDisabled(),
      false,
    );
    await page.close();
  }),
);
test(
  "a choice's list is as wide as its field, and a long reason wraps within it, inside the dialog",
  withGateway(async (gateway) => {
    const long =
      "Edge's remote debugging is off, or Edge isn't open. On this machine, open Edge, version 144 or later, go to its inspect page, edge://inspect/#remote-debugging, and switch on remote debugging. Edge then asks you to allow each connection.";
    gateway.changeForm("computer", (field) => {
      const own = field.options?.find((o) => o.value === "container");
      if (own) own.unavailable = long;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const where = panel(page).getByRole("combobox", { name: "Where it resides" });
    // Measured before it opens: open, all but its list is hidden from the page's roles.
    const [field, dialog] = await Promise.all([where.boundingBox(), panel(page).boundingBox()]);
    await where.click();
    const list = page.getByRole("listbox");
    await list.waitFor();
    const box = await list.boundingBox();
    assert.ok(field && box && dialog);
    assert.ok(
      Math.abs(box.width - field.width) <= 1,
      `the list is ${box.width}, its field ${field.width}`,
    );
    assert.ok(
      box.x >= dialog.x && box.x + box.width <= dialog.x + dialog.width,
      "inside the dialog",
    );
    // The reason is all there, on several lines.
    const greyed = page.getByRole("option", { name: /^Its own container/ });
    assert.equal(await greyed.innerText(), `Its own container\n${long}`);
    const reason = greyed.getByText(long);
    const lines = await reason.evaluate(
      (el) =>
        el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
    );
    assert.ok(lines > 2, `${lines} lines`);
    await page.close();
  }),
);

test(
  "an answer greyed after the page was read shows greyed when Create opens, as the machine stands then",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    // The page has read Create's form; then its provider can't give a container any more, and says
    // nothing of it, as a part switched off on the machine.
    await page.waitForTimeout(300);
    gateway.changeForm("computer", (field) => {
      const own = field.options?.find((o) => o.value === "container");
      if (own) own.unavailable = "Docker isn't running.";
    });
    await fromTemplate(page, "Assistant");
    await panel(page).getByRole("combobox", { name: "Where it resides" }).click();
    const greyed = page.getByRole("option", { name: /^Its own container/ });
    assert.equal(await greyed.innerText(), "Its own container\nDocker isn't running.");
    assert.equal(await greyed.getAttribute("aria-disabled"), "true");
    await page.close();
  }),
);
test(
  "a unit's card starts open whoever brought it, folds to its head alone, and opens again on asking",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const web = card(page, "Web");
    await web.getByRole("combobox", { name: "Search service" }).waitFor();
    const fold = web.getByRole("button", { name: "Fold Web" });
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await fold.click();
    assert.equal(await web.getByRole("combobox").count(), 0);
    assert.equal((await boxOf(web)).height, 40, "its head alone");
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
  "a problem found on a folded card opens it",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      if (field.id === "where") field.default = "local";
      if (field.id === "workspace") delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await panel(page).getByLabel("Name").fill("Foreman");
    const computer = card(page, "Computer");
    await computer.getByRole("button", { name: "Fold Computer" }).click();
    assert.equal(await computer.getByRole("combobox").count(), 0);
    gateway.findProblems([{ unit: 0, field: "where", message: "No service is running here." }]);
    await named(page, "Create").click();
    await computer.getByText("No service is running here.").waitFor();
    await computer.getByRole("combobox", { name: "Where it resides" }).waitFor();
    // Folded again and found again, it opens again.
    await computer.getByRole("button", { name: "Fold Computer" }).click();
    assert.equal(await computer.getByRole("combobox").count(), 0);
    await named(page, "Create").click();
    await computer.getByText("No service is running here.").waitFor();
    await page.close();
  }),
);

test(
  "the foot says an agent can't work yet while signed out, gives way to a refusal, and says nothing for a template",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    gateway.changeForm("computer", (field) => {
      delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const foot = panel(page).locator("footer");
    const sentence = "Agents can't work until you sign in with ChatGPT.";
    await foot.getByText(sentence).waitFor();
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    await panel(page).getByLabel("Name").fill("Solo");
    await named(page, "Create").click();
    await foot.getByRole("alert").getByText("The provider isn't connected.").waitFor();
    assert.equal(await foot.getByText(sentence).count(), 0, "one or the other");
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    await page.getByRole("main").getByRole("button", { name: "New template", exact: true }).click();
    await panel(page).locator("#build-name").waitFor();
    assert.equal(await panel(page).locator("footer").getByText(sentence).count(), 0);
    await page.close();
  }),
);

test(
  "a field's greyed text follows the name and isn't a value",
  withGateway(async (gateway) => {
    gateway.changeForm("computer", (field) => {
      if (field.id === "workspace") delete field.required;
    });
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    await choose(page, "Where it resides", /^This computer/);
    const name = panel(page).locator("#build-name");
    const folder = card(page, "Computer").getByLabel("Workspace directory", { exact: true });
    assert.equal(
      await folder.getAttribute("placeholder"),
      "~/Agents/Scout",
      "with the name the agent is offered",
    );
    assert.equal(await folder.inputValue(), "");
    await name.fill("Foreman");
    assert.equal(await folder.getAttribute("placeholder"), "~/Agents/Foreman");

    await named(page, "Create").click();
    await page.waitForURL(/#\/a\/a-6$/);
    const sent = gateway.calls.find((c) => c.method === "create")?.input as {
      stack: { units: { values: Record<string, unknown> }[] };
    };
    const [first] = sent.stack.units;
    assert.ok(first, "the computer is in the stack");
    assert.equal("workspace" in first.values, false, "left unset");
    await page.close();
  }),
);

test(
  "Save as template is in the window's menu for an agent, and a new template has none",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const window_ = panel(page);
    assert.equal(await window_.getByRole("button", { name: /Save as template/ }).count(), 0);
    // A stack with a unit nobody offers can't be kept.
    await named(page, /^From elsewhere/).click();
    await card(page, "mystery").waitFor();
    await window_.getByRole("button", { name: "Build options" }).click();
    assert.equal(await page.getByRole("menuitem").getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    // From nothing, a template has no name to offer, and waits for one.
    await named(page, "Empty").click();
    await window_.getByRole("button", { name: "Build options" }).click();
    await page.getByRole("menuitem").click();
    const unnamed = page.getByRole("dialog", { name: "Save as template" });
    assert.equal(await unnamed.getByLabel("Template name").inputValue(), "");
    assert.equal(await unnamed.getByRole("button", { name: "Save" }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await unnamed.waitFor({ state: "detached" });
    await named(page, /^Assistant/).click();
    await window_.getByRole("button", { name: "Build options" }).click();
    assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), ["Save as template…"]);
    await page.getByRole("menuitem").click();
    const dialog = page.getByRole("dialog", { name: "Save as template" });
    assert.equal(await dialog.getByLabel("Template name").inputValue(), "Assistant copy");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await window_.locator("#build-name").waitFor();
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Templates" })
      .click();
    await page.getByRole("main").getByRole("button", { name: "New template", exact: true }).click();
    const fresh = page.getByRole("dialog", { name: "New template" });
    await fresh.locator("#build-name").waitFor();
    assert.equal(await fresh.getByRole("button", { name: "Build options" }).count(), 0);
    assert.equal(
      await fresh.getByRole("button", { name: "Empty" }).getAttribute("aria-current"),
      "true",
    );
    const save = fresh.getByRole("button", { name: "Save template" });
    assert.equal(await save.isDisabled(), true, "a template has to be named");
    await fresh.getByRole("button", { name: /^Assistant/ }).click();
    assert.equal(await fresh.locator("#build-name").inputValue(), "Assistant copy");
    assert.equal(await save.isDisabled(), false);
    await page.close();
  }),
);

/** Assistant, picked on a phone, where what to start from runs across the top. */
const fromAssistantOnPhone = async (page: Page) => {
  await named(page, /^Assistant/).click();
  await card(page, "Computer").waitFor();
};

test(
  "on a phone what to start from runs across the top by name, the stack fills the rest, and the window's menu is at its foot",
  withGateway(async (gateway) => {
    const page = await browser().newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/`);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
    const window_ = panel(page);
    await window_.locator("#build-name").waitFor();
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.deepEqual([box.x, box.width, box.height], [16, 358, 700]);
    const from = await boxOf(window_.getByRole("navigation", { name: "Start from" }));
    assert.deepEqual([from.x, from.y - box.y, from.width, from.height], [16, 0, 358, 68]);
    const [empty, assistant] = [
      await boxOf(named(page, "Empty")),
      await boxOf(named(page, /^Assistant/)),
    ];
    assert.equal(empty.y, assistant.y, "one row");
    assert.ok(assistant.x >= empty.x + empty.width);
    assert.equal(
      (await named(page, /^Assistant/).innerText()).trim(),
      "Assistant",
      "by name alone",
    );
    // Where the window's head isn't drawn, its menu is at the foot, left of Create.
    const options = window_.locator("footer").getByRole("button", { name: "Build options" });
    await fromAssistantOnPhone(page);
    const [menu, create] = [await boxOf(options), await boxOf(named(page, "Create"))];
    assert.equal(menu.y + menu.height / 2, create.y + create.height / 2, "on Create's row");
    assert.ok(menu.x < create.x && menu.x - box.x < 40, "at the foot's left");
    await options.click();
    await page.getByRole("menuitem", { name: "Save as template…" }).waitFor();
    await page.keyboard.press("Escape");
    const form = await boxOf(window_.getByRole("form", { name: "Build" }));
    assert.deepEqual([form.x, form.y, form.width, form.height], [16, box.y + 68, 358, 632]);
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
    await agentsRead(page);
    await plus(page).click();
    await panel(page).locator("#build-name").waitFor();
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
