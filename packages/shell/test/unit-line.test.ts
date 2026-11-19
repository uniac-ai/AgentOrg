// A unit's own line under its heading in New template's window, in a real browser over the stand-in
// gateway: what the unit says it is, as the base's line is drawn, before what it asks. Create for an
// agent shows each unit by its logo and name alone.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import {
  browser,
  card,
  type Gateway,
  newTemplate,
  panel,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

/** What a computer already there will say of itself, ready, with a part not ready, and not to be had. */
const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";
const PART = `${READY} Screen is turned off in the AgentOrg app.`;
const NONE = "The AgentOrg app isn't open on this Mac. Open it to use this computer.";

/** New template from Assistant, at this width, once the window has opened. */
async function create(gateway: Gateway, width = 1440): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/team`);
  await newTemplate(page, "Assistant");
  await card(page, "Computer").waitFor();
  await panel(page).evaluate((e) =>
    Promise.all(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );
  return page;
}
/**
 * Each section's own line, read at one moment: its words; its type and colour; whether it is whole;
 * where it is against its heading and its first question; and the base's line, and the page's width.
 */
const lines = (page: Page) =>
  panel(page).evaluate((window) => {
    const look = (e: Element) => {
      const s = getComputedStyle(e);
      return [s.fontSize, s.lineHeight, s.fontWeight, s.color].join(" ");
    };
    const sections = [...window.querySelectorAll('form[aria-label="Build"] section')];
    const base = sections[0]?.querySelector(":scope > div:nth-child(2) > div > div:nth-child(2)");
    return {
      base: base ? look(base) : null,
      page: [innerWidth, document.documentElement.scrollWidth],
      units: sections.slice(1, -1).map((section) => {
        const heading = section.querySelector("[data-heading]") as Element;
        const line = section.querySelector(":scope > div:nth-child(2) > div > p:first-child");
        const asked = line?.nextElementSibling;
        const box = (e: Element | null | undefined) => e?.getBoundingClientRect();
        return {
          title: section.querySelector("h3")?.textContent,
          line: line?.textContent ?? null,
          look: line ? look(line) : null,
          whole:
            !!line &&
            line.scrollWidth <= line.clientWidth &&
            getComputedStyle(line).textOverflow !== "ellipsis",
          lines: line
            ? Math.round(
                (box(line)?.height ?? 0) / Number.parseFloat(getComputedStyle(line).lineHeight),
              )
            : 0,
          under: !!line && (box(line)?.top ?? 0) >= (box(heading)?.bottom ?? 0),
          before: !asked || (box(line)?.bottom ?? 0) <= (box(asked)?.top ?? 0),
        };
      }),
    };
  });

test(
  "each unit's section says the unit's own line under its heading, before what it asks, in the base's line's type and colour",
  withGateway(async (gateway) => {
    const page = await create(gateway);
    const now = await lines(page);
    assert.deepEqual(
      now.units.map((u) => [u.title, u.line, u.under, u.before]),
      [
        ["Computer", "Terminal, files and a browser", true, true],
        ["Web", "Search and fetch", true, true],
      ],
    );
    for (const unit of now.units)
      assert.equal(unit.look, now.base, `${unit.title}: as the base's line`);
    await page.close();
  }),
);

for (const [state, said] of [
  ["ready", READY],
  ["a part not ready", PART],
  ["not to be had", NONE],
] as const)
  test(
    `the Computer's line ${state}, as its unit says it, wide, narrower and on a phone: whole, wrapped, and nothing goes sideways`,
    withGateway(async (gateway) => {
      gateway.describeUnit("computer", said);
      for (const width of [1440, 800, 390]) {
        const page = await create(gateway, width);
        const now = await lines(page);
        const computer = now.units[0];
        assert.ok(computer);
        assert.equal(computer.line, said, `${width}: its words`);
        assert.ok(computer.whole && computer.under && computer.before, `${width}: whole, in place`);
        assert.equal(computer.look, now.base, `${width}: as the base's line`);
        const [has, needs] = now.page;
        assert.ok(
          needs !== undefined && has !== undefined && needs <= has,
          `${width}: nothing sideways`,
        );
        if (said !== NONE && width < 1440)
          assert.ok(computer.lines > 1, `${width}: a long line wraps (${computer.lines})`);
        await page.close();
      }
    }),
  );

test(
  "folded, a section is its heading alone; opened again, its line is back",
  withGateway(async (gateway) => {
    const page = await create(gateway);
    const computer = card(page, "Computer");
    const line = computer.getByText("Terminal, files and a browser", { exact: true });
    await line.waitFor();
    await computer.getByRole("button", { name: "Fold Computer" }).click();
    assert.equal(await line.count(), 0);
    await computer.getByRole("button", { name: "Open Computer" }).click();
    await line.waitFor();
    await page.close();
  }),
);

test(
  "the rail still has one logo for each section, and a logo still brings its heading to the top",
  withGateway(async (gateway) => {
    gateway.describeUnit("computer", PART);
    const page = await create(gateway);
    const rail = panel(page).getByRole("navigation", { name: "Sections" });
    assert.deepEqual(
      await rail
        .getByRole("button")
        .evaluateAll((all) => all.map((b) => b.getAttribute("aria-label"))),
      ["Base", "Computer", "Web", "Add"],
    );
    await panel(page).evaluate((window) => {
      const box = window.querySelector('nav[aria-label="Sections"]')?.previousElementSibling;
      (globalThis as { ended?: Promise<unknown> }).ended = new Promise((done) =>
        box?.addEventListener("scrollend", done, { once: true }),
      );
    });
    await rail.getByRole("button", { name: "Web", exact: true }).click();
    await page.evaluate(() => (globalThis as { ended?: Promise<unknown> }).ended);
    const top = await panel(page).evaluate((window) => {
      const box = window.querySelector('nav[aria-label="Sections"]')
        ?.previousElementSibling as Element;
      const heading = [...box.querySelectorAll("[data-heading]")].find(
        (one) => one.querySelector("h3")?.textContent === "Web",
      );
      const room =
        box.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(box).paddingTop);
      return Math.abs((heading?.getBoundingClientRect().top ?? 999) - room);
    });
    assert.ok(top <= 2, `Web's heading at the top: ${top}`);
    await page.close();
  }),
);
