// Change… checks the agent as it would be before it takes anything out: refused at the changed
// unit's place, by its connector or by management, nothing is taken out and the page says why.
// In a real browser over the stand-in gateway, whose check answers a stack as management does.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { heldComputer, openSetup, sampleAgents } from "./design/samples.ts";

withBrowser();

/** The connector's words, with nobody's name. */
const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";
const FILES_OFF =
  "Files are turned off in the AgentOrg app. Turn them on there to use this computer.";
const APP_CLOSED = "The AgentOrg app isn't open on this Mac. Open it to use this computer.";
const SCREEN_OFF = "Screen is turned off in the AgentOrg app. Turn it on there to choose it.";

async function at(gateway: Gateway, hash: string): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const settled = (window: Locator) =>
  window.evaluate((e) =>
    Promise.allSettled(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );

/** Triage, built from the Computer as its record holds it, then from the Web as this one holds it. */
function builtWith(gateway: Gateway, computer: Record<string, string>, web = { service: "exa" }) {
  const triage = gateway.agents.get("a-triage");
  assert.ok(triage);
  const unit = (instance: string, id: string, title: string, values: Record<string, string>) => ({
    provider: "units",
    needs: {},
    status: { state: "connected" as const },
    instance,
    unit: id,
    title,
    values,
  });
  triage.units = [
    unit("i-computer", "computer", "Computer", computer),
    unit("i-web", "web", "Web", web),
  ];
  return structuredClone(triage.units);
}
/** Change… on Triage's computer, its folder changed, and Save pressed: from which call on it was. */
async function save(gateway: Gateway, page: Page, folder?: string) {
  const sheet = await openSetup(page, "Triage");
  await sheet
    .getByRole("region", { name: /^Built from/ })
    .getByRole("button", { name: "Computer options" })
    .click();
  await page.getByRole("menuitem", { name: "Change…" }).click();
  const window = page.getByRole("dialog", { name: "Triage's computer" });
  await window.waitFor();
  await settled(window);
  if (folder) await window.getByLabel("Where its work happens", { exact: true }).fill(folder);
  const from = gateway.calls.length;
  await window.getByRole("button", { name: "Save" }).click();
  await window.waitFor({ state: "detached" });
  return { sheet, from };
}
/** What was taken out and put in, from the `from`th call on. */
const changes = (gateway: Gateway, from: number) =>
  gateway.calls
    .slice(from)
    .filter((c) => /^(add|remove)Unit$/.test(c.method))
    .map((c) => c.method);
/** Taken out and put back as answered: both calls made, as the page's frames go by. */
async function replaced(gateway: Gateway, page: Page, from: number) {
  for (let frame = 0; frame < 600 && changes(gateway, from).length < 2; frame++)
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  assert.deepEqual(changes(gateway, from), ["removeUnit", "addUnit"]);
}

for (const [state, why] of [
  ["its files switched off", FILES_OFF],
  ["the AgentOrg app closed", APP_CLOSED],
] as const)
  test(
    `this computer can't be had, ${state}: Save in Change… is refused with the connector's words, and nothing is taken out`,
    withGateway(async (gateway) => {
      // The line is the reason alone, and the connector refuses with it.
      gateway.stateComputer(why);
      gateway.computerRefuses(why);
      const was = builtWith(gateway, {
        workspace: "~/Agents/Triage",
        access: "terminal",
        screen: "off",
        ownBrowser: "none",
      });
      const page = await at(gateway, "#/a/a-triage");
      const { sheet, from } = await save(gateway, page, "/elsewhere");
      await sheet.getByRole("alert").getByText(why, { exact: true }).waitFor();
      assert.deepEqual(changes(gateway, from), [], "nothing taken out");
      assert.deepEqual(gateway.agents.get("a-triage")?.units, was, "as it was");
      await page.close();
    }),
  );

test(
  "where the Computer asks which computer, an agent whose screen is on while it is greyed: Save is refused before anything is taken out",
  withGateway(async (gateway) => {
    gateway.askComputer(SCREEN_OFF);
    const was = builtWith(gateway, {
      kind: "this",
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "on",
      ownBrowser: "yours",
    });
    const page = await at(gateway, "#/a/a-triage");
    const { sheet, from } = await save(gateway, page);
    await sheet.getByRole("alert").getByText(`Screen: ${SCREEN_OFF}`, { exact: true }).waitFor();
    assert.deepEqual(changes(gateway, from), [], "nothing taken out");
    assert.deepEqual(gateway.agents.get("a-triage")?.units, was, "as it was");
    await page.close();
  }),
);

test(
  "another unit's problem at its own place doesn't stop Save on the Computer",
  withGateway(async (gateway) => {
    gateway.stateComputer(READY);
    // Its Web's key, a secret, is never read back: checked as it stands, the Web has a problem.
    builtWith(
      gateway,
      { workspace: "~/Agents/Triage", access: "terminal", screen: "off", ownBrowser: "none" },
      { service: "tavily" },
    );
    const page = await at(gateway, "#/a/a-triage");
    const { sheet, from } = await save(gateway, page, "/elsewhere");
    await replaced(gateway, page, from);
    const [computer] = gateway.agents.get("a-triage")?.units ?? [];
    assert.equal(computer?.values.workspace, "/elsewhere");
    assert.equal(await sheet.getByRole("alert").count(), 0);
    await page.close();
  }),
);

test(
  "when management can't check, Save goes on as it did",
  withGateway(async (gateway) => {
    gateway.stateComputer(READY);
    builtWith(gateway, {
      workspace: "~/Agents/Triage",
      access: "terminal",
      screen: "off",
      ownBrowser: "none",
    });
    gateway.refuseNext("agents.check", "unavailable", "It can't check now.");
    const page = await at(gateway, "#/a/a-triage");
    const { sheet, from } = await save(gateway, page, "/elsewhere");
    await replaced(gateway, page, from);
    const [computer] = gateway.agents.get("a-triage")?.units ?? [];
    assert.equal(computer?.values.workspace, "/elsewhere");
    assert.equal(await sheet.getByRole("alert").count(), 0);
    await page.close();
  }),
);

test(
  "a way forward's window: the place the way would take is checked, and refused, nothing is taken out",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    gateway.stateComputer(APP_CLOSED);
    gateway.computerRefuses(APP_CLOSED);
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.held = [
      heldComputer({
        state: "down",
        detail: "A computer with no isolation is no longer made.",
        from: "i-computer",
        ways: [
          {
            title: "Attach this computer",
            description: "Its work happens in ~/Agents/Research, as before.",
            unit: "computer",
            values: { workspace: "~/Agents/Research", access: "terminal" },
          },
        ],
      }),
    ];
    const was = structuredClone(research.units);
    const page = await at(gateway, "#/a/a-research");
    await page
      .getByRole("main")
      .getByRole("region", { name: "Research's computer" })
      .getByRole("button", { name: "Attach this computer" })
      .click();
    const window = page.getByRole("dialog", { name: "Research's computer" });
    await window.waitFor();
    await settled(window);
    const from = gateway.calls.length;
    await window.getByRole("button", { name: "Save" }).click();
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText(APP_CLOSED, { exact: true })
      .waitFor();
    assert.deepEqual(changes(gateway, from), [], "nothing taken out");
    assert.deepEqual(gateway.agents.get("a-research")?.units, was, "as it was");
    await page.close();
  }),
);
