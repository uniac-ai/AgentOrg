// An agent's page for an agent that isn't here, in a real browser over the stand-in gateway: what it
// says, and when it doesn't say it.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import { inTeam, open, withGateway } from "./pages-kit.ts";

withBrowser();

test(
  "an agent that isn't here says so, with the way to Team",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-nobody");
    const main = page.getByRole("main");
    await main.getByText("This agent isn't here", { exact: true }).waitFor();
    assert.deepEqual(
      await main.getByRole("heading").allInnerTexts(),
      ["Agents"],
      "nothing of an agent is drawn: the team page's list's label alone",
    );
    await main.getByRole("button", { name: "Team", exact: true }).click();
    await page.waitForURL(/#\/team$/);
    // One deleted while its page is open says the same.
    await page.goto(`${gateway.url}/#/a/a-triage`);
    await main.getByRole("heading", { name: "Triage" }).waitFor();
    gateway.agents.delete("a-triage");
    await main.getByText("This agent isn't here", { exact: true }).waitFor({ timeout: 15_000 });
    await page.close();
  }),
);

test(
  "an agent's page doesn't say it isn't here when the list can't be read, nor before the list is read again after it is made",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer" }).waitFor();
    // The list can't be read for a while: the page stays as it was, and never says it isn't here.
    const before = gateway.calls.filter((c) => c.method === "list" && c.slot === "agents").length;
    gateway.refuseEvery("agents.list", "unavailable", "Not answering.");
    for (let end = Date.now() + 12_000; ; ) {
      const now = gateway.calls.filter((c) => c.method === "list" && c.slot === "agents").length;
      if (now > before) break;
      assert.ok(Date.now() < end, "the list is read again");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);
    assert.equal(await main.getByText("This agent isn't here").count(), 0);
    gateway.answerAgain("agents.list");
    await inTeam(page, "Reviewer").waitFor({ timeout: 15_000 });
    // Made, and gone to, before the list has been read again: its page waits for it.
    const holding = gateway.hold("agents.list");
    await page.evaluate(() => {
      location.hash = "#/a/a-new";
    });
    await page.waitForTimeout(600);
    const said = await main.getByText("This agent isn't here").count();
    holding();
    assert.equal(said, 0, "nothing said before the list is read since the page opened");
    await page.close();
  }),
);
