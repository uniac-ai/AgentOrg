// A unit's questions in the Create window, and their answers: what each says it means, and an answer
// its provider can't give now, greyed with the provider's reason.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsRead,
  card,
  choose,
  newTemplate,
  open,
  panel,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { boxOf, opened } from "./create-window-kit.ts";

withBrowser();

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
