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
  "an agent has to be named; what it's for is optional",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const name = panel(page).locator("#build-name");
    await name.waitFor();
    assert.equal(await name.getAttribute("placeholder"), null, "no name is offered");
    const create = named(page, "Create");
    assert.equal(await create.isDisabled(), true);
    await name.fill("  ");
    assert.equal(await create.isDisabled(), true, "blanks aren't a name");
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
  "what the chosen answer grants stays under its field, and a field offers nothing else about itself",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await fromTemplate(page, "Assistant");
    const computer = card(page, "Computer");
    assert.doesNotMatch(await computer.innerText(), /It acts as you on this Mac\./);
    await panel(page).getByRole("combobox", { name: "Where it resides" }).click();
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), [
      "This computer",
      "Its own container",
    ]);
    await page.getByRole("option", { name: "This computer" }).click();
    const note = computer.getByText("It acts as you on this Mac.");
    await note.waitFor();
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
    const plain = computer.getByText("Isolated from your files.");
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
    assert.doesNotMatch(await computer.innerText(), /A browser of its own/);
    assert.equal(await computer.getByRole("button", { name: /^(About|Browse)/ }).count(), 0);
    const folder = computer.getByLabel("Workspace directory", { exact: true });
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
      "~/Agents/{name}",
      "as its unit wrote it",
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

test(
  "on a phone what to start from runs across the top by name, and the stack fills the rest",
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
    assert.equal(await window_.getByRole("button", { name: "Build options" }).isVisible(), false);
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
