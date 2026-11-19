// The unit window says the unit's own line in its card, under its title and before its questions,
// as Create's section does: in Setup's Add and Change…, and in a way forward's window, where the
// way's note stays below the card. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  agentsRead,
  browser,
  card,
  type Gateway,
  panel,
  plus,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { heldComputer, openSetup, sampleAgents } from "./design/samples.ts";

withBrowser();

/** What the Computer unit says where its connector states this computer, with nobody's name. */
const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";
const SCREEN_OFF =
  "Sam's Mac mini, whole: your files and apps and your signed-in browser. It acts as you, with everything you can reach. Screen is turned off in the AgentOrg app. Turn it on there to choose it.";
const INSTALL =
  "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.";

async function at(gateway: Gateway, hash: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** Once what opened has stopped moving. */
const settled = (window: Locator) =>
  window.evaluate((e) =>
    Promise.allSettled(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );

/** Triage is built from the Computer, as its record holds it. */
function builtWith(gateway: Gateway, values: Record<string, string>) {
  const triage = gateway.agents.get("a-triage");
  assert.ok(triage);
  triage.units = [
    {
      provider: "units",
      needs: {},
      status: { state: "connected" },
      instance: "i-computer",
      unit: "computer",
      title: "Computer",
      values,
    },
  ];
}
/** Change… on Triage's computer, from its setup, once the window has opened. */
async function change(page: Page) {
  const sheet = await openSetup(page, "Triage");
  await sheet
    .getByRole("region", { name: /^Built from/ })
    .getByRole("button", { name: "Computer options" })
    .click();
  await page.getByRole("menuitem", { name: "Change…" }).click();
  const window = page.getByRole("dialog", { name: "Triage's computer" });
  await window.waitFor();
  await settled(window);
  return window;
}
/** What `addUnit` was sent from the `from`th call on, as the page's frames go by. */
async function added(gateway: Gateway, page: Page, from: number) {
  for (let frame = 0; frame < 600; frame++) {
    const call = gateway.calls.slice(from).find((c) => c.method === "addUnit");
    if (call) return call.input as { unit: { values: Record<string, unknown> }; at?: number };
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
  return undefined;
}

/**
 * The window read at one moment: its card's line, its look, where it is against the card's title and
 * the questions, the questions it asks, whether the note is below the card, and whether it all fits.
 */
const read = (window: Locator) =>
  window.evaluate((d) => {
    const card = d.querySelector(".no-bar") as HTMLElement;
    const title = card.firstElementChild as Element;
    const body = title.nextElementSibling as Element;
    const first = body.firstElementChild as HTMLElement | null;
    const line = first?.tagName === "P" ? first : null;
    const box = (e: Element) => e.getBoundingClientRect();
    const s = line ? getComputedStyle(line) : null;
    const label = body.querySelector("label");
    const note = [...d.children].find((e) => e.tagName === "P");
    const r = box(d);
    return {
      line: line?.textContent ?? null,
      look: s ? [s.fontSize, s.lineHeight, s.fontWeight, s.color].join(" ") : null,
      lines: line && s ? Math.round(box(line).height / Number.parseFloat(s.lineHeight)) : 0,
      whole: !!line && line.scrollWidth <= line.clientWidth && s?.textOverflow !== "ellipsis",
      under: !!line && box(line).top >= box(title).bottom,
      before:
        !!line && !!line.nextElementSibling && box(line).bottom <= box(line.nextElementSibling).top,
      lined: !!line && !!label && Math.abs(box(line).left - box(label).left) < 0.5,
      asked: [...body.querySelectorAll("label")].map((l) => l.textContent),
      noteBelow: note ? box(note).top >= box(card).bottom : null,
      fits: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });

/** The look of the Computer's line in Create's section, which the window's line is drawn in. */
async function createLook(gateway: Gateway) {
  const page = await at(gateway, "#/team");
  await agentsRead(page);
  await plus(page).click();
  await panel(page)
    .getByRole("button", { name: /^Assistant/ })
    .click();
  await card(page, "Computer").waitFor();
  const look = await card(page, "Computer").evaluate((section) => {
    const line = section.querySelector(":scope > div:nth-child(2) > div > p:first-child");
    const s = getComputedStyle(line as Element);
    return [s.fontSize, s.lineHeight, s.fontWeight, s.color].join(" ");
  });
  await page.close();
  return look;
}

test(
  "Change… and Add in Setup, and a way forward's window, say the unit's line in its card under its title, before its questions, as Create's section does",
  withGateway(async (gateway) => {
    const look = await createLook(gateway);
    sampleAgents(gateway);
    builtWith(gateway, { where: "local", workspace: "/work/triage", access: "terminal" });
    const page = await at(gateway, "#/a/a-triage");

    const changing = await change(page);
    const changed = await read(changing);
    assert.equal(changed.line, "Terminal, files and a browser");
    assert.ok(
      changed.under && changed.before && changed.lined,
      "under its title, before, lined up",
    );
    assert.equal(changed.look, look, "as Create's line");
    assert.equal(changed.noteBelow, null, "no note");
    await changing.getByRole("button", { name: "Cancel" }).click();
    await changing.waitFor({ state: "detached" });

    const sheet = page.getByRole("dialog", { name: "Triage's setup" });
    await sheet.getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: "Web" }).click();
    const adding = page.getByRole("dialog", { name: "Triage's web" });
    await adding.waitFor();
    await settled(adding);
    const add = await read(adding);
    assert.equal(add.line, "Search and fetch");
    assert.ok(add.under && add.before && add.lined, "under its title, before, lined up");
    assert.equal(add.look, look, "as Create's line");
    await page.close();

    // A way forward: the unit's line in the card, and what taking the way does below it.
    gateway.setHeld("a-research", [
      heldComputer({
        state: "down",
        detail: "A computer with no isolation is no longer made.",
        from: "i-computer",
        ways: [
          {
            title: "Attach this computer",
            description: "Its work happens in /work/research, as before.",
            unit: "computer",
            values: { where: "local", workspace: "/work/research", access: "terminal" },
          },
        ],
      }),
    ]);
    const research = await at(gateway, "#/a/a-research");
    await research
      .getByRole("main")
      .getByRole("region", { name: "Research's computer" })
      .getByRole("button", { name: "Attach this computer" })
      .click();
    const taking = research.getByRole("dialog", { name: "Research's computer" });
    await taking.waitFor();
    await settled(taking);
    const way = await read(taking);
    assert.equal(way.line, "Terminal, files and a browser");
    assert.ok(way.under && way.before && way.lined, "under its title, before, lined up");
    assert.equal(way.noteBelow, true, "the way's note below the card");
    await taking.getByText("Its work happens in /work/research, as before.").waitFor();
    await research.close();
  }),
);

test(
  "with the screen off, Change… on the Computer says the line with the screen's reason and doesn't ask for it, and Save sends no screen",
  withGateway(async (gateway) => {
    gateway.stateComputer(SCREEN_OFF, "screen");
    // Made before the screen was turned off, and before the computer was stated: it held both.
    builtWith(gateway, {
      kind: "this",
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "on",
      ownBrowser: "yours",
    });
    const page = await at(gateway, "#/a/a-triage");
    const window = await change(page);
    const seen = await read(window);
    assert.equal(seen.line, SCREEN_OFF);
    assert.ok(seen.whole && seen.under && seen.before, "whole, under its title, before");
    assert.deepEqual(seen.asked, ["Where its work happens", "What it reaches", "Browser"]);
    const from = gateway.calls.length;
    await window.getByRole("button", { name: "Save" }).click();
    await window.waitFor({ state: "detached" });
    const sent = await added(gateway, page, from);
    assert.deepEqual(sent?.unit.values, {
      workspace: "~/Agents/Triage",
      access: "terminal",
      ownBrowser: "yours",
    });
    assert.equal(sent?.at, 0, "in its place");
    await page.close();
  }),
);

test(
  "the install steps as the line: whole and wrapped, nothing sideways, and the window fits, wide and on a phone",
  withGateway(async (gateway) => {
    gateway.stateComputer(INSTALL);
    builtWith(gateway, {
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "off",
      ownBrowser: "none",
    });
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      const page = await at(gateway, "#/a/a-triage", width, height);
      const seen = await read(await change(page));
      assert.equal(seen.line, INSTALL, `${width}`);
      assert.ok(seen.whole && seen.under && seen.before, `${width}: whole, in place`);
      assert.ok(seen.lines > 1, `${width}: wrapped (${seen.lines})`);
      assert.ok(seen.fits && !seen.sideways, `${width}: fits, nothing sideways`);
      await page.close();
    }
  }),
);

test(
  "a change that is refused puts the Computer back as today's form takes it: an agent made before the computer was stated keeps it, in its place, and the page says why",
  withGateway(async (gateway) => {
    gateway.stateComputer(READY);
    // Made before the computer was stated: its record holds which computer, a field the form no
    // longer has, which is refused if it is sent.
    builtWith(gateway, {
      kind: "this",
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "on",
      ownBrowser: "yours",
    });
    const triage = gateway.agents.get("a-triage");
    triage?.units?.push({
      provider: "units",
      needs: {},
      status: { state: "connected" },
      instance: "i-web",
      unit: "web",
      title: "Web",
      values: { service: "exa" },
    });
    const page = await at(gateway, "#/a/a-triage");
    const window = await change(page);
    await window.getByLabel("Where its work happens", { exact: true }).fill("/nowhere");
    gateway.refuseNext("agents.addUnit", "invalid", "That folder can't be used.");
    await window.getByRole("button", { name: "Save" }).click();
    const sheet = page.getByRole("dialog", { name: "Triage's setup" });
    await sheet.getByRole("alert").getByText("That folder can't be used.").waitFor();
    // Back first, as it was answered, with only what its form has.
    const units = gateway.agents.get("a-triage")?.units ?? [];
    assert.deepEqual(
      units.map((u) => u.unit),
      ["computer", "web"],
    );
    assert.deepEqual(units[0]?.values, {
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "on",
      ownBrowser: "yours",
    });
    await sheet
      .getByRole("region", { name: /^Built from/ })
      .getByRole("listitem")
      .first()
      .getByText("~/Agents/Triage")
      .waitFor();
    await page.close();
  }),
);
