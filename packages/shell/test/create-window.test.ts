// The Create window itself: how it opens, what it offers, and what it shows first. An agent's is
// small: where it starts from, its name and what it's for. A template is built in New template's
// window: the card at the left and the options in sections beside it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  agentsRead,
  browser,
  card,
  choose,
  newTemplate,
  open,
  panel,
  plus,
  SESSION,
  settingsWindow,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { sampleBuild } from "./design/samples.ts";

withBrowser();

const named = (page: Page, name: string | RegExp) => panel(page).getByRole("button", { name });
const chosen = (page: Page, name: string | RegExp) =>
  named(page, name).getAttribute("aria-current");
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  return box;
};

/** The Create window has finished opening: its own animations, as it grows to its size, are over. */
const opened = (page: Page) =>
  panel(page).evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).then(() => undefined),
  );

/** The options' sections, by their headings' words. */
const sections = (page: Page) =>
  panel(page).locator('form[aria-label="Build"] section h3').allInnerTexts();
/** The identity card, at the window's left. */
const identity = (page: Page) => panel(page).getByRole("complementary", { name: /as it will be$/ });

test(
  "Create is one small window, open on Empty: where it starts from, the face, its name and what it's for, and what that gives, clean each time",
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
    assert.equal(box.width, 480);
    // Top to bottom: where it starts from, the name, and nothing it can do with nothing chosen.
    const from = await boxOf(window_.getByRole("list", { name: "Start from" }));
    assert.ok((await boxOf(name)).y > from.y + from.height, "the name under where it starts from");
    const can = window_.getByRole("list", { name: "What it can do" });
    assert.equal(await can.count(), 0, "nothing in its place");
    assert.equal(await window_.locator("section").count(), 0, "no options");

    await name.fill("Foreman");
    await window_.getByLabel("What it's for").fill("Keeps things current");
    await named(page, /^Assistant/).click();
    assert.deepEqual(await can.getByRole("listitem").allInnerTexts(), ["Computer", "Web"]);
    assert.equal(await chosen(page, /^Assistant/), "true");
    assert.equal(await chosen(page, "Empty"), null);
    assert.equal((await boxOf(window_)).width, 480, "the same window");
    assert.equal(await name.inputValue(), "Foreman", "choosing again keeps what was typed");
    assert.equal(await window_.getByLabel("What it's for").inputValue(), "Keeps things current");
    await named(page, "Empty").click();
    await can.waitFor({ state: "detached" });
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
      assert.equal(await can.count(), 0);
      await named(page, /^Assistant/).click();
      await name.fill("Again");
    }
    // Opened from a template on its page, it is as clean.
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "Use" }).first().click();
    await can.getByText("Computer", { exact: true }).waitFor();
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
    // Not a name: what the field is, greyed.
    assert.equal(await name.getAttribute("placeholder"), "Name");
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
    await page.waitForURL(/#\/team\/a-6$/);
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
    await page.waitForURL(/#\/team\/a-7$/);
    assert.equal(
      (gateway.calls.findLast((c) => c.method === "create")?.input as { name?: string } | undefined)
        ?.name,
      "Wren",
    );
    // A template is offered none, and waits for one.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
    await name.waitFor();
    assert.equal(await name.getAttribute("placeholder"), "Name", "what the field is, greyed");
    assert.equal(await named(page, "Save template").isDisabled(), true);
    await page.close();
  }),
);

test(
  "New template's stack scrolls between the window's head and its foot, which stay",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page);
    const window_ = panel(page);
    for (let i = 0; i < 10; i++) {
      await window_.getByRole("button", { name: "Add a unit" }).click();
      await page.getByRole("menuitem", { name: /^Web/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    const create = named(page, "Save template");
    const options = window_.getByRole("button", { name: "Close" }).filter({ visible: true });
    const before = [await boxOf(create), await boxOf(options)];
    const scrolled = await card(page, "Base").evaluate((el) => {
      const scroller = el.parentElement as HTMLElement;
      scroller.scrollTop = 500;
      return scroller.scrollTop;
    });
    assert.ok(scrolled > 0, "it scrolls");
    assert.deepEqual([await boxOf(create), await boxOf(options)], before);
    const box = await boxOf(window_);
    assert.deepEqual([box.width, box.height], [920, 680], "and the window is as it was");
    await page.close();
  }),
);

test(
  "each answer says what it means before it is chosen, and under its field once it is; a field with no answer says what it is",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await newTemplate(page, "Assistant");
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
    await newTemplate(page, "Assistant");
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
    await newTemplate(page, "Assistant");
    const where = panel(page).getByRole("combobox", { name: "Where it resides" });
    // Measured once the window has finished opening, as it grows to its size, and before the list
    // opens: open, all but its list is hidden from the page's roles.
    await opened(page);
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
    await newTemplate(page, "Assistant");
    await panel(page).getByRole("combobox", { name: "Where it resides" }).click();
    const greyed = page.getByRole("option", { name: /^Its own container/ });
    assert.equal(await greyed.innerText(), "Its own container\nDocker isn't running.");
    assert.equal(await greyed.getAttribute("aria-disabled"), "true");
    await page.close();
  }),
);
test(
  "a template chosen while Create's units are still being read is the one its stack is drawn from",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    const release = gateway.hold("agents.units");
    await plus(page).click();
    await panel(page)
      .getByRole("button", { name: /^Assistant/ })
      .click();
    // No stack until its units are read, so none is drawn from what was read before.
    await page.waitForTimeout(300);
    const can = panel(page).getByRole("list", { name: "What it can do" });
    assert.equal(await can.count(), 0);
    release();
    await can.getByText("Computer", { exact: true }).waitFor();
    await can.getByText("Web", { exact: true }).waitFor();
    await page.close();
  }),
);
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
  "the foot says an agent can't work yet while signed out, a refusal is said above Create, and a template's foot says nothing of it",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    gateway.changeForm("computer", (field) => {
      delete field.required;
    });
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    await named(page, /^Assistant/).click();
    const foot = panel(page).locator("footer");
    const sentence = "Agents can't work until you sign in with ChatGPT.";
    await foot.getByText(sentence).waitFor();
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    await panel(page).getByLabel("Name").fill("Solo");
    await named(page, "Create").click();
    const said = panel(page).getByRole("alert");
    await said.getByText("The provider isn't connected.").waitFor();
    assert.ok((await boxOf(said)).y + (await boxOf(said)).height <= (await boxOf(foot)).y);
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
    await panel(page).locator("#build-name").waitFor();
    assert.equal(await panel(page).locator("footer").getByText(sentence).count(), 0);
    await page.close();
  }),
);

test(
  "Create has no menu: a template is made in New template, which has none either and waits for a name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    await named(page, /^Assistant/).click();
    assert.equal(await window_.getByRole("button", { name: "Build options" }).count(), 0);
    assert.equal(await window_.getByRole("button", { name: /Save as template/ }).count(), 0);
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
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
  "on a phone New template's card is on top, compact, the options under it, and the close at the corner",
  withGateway(async (gateway) => {
    const page = await browser().newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    await newTemplate(page);
    const window_ = panel(page);
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.deepEqual([box.x, box.width, box.height], [16, 358, 680]);
    // The card, compact: a small face beside the name and the line.
    const top = await boxOf(identity(page));
    assert.deepEqual([top.x - box.x, top.y - box.y, top.width], [0, 0, 358]);
    const face = await boxOf(
      identity(page).locator('[aria-hidden="true"]').filter({ visible: true }).first(),
    );
    assert.deepEqual([face.width, face.height], [44, 44]);
    const name = await boxOf(window_.locator("#build-name"));
    assert.ok(name.x >= face.x + face.width, "the name beside the face");
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    // What it can do, as small chips in a row.
    const chips = identity(page)
      .getByRole("list", { name: "What it can do" })
      .getByRole("listitem");
    const [first, second] = [await boxOf(chips.nth(0)), await boxOf(chips.nth(1))];
    assert.equal(first.y, second.y, "in a row");
    assert.equal(first.height, 28);
    // The options under the card.
    const from = await boxOf(window_.getByRole("list", { name: "Start from" }));
    assert.ok(from.y >= top.y + top.height, "what to start from under the card");
    // Where the window's head isn't drawn, the close is at the corner.
    const close = await boxOf(
      window_.getByRole("button", { name: "Close" }).filter({ visible: true }),
    );
    assert.deepEqual([box.x + box.width - (close.x + close.width), close.y - box.y], [8, 8]);
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

/** Opens Create from Team, at rest once it has opened. */
async function openCreate(page: Page) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  await opened(page);
  return panel(page);
}
/** Opens New template from Settings, at rest once its stack is drawn and it has opened. */
async function openTemplate(page: Page) {
  await newTemplate(page);
  await opened(page);
  return panel(page);
}
/** A part's middle, from the top. */
const middle = async (part: Locator) => {
  const box = await boxOf(part);
  return Math.round((box.y + box.height / 2) * 10) / 10;
};

test(
  "the window is Create New Agent, its title and close on one line; it is rgb(38, 38, 38), or white in the light theme, what it can do a little lighter",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    const line = await middle(window_.getByRole("heading", { name: "Create New Agent" }));
    assert.equal(
      await middle(window_.getByRole("button", { name: "Close" }).filter({ visible: true })),
      line,
    );
    await named(page, /^Assistant/).click();
    const colours = async () => [
      await window_.evaluate((e) => getComputedStyle(e).backgroundColor),
      await window_
        .getByRole("list", { name: "What it can do" })
        .getByRole("listitem")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ];
    assert.deepEqual(await colours(), ["rgb(38, 38, 38)", "rgb(46, 46, 46)"]);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    // Once the window's own change of colour has run.
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.deepEqual(await colours(), ["rgb(255, 255, 255)", "rgb(246, 246, 246)"]);
    await page.close();
  }),
);

test(
  "Create shows the face, the name offered and what the base or the template is; what is typed is its name, the face's letters and its line; the keyboard starts in the name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    const name = window_.locator("#build-name");
    const line = window_.getByLabel("What it's for");
    assert.equal(await name.evaluate((e) => e === document.activeElement), true, "the keyboard");
    assert.equal(await name.getAttribute("placeholder"), "Scout");
    // The face's disc, with its letters.
    const disc = window_.locator('span[aria-hidden="true"].rounded-full').first();
    assert.equal(await disc.innerText(), "S");
    assert.equal((await boxOf(disc)).width, 80);
    assert.equal(await line.getAttribute("placeholder"), "Chats and uses what you connect");
    await named(page, /^Assistant/).click();
    await window_.getByRole("list", { name: "What it can do" }).waitFor();
    assert.equal(await line.getAttribute("placeholder"), "Does what you ask on a computer");
    const colour = () => disc.evaluate((e) => getComputedStyle(e).backgroundImage);
    const was = await colour();
    await name.fill("Foreman");
    assert.equal(await disc.innerText(), "F");
    assert.equal(await colour(), was, "its colour stays");
    await line.fill("Keeps dependencies current");
    assert.equal(await line.inputValue(), "Keeps dependencies current");
    // Typed in place: no box around either.
    for (const field of [name, line])
      assert.deepEqual(
        await field.evaluate((e) => [
          getComputedStyle(e).borderTopWidth,
          getComputedStyle(e).backgroundColor,
        ]),
        ["0px", "rgba(0, 0, 0, 0)"],
      );
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
  "New template's row to start from is of small cards that scrolls sideways when longer than the window; choosing one marks it and fills the options",
  withGateway(async (gateway) => {
    // The design's sample, with more templates than the row has room for.
    sampleBuild(gateway);
    const page = await open(gateway);
    const window_ = await openTemplate(page);
    const row = window_.getByRole("list", { name: "Start from" });
    const tiles = row.getByRole("button");
    const [first, second] = [await boxOf(tiles.nth(0)), await boxOf(tiles.nth(1))];
    assert.deepEqual([first.width, first.height], [184, 60]);
    assert.equal(first.y, second.y, "one row");
    assert.equal(second.x, first.x + first.width + 8);
    assert.equal(await chosen(page, "Empty"), "true");
    const scrolled = await row.evaluate((e) => {
      e.scrollLeft = 100;
      return [e.scrollWidth > e.clientWidth, e.scrollLeft, getComputedStyle(e).scrollbarWidth];
    });
    assert.deepEqual(scrolled, [true, 100, "none"], "it scrolls sideways, with no bar");
    await named(page, /^Assistant/).click();
    await card(page, "Computer").waitFor();
    assert.equal(await chosen(page, /^Assistant/), "true");
    assert.equal(await chosen(page, "Empty"), null);
    assert.deepEqual(await sections(page), ["Base", "Computer", "Web", "Add"]);
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

test(
  "it opens and closes in the page's window times, growing a little; with reduced motion it only fades",
  withGateway(async (gateway) => {
    const motion = (part: Locator, phase: "enter" | "exit") =>
      part.evaluate((e, which) => {
        const style = getComputedStyle(e);
        const scale = style.getPropertyValue(`--tw-${which}-scale`).replace(/\s/g, "");
        const percent = /^calc\((\d+)\*1%\)$/.exec(scale)?.[1];
        return [
          style.animationName,
          style.animationDuration,
          percent ? Number(percent) / 100 : Number(scale),
        ];
      }, phase);
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    assert.deepEqual(await motion(panel(page), "enter"), ["enter", "0.22s", 0.96]);
    await opened(page);
    await page.keyboard.press("Escape");
    const closing = page.locator('[data-slot="dialog-content"][data-state="closed"]');
    assert.deepEqual(await motion(closing, "exit"), ["exit", "0.16s", 0.96]);
    await page.close();

    const reduced = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await reduced.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await reduced.goto(`${gateway.url}/#/team`);
    await agentsRead(reduced);
    await plus(reduced).click();
    assert.deepEqual(await motion(panel(reduced), "enter"), ["enter", "0.22s", 1]);
    await reduced.close();
  }),
);
