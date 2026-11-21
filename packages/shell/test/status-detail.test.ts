// What an agent's status says is wrong while it runs, such as a plugin it runs without: the line
// that says why, on its page and its Team row, in a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { type Gateway, withBrowser } from "./build-kit.ts";
import { inTeam, open, state, withGateway } from "./pages-kit.ts";
import type { Agent } from "./stand-in.ts";

withBrowser();

/** What a status says of each plugin an agent runs without, one sentence a line, in order. */
const MEMORY = "It runs without memory: its lines couldn't be read.";
const SEARCH = "It runs without search: this provider doesn't carry it.";
const NOTES = "It runs without notes: it needs a service none of its plugins provides.";
const ALL = [MEMORY, SEARCH, NOTES].join("\n");

/**
 * How an agent stands, as what runs it says it. Nothing tells of the change: the page has it at
 * its next read of the agents, every few seconds.
 */
const says = (gateway: Gateway, agent: string, status: Agent["status"]) => {
  (gateway.agents.get(agent) as Agent).status = status;
};
const NEXT_READ = { timeout: 10_000 };

/** The words of an agent's line on its page, after its dot. */
const pageLine = (page: Page) => state(page).locator(":scope > span:nth-of-type(2)");
/** The words of an agent's line in Team's list, after its face and its name. */
const rowLine = (page: Page, name: string) =>
  inTeam(page, name)
    .getByRole("button")
    .locator(":scope > span:nth-of-type(2) > span:nth-of-type(2)");
const colour = (line: Locator) => line.evaluate((e) => getComputedStyle(e).color);
const bad = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--bad)";
    document.body.append(probe);
    const said = getComputedStyle(probe).color;
    probe.remove();
    return said;
  });
const marked = (page: Page, name: string) =>
  inTeam(page, name).getByRole("img", { name: "Has a problem" });

test(
  "a running agent whose status says something is wrong says it in red, ahead of working and of what it holds that is down",
  withGateway(async (gateway) => {
    says(gateway, "a-research", { state: "running", detail: MEMORY });
    const page = await open(gateway, "#/a/a-reviewer");
    await state(page).getByText("Idle", { exact: true }).waitFor();
    // At work, it says so in Working's place.
    await inTeam(page, "Research", MEMORY).waitFor();
    await marked(page, "Research").waitFor();
    says(gateway, "a-reviewer", { state: "running", detail: MEMORY });
    await state(page).getByText(MEMORY, { exact: true }).waitFor(NEXT_READ);
    await inTeam(page, "Reviewer", MEMORY).waitFor();
    // Where and how a down agent says why: red, and its face marked.
    const red = await bad(page);
    assert.equal(await colour(pageLine(page)), red);
    assert.equal(await colour(rowLine(page, "Reviewer")), red);
    await marked(page, "Reviewer").waitFor();
    // What it holds that is down comes after: its computer keeps its place, and the line stays.
    gateway.setHeld("a-reviewer", [
      { title: "Computer", state: "down", detail: "its machine is off", surfaces: 2, slots: [] },
    ]);
    await page.getByRole("main").getByRole("tab", { name: "Computer" }).waitFor();
    assert.equal((await pageLine(page).innerText()).trim(), MEMORY);
    await page.close();
  }),
);

test(
  "several sentences show one a line on the agent's page, and the first in Team's list",
  withGateway(async (gateway) => {
    says(gateway, "a-reviewer", { state: "running", detail: ALL });
    for (const width of [1440, 390]) {
      const page = await open(gateway, "#/a/a-reviewer", { width, height: 844 });
      await state(page).getByText(NOTES, { exact: false }).waitFor();
      assert.equal((await pageLine(page).innerText()).trim(), ALL);
      // Each sentence begins a line of its own, at the line's start, wide as well.
      const starts = await pageLine(page).evaluate((line, sentences) => {
        const text = line.firstChild as Text;
        const at = (sentence: string) => {
          const range = document.createRange();
          const n = text.data.indexOf(sentence);
          range.setStart(text, n);
          range.setEnd(text, n + 1);
          return range.getBoundingClientRect();
        };
        const boxes = sentences.map(at);
        return boxes.slice(1).map((box, n) => {
          const before = boxes[n] as DOMRect;
          return box.top >= before.bottom - 1 && Math.abs(box.left - before.left) < 1;
        });
      }, ALL.split("\n"));
      assert.deepEqual(starts, [true, true], `at ${width}`);
      // The line grows to hold them: nothing of it runs over what is above or below.
      const [held, words] = await Promise.all([
        state(page).boundingBox(),
        pageLine(page).boundingBox(),
      ]);
      assert.ok(held && words, "the line is drawn");
      assert.ok(
        held.y <= words.y && held.y + held.height >= words.y + words.height,
        `at ${width}, the line holds its words`,
      );
      await page.close();
    }
    const page = await open(gateway, "#/team");
    await inTeam(page, "Reviewer", MEMORY).waitFor();
    assert.equal((await rowLine(page, "Reviewer").innerText()).trim(), MEMORY);
    await page.close();
  }),
);

test(
  "stopped or starting, an agent keeps its own word, whatever its status says",
  withGateway(async (gateway) => {
    says(gateway, "a-reviewer", { state: "stopped", detail: ALL });
    const page = await open(gateway, "#/a/a-reviewer");
    await state(page).getByText("Stopped", { exact: true }).waitFor();
    await state(page).getByRole("button", { name: "Start" }).waitFor();
    await inTeam(page, "Reviewer", "Stopped").waitFor();
    const red = await bad(page);
    assert.notEqual(await colour(pageLine(page)), red);
    assert.notEqual(await colour(rowLine(page, "Reviewer")), red);
    assert.equal(await marked(page, "Reviewer").count(), 0);
    says(gateway, "a-reviewer", { state: "starting", detail: ALL });
    await state(page).getByText("Starting", { exact: true }).waitFor(NEXT_READ);
    await inTeam(page, "Reviewer", "Starting").waitFor();
    assert.notEqual(await colour(pageLine(page)), red);
    await page.close();
  }),
);

test(
  "once its status says nothing is wrong, the line is Idle or Working again",
  withGateway(async (gateway) => {
    says(gateway, "a-reviewer", { state: "running", detail: MEMORY });
    says(gateway, "a-research", { state: "running", detail: ALL });
    const page = await open(gateway, "#/a/a-reviewer");
    await state(page).getByText(MEMORY, { exact: true }).waitFor();
    await inTeam(page, "Research", MEMORY).waitFor();
    says(gateway, "a-reviewer", { state: "running" });
    says(gateway, "a-research", { state: "running" });
    await state(page).getByText("Idle", { exact: true }).waitFor(NEXT_READ);
    await inTeam(page, "Reviewer", "Idle").waitFor();
    await inTeam(page, "Research", "Working").waitFor();
    assert.equal(await marked(page, "Reviewer").count(), 0);
    assert.notEqual(await colour(pageLine(page)), await bad(page));
    await page.close();
  }),
);
