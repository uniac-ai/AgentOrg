// The agent's decision card of several questions, in a real browser over the stand-in gateway: a tab
// for each, named by its header; a pick of one moves on to the next not answered; one Confirm once
// all are answered sends a list of picks for each question; and once sent, or read later, each tab
// shows its own pick.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { ANSWERS, COUPONS, QUESTIONS, researchAsks } from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat with its card of three questions, opened then. */
async function open(gateway: Gateway): Promise<{ page: Page; thread: Locator }> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/chat/a-research`);
  const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  await thread.locator('[data-slot="card"]').waitFor();
  return { page, thread };
}
const card = (thread: Locator) => thread.getByRole("group", { name: "Research asks" });
const confirm = (thread: Locator) => card(thread).getByRole("button", { name: "Confirm" });
/** Each tab's name, whether it is shown, and whether its question is answered. */
const tabs = (thread: Locator) =>
  card(thread)
    .getByRole("tab")
    .evaluateAll((all) =>
      all.map(
        (tab) =>
          `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? " shown" : ""}${tab.querySelector('[aria-label="answered"]') ? " answered" : ""}`,
      ),
    );
/** The choices on the tab shown, each picked or not, and whether it can be pressed. */
const shown = (thread: Locator) =>
  card(thread)
    .getByRole("tabpanel")
    .locator('[role="radio"], [role="checkbox"]')
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          `${row.getAttribute("aria-checked")}${row.getAttribute("aria-disabled") === "true" || (row as HTMLButtonElement).disabled ? " unavailable" : ""}`,
      ),
    );
const sends = (gateway: Gateway) =>
  gateway.calls
    .filter((call) => call.slot === "chat_a_research" && call.method === "send")
    .map((call) => call.input);
const [fix, addTest, others] = ANSWERS as [string[], string[], string[]];

test(
  "a tab for each question, named by its header; a pick of one moves on to the next not answered, its tab checked",
  withGateway(async (gateway) => {
    researchAsks(gateway, "several");
    const { page, thread } = await open(gateway);
    assert.deepEqual(await tabs(thread), ["Fix shown", "Test", "Others"]);
    assert.equal(await confirm(thread).isDisabled(), true);
    await card(thread).getByRole("radio", { name: fix[0] }).click();
    await card(thread).getByRole("tab", { name: "Test", selected: true }).waitFor();
    assert.deepEqual(await tabs(thread), ["Fix answered", "Test shown", "Others"]);
    // Going back shows the pick held there, and a new one moves on again.
    await card(thread).getByRole("tab", { name: "Fix" }).click();
    assert.deepEqual(await shown(thread), ["true", "false"]);
    await card(thread).getByRole("radio", { name: "Remove it" }).click();
    await card(thread).getByRole("tab", { name: "Test", selected: true }).waitFor();
    assert.deepEqual(sends(gateway), [], "nothing sent while picks are held");
    await page.close();
  }),
);

test(
  "one Confirm, once every question is answered, sends a list of picks for each question in order, once",
  withGateway(async (gateway) => {
    researchAsks(gateway, "several");
    const { page, thread } = await open(gateway);
    await card(thread).getByRole("radio", { name: fix[0] }).click();
    await card(thread).getByRole("radio", { name: addTest[0] }).click();
    await card(thread).getByRole("tab", { name: "Others", selected: true }).waitFor();
    assert.equal(await confirm(thread).isDisabled(), true, "the last question isn't answered yet");
    for (const name of [...others].reverse())
      await card(thread).getByRole("checkbox", { name }).click();
    await confirm(thread).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(sends(gateway), [{ answer: { to: "v-a6", picks: [[0], [0], [0, 1]] } }]);
    // The provider writes a line for each question, named by its header.
    assert.equal(
      gateway.chatOf("a-research").messages.at(-1),
      "Fix: Refuse it after its date\nTest: Add a test\nOthers: WELCOME5, FREESHIP",
    );
    await page.close();
  }),
);

test(
  "once sent, or read later, each tab shows its own pick, and nothing can be pressed",
  withGateway(async (gateway) => {
    researchAsks(gateway, "several");
    gateway.addMessage("a-research", {
      id: "v-u9",
      role: "user",
      text: "Fix: Remove it\nTest: No test\nOthers: VIP20",
      at: new Date().toISOString(),
      answer: { to: "v-a6", picks: [[1], [1], [2]] },
    });
    const { page, thread } = await open(gateway);
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(await tabs(thread), [
      "Fix shown answered",
      "Test answered",
      "Others answered",
    ]);
    assert.deepEqual(await shown(thread), ["false unavailable", "true unavailable"]);
    await card(thread).getByRole("tab", { name: "Others" }).click();
    assert.deepEqual(await shown(thread), [
      "false unavailable",
      "false unavailable",
      "true unavailable",
    ]);
    assert.equal(await confirm(thread).count(), 0);
    await page.close();
  }),
);

test(
  "several questions of one pick each still wait for Confirm: a tap holds, and moves on",
  withGateway(async (gateway) => {
    researchAsks(gateway, "several");
    gateway.addMessage("a-research", {
      id: "v-a6",
      role: "assistant",
      text: COUPONS,
      at: new Date().toISOString(),
      ask: { questions: QUESTIONS.questions.slice(0, 2) },
    });
    const { page, thread } = await open(gateway);
    await card(thread).getByRole("radio", { name: fix[0] }).click();
    await card(thread).getByRole("tab", { name: "Test", selected: true }).waitFor();
    await card(thread).getByRole("radio", { name: addTest[0] }).click();
    assert.deepEqual(sends(gateway), [], "held, not sent");
    await confirm(thread).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(sends(gateway), [{ answer: { to: "v-a6", picks: [[0], [0]] } }]);
    await page.close();
  }),
);
