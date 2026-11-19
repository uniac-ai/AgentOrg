// A template whose answers its unit no longer asks is refused in Create, as management refuses
// them when it is called directly, and the refusal is said on that unit's section; saved again
// from Settings, it keeps only what its units ask, and creates. In a real browser over the
// stand-in gateway, which refuses what management refuses.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { card, type Gateway, open, panel, withBrowser, withGateway } from "./build-kit.ts";
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
  await panel(page).getByRole("region", { name: "Base", exact: true }).waitFor();
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
 * Where a section's refusal is, read at one moment: whether it is under every question the section
 * asks, and in the problem colour.
 */
const placed = (section: Locator, words: string) =>
  section.evaluate((e, said) => {
    const problem = [...e.querySelectorAll("p")].find((p) => p.textContent === said);
    if (!problem) return null;
    const probe = document.createElement("i");
    probe.style.color = "var(--bad)";
    e.append(probe);
    const bad = getComputedStyle(probe).color;
    probe.remove();
    const top = problem.getBoundingClientRect().top;
    return {
      under: [...e.querySelectorAll("label")].every((l) => l.getBoundingClientRect().bottom <= top),
      bad: getComputedStyle(problem).color === bad,
    };
  }, words);

test(
  "where the Computer states this computer, a template that answered which computer is refused on its section in management's words, and nothing is made",
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
      const computer = card(page, "Computer");
      for (const words of said) {
        await computer.getByText(words, { exact: true }).waitFor();
        assert.deepEqual(await placed(computer, words), { under: true, bad: true }, words);
      }
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
  "another unit's template is refused the same way for an answer its form doesn't have, and under the question for one it no longer offers",
  withGateway(async (gateway) => {
    gateway.addTemplate(kept("Kept region", "web", { service: "exa", region: "eu" }));
    gateway.addTemplate(kept("Kept search", "web", { service: "bing" }));
    const page = await open(gateway);
    const web = card(page, "Web");

    let from = await use(gateway, page, "Kept region");
    const unasked = "This unit has no field region.";
    await web.getByText(unasked, { exact: true }).waitFor();
    assert.deepEqual(await placed(web, unasked), { under: true, bad: true });
    assert.equal(made(gateway, from).length, 0, "nothing made");
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

    from = await use(gateway, page, "Kept search");
    const offered = "Search service isn't one of its options.";
    await web.getByText(offered, { exact: true }).waitFor();
    // Under the question it answers, as any answer the service refuses.
    const at = await web.evaluate((e, said) => {
      const problem = [...e.querySelectorAll("*")].find(
        (one) => one.childElementCount === 0 && one.textContent === said,
      );
      return problem?.closest('[data-slot="field"]')?.querySelector("label")?.textContent ?? null;
    }, offered);
    assert.equal(at, "Search service");
    assert.equal(made(gateway, from).length, 0, "nothing made");
    await page.close();
  }),
);
