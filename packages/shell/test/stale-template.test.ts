// A template whose answers its unit no longer asks is refused in Create, as management refuses
// them when it is called directly, and the refusal is said above Create; saved again
// from Settings, it keeps only what its units ask, and creates. In a real browser over the
// stand-in gateway, which refuses what management refuses.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { type Gateway, open, panel, withBrowser, withGateway } from "./build-kit.ts";
import type { Template } from "./stand-in.ts";

withBrowser();

const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";

/** A template saved before, its unit answered as its form asked then. */
const kept = (title: string, unit: string, values: Record<string, string>): Template => ({
  id: title.toLowerCase().replaceAll(" ", "-"),
  title,
  description: "Saved before",
  base: { provider: "AgentOrg", creatable: "assistant" },
  units: [{ provider: "AgentOrg", unit, values }],
});
/** A new computer, a container, chosen where the Computer asked which computer. */
const MADE = kept("Kept made", "computer", { kind: "new", made: "container", access: "terminal" });
/** This computer, chosen there. */
const WHOLE = kept("Kept whole", "computer", {
  kind: "this",
  workspace: "~/Agents/Kept",
  access: "terminal",
});

const settled = (window: Locator) =>
  window.evaluate((e) =>
    Promise.allSettled(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );
/** Settings' templates: from the bar, or where Settings is open still. */
async function templates(page: Page) {
  const list = page.getByRole("list", { name: "Templates" });
  if (!(await list.isVisible()))
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
  await list.waitFor();
  return list;
}
const row = (list: Locator, title: string) =>
  list.getByRole("listitem").filter({ has: list.page().getByText(title, { exact: true }) });

/** A template used from Settings, named, and Create pressed: from which call on it was. */
async function use(gateway: Gateway, page: Page, title: string) {
  await row(await templates(page), title)
    .getByRole("button", { name: "Use" })
    .click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  await settled(panel(page));
  await panel(page).getByLabel("Name").fill("Kept");
  const from = gateway.calls.length;
  await panel(page).getByRole("button", { name: "Create", exact: true }).click();
  return from;
}
const made = (gateway: Gateway, from: number) =>
  gateway.calls.slice(from).filter((c) => c.method === "create");
/** Made: the window closes once management has made it. */
async function created(gateway: Gateway, page: Page, from: number) {
  await panel(page).waitFor({ state: "detached" });
  assert.equal(made(gateway, from).length, 1, "made");
}

/**
 * What Create's check refused, read at one moment: its words, whether they are above Create, and
 * whether they are in the problem colour.
 */
const refusal = (page: Page) =>
  panel(page).evaluate((e) => {
    const said = e.querySelector('[role="alert"]');
    const create = [...e.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Create",
    );
    if (!said || !create) return null;
    const probe = document.createElement("i");
    probe.style.color = "var(--bad)";
    e.append(probe);
    const bad = getComputedStyle(probe).color;
    probe.remove();
    return {
      words: said.textContent,
      above: said.getBoundingClientRect().bottom <= create.getBoundingClientRect().top,
      bad: getComputedStyle(said).color === bad,
    };
  });

test(
  "where the Computer states this computer, a template that answered which computer is refused above Create in management's words, and nothing is made",
  withGateway(async (gateway) => {
    gateway.stateComputer(READY);
    gateway.addTemplate(MADE);
    gateway.addTemplate(WHOLE);
    const page = await open(gateway);
    for (const [template, said] of [
      [MADE, ["This unit has no field kind.", "This unit has no field made."]],
      [WHOLE, ["This unit has no field kind."]],
    ] as const) {
      const from = await use(gateway, page, template.title);
      const words = said.join(" ");
      await panel(page).getByRole("alert").getByText(words, { exact: true }).waitFor();
      assert.deepEqual(await refusal(page), { words, above: true, bad: true }, template.title);
      assert.equal(made(gateway, from).length, 0, `${template.title}: nothing made`);
      await page.keyboard.press("Escape");
      await panel(page).waitFor({ state: "detached" });
    }
    await page.close();
  }),
);

test(
  "saved again from Settings, such a template keeps only what its unit asks, and creates",
  withGateway(async (gateway) => {
    gateway.stateComputer(READY);
    gateway.addTemplate(MADE);
    gateway.addTemplate(WHOLE);
    const page = await open(gateway);
    for (const [template, asked] of [
      [MADE, { access: "terminal" }],
      [WHOLE, { workspace: "~/Agents/Kept", access: "terminal" }],
    ] as const) {
      const list = await templates(page);
      await row(list, template.title)
        .getByRole("button", { name: `New template from ${template.title}` })
        .click();
      await panel(page).getByRole("region", { name: "Base", exact: true }).waitFor();
      const from = gateway.calls.length;
      await panel(page).getByRole("button", { name: "Save template" }).click();
      await row(list, `${template.title} copy`).waitFor();
      const saved = gateway.calls.slice(from).find((c) => c.method === "saveTemplate")?.input as
        | Template
        | undefined;
      assert.deepEqual(saved?.units[0]?.values, asked, `${template.title}: only what it asks`);
      await created(gateway, page, await use(gateway, page, `${template.title} copy`));
    }
    await page.close();
  }),
);

test(
  "where the Computer asks which computer, both templates create as before",
  withGateway(async (gateway) => {
    gateway.askComputer();
    gateway.addTemplate(MADE);
    gateway.addTemplate(WHOLE);
    const page = await open(gateway);
    for (const template of [MADE, WHOLE]) {
      const from = await use(gateway, page, template.title);
      await created(gateway, page, from);
      const stack = made(gateway, from)[0]?.input.stack as Template;
      assert.deepEqual(stack.units[0]?.values, template.units[0]?.values, template.title);
    }
    await page.close();
  }),
);

test(
  "another unit's template is refused the same way for an answer its form doesn't have, and for one it no longer offers",
  withGateway(async (gateway) => {
    gateway.addTemplate(kept("Kept region", "web", { service: "exa", region: "eu" }));
    gateway.addTemplate(kept("Kept search", "web", { service: "bing" }));
    const page = await open(gateway);

    let from = await use(gateway, page, "Kept region");
    const unasked = "This unit has no field region.";
    await panel(page).getByRole("alert").getByText(unasked, { exact: true }).waitFor();
    assert.deepEqual(await refusal(page), { words: unasked, above: true, bad: true });
    assert.equal(made(gateway, from).length, 0, "nothing made");
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

    from = await use(gateway, page, "Kept search");
    const offered = "Search service isn't one of its options.";
    await panel(page).getByRole("alert").getByText(offered, { exact: true }).waitFor();
    assert.deepEqual(await refusal(page), { words: offered, above: true, bad: true });
    assert.equal(made(gateway, from).length, 0, "nothing made");
    await page.close();
  }),
);
