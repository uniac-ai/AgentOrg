// An agent's Overview past its Activity, and its line when something it holds is down, in a real
// browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { sampleAgents } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function open(gateway: Gateway, hash: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const section = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name, exact: true });
const lines = (page: Page, name: string) =>
  section(page, name)
    .locator(":scope > div:last-child > div")
    .evaluateAll((all) =>
      all.map((one) => (one as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    );
const state = (page: Page) => page.getByRole("main").getByRole("status", { name: "State" });

test(
  "Overview says in one line what it was built from: its template and units, or none",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research/overview");
    await section(page, "Built from").getByText("Assistant", { exact: true }).waitFor();
    assert.deepEqual(await lines(page, "Built from"), ["Assistant Computer, Web"]);
    await page.goto(`${gateway.url}/#/a/a-reviewer/overview`);
    await section(page, "Built from").getByText("Empty", { exact: true }).waitFor();
    assert.deepEqual(await lines(page, "Built from"), ["Empty Just the base"]);
    await page.close();
  }),
);

test(
  "Changed through control: who made, started or stopped it, newest first, a refusal in red, and nothing else",
  withGateway(async (gateway) => {
    for (const change of [
      {
        at: ago(4000),
        caller: "person",
        tool: "create_assistant",
        target: "a-research",
        outcome: "done",
      },
      {
        at: ago(3000),
        caller: "person",
        tool: "skill_expose",
        target: "a-research",
        outcome: "done",
      },
      {
        at: ago(2000),
        caller: "a-reviewer",
        tool: "agent_stop",
        target: "a-research",
        outcome: "refused",
        reason: "Reviewer didn't create Research",
      },
      { at: ago(60), caller: "person", tool: "agent_stop", target: "a-triage", outcome: "done" },
      { at: ago(30), caller: "person", tool: "agent_start", target: "a-research", outcome: "done" },
    ] as const)
      gateway.logChange(change);
    const page = await open(gateway, "#/a/a-research/overview");
    await section(page, "Changed through control").getByText("started it").waitFor();
    assert.deepEqual(await lines(page, "Changed through control"), [
      "You started it 30 min",
      "Reviewer tried to stop it: Reviewer didn't create Research Yesterday",
      "You created it from Assistant 2 d",
    ]);
    const refused = section(page, "Changed through control").getByText(/^tried to stop it/);
    const bad = await refused.evaluate((e) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--bad)";
      e.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.equal(await refused.evaluate((e) => getComputedStyle(e).color), bad);
    // What it does itself is in the same log: many calls of its own leave the changes to it shown.
    for (let n = 0; n < 260; n++)
      gateway.logChange({
        at: ago(5),
        caller: "a-research",
        tool: "agent_send",
        target: "a-reviewer",
        outcome: "done",
      });
    await page.reload();
    await section(page, "Changed through control").getByText("created it from Assistant").waitFor();
    assert.equal(
      await section(page, "Changed through control")
        .locator(":scope > div:last-child > div")
        .count(),
      3,
    );
    // One with no change through control says so.
    await page.goto(`${gateway.url}/#/a/a-weekly/overview`);
    await section(page, "Changed through control").getByText("No changes").waitFor();
    await page.close();
  }),
);

test(
  "the agent's line says what is down, what that leaves out, and why, in one sentence",
  withGateway(async (gateway) => {
    // A connection, with why its connection says, set inside the sentence.
    const page = await open(gateway, "#/a/a-triage");
    await state(page)
      .getByText("linear is down, so its tools are left out: the server didn't answer", {
        exact: true,
      })
      .waitFor();
    // Something it holds, as that says it stands, and back again.
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await state(page).getByText("Idle", { exact: true }).waitFor();
    gateway.setHeld("a-reviewer", [
      {
        title: "Computer",
        state: "down",
        detail: "no AgentComputer is running on this machine",
        surfaces: 2,
        slots: ["computer"],
      },
    ]);
    await state(page)
      .getByText(
        "Its computer is down, so its windows and tools are left out: no AgentComputer is running on this machine",
        { exact: true },
      )
      .waitFor();
    // Its dot and its words in the trouble colour.
    for (const n of [0, 1])
      assert.equal(
        await state(page)
          .locator("span")
          .nth(n)
          .evaluate((e) => e.className.includes("bad")),
        true,
        "in the trouble colour",
      );
    // It comes before the agent working.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await page.waitForTimeout(300);
    await state(page)
      .getByText(/^Its computer is down/)
      .waitFor();
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    // With nothing it gives to leave out, and nothing to say why.
    gateway.setHeld("a-reviewer", [{ title: "Computer", state: "down", surfaces: 0, slots: [] }]);
    await state(page).getByText("Its computer is down", { exact: true }).waitFor();
    // Still connecting is not down.
    gateway.setHeld("a-reviewer", [
      { title: "Computer", state: "connecting", surfaces: 2, slots: ["computer"] },
    ]);
    await state(page).getByText("Idle", { exact: true }).waitFor();
    gateway.setHeld("a-reviewer", [
      { title: "Computer", state: "down", surfaces: 2, slots: ["computer"] },
    ]);
    await state(page)
      .getByText("Its computer is down, so its windows and tools are left out", { exact: true })
      .waitFor();
    gateway.setHeld("a-reviewer", [
      { title: "Computer", state: "connected", surfaces: 2, slots: ["computer"] },
    ]);
    await state(page).getByText("Idle", { exact: true }).waitFor();
    await page.close();
  }),
);
