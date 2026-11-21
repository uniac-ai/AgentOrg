// The agent's decision card where picks are held until Confirm, in a real browser over the stand-in
// gateway: a card asking for a confirm holds one pick, changeable; a question of several picks holds
// checkboxes; Confirm sends them once, alone, and the card is final in the plain card's look; writing
// instead passes it over; and where the person only reads, nothing can be held.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { CARDS, type CardCase, PICK, PICKED, researchAsks, TYPED } from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat at one of the design's states for the card, opened then. */
async function at(gateway: Gateway, state: CardCase): Promise<{ page: Page; thread: Locator }> {
  researchAsks(gateway, state);
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
const sign = (thread: Locator) => thread.getByRole("status", { name: "Research is typing" });
/** What the person sent to the conversation, as the stand-in was given it. */
const sends = (gateway: Gateway) =>
  gateway.calls
    .filter((call) => call.slot === "chat_a_research" && call.method === "send")
    .map((call) => call.input);
/** Each choice of a kind, as a screen reader meets it: picked, and whether it can be pressed. */
const choices = (thread: Locator, role: "radio" | "checkbox") =>
  card(thread)
    .getByRole(role)
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          `${row.getAttribute("aria-checked")}${row.getAttribute("aria-disabled") === "true" || (row as HTMLButtonElement).disabled ? " unavailable" : ""}`,
      ),
    );
/** Each settled row's outline and how bright it is, and whether it has the filled check. */
const settled = (thread: Locator, role: "radio" | "checkbox") =>
  card(thread)
    .getByRole(role)
    .evaluateAll((rows) =>
      rows.map((row) => {
        const style = getComputedStyle(row);
        return `${style.borderTopStyle} ${style.opacity}${row.querySelector("svg") ? " checked" : ""}`;
      }),
    );
/** Each row's look where picks are held: whether its outline is as bright as its words, and its fill. */
const outlines = (thread: Locator) =>
  card(thread)
    .locator('label[data-slot="field-label"]')
    .evaluateAll((rows) =>
      rows.map((row) => {
        const style = getComputedStyle(row);
        return `${style.borderTopColor === style.color ? "bright" : "dim"} ${style.backgroundColor}`;
      }),
    );

test(
  "with a confirm, a tap holds a pick, changeable, and nothing goes until Confirm sends it once",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "confirm");
    assert.equal(await confirm(thread).isDisabled(), true, "Confirm waits for a pick");
    assert.deepEqual(await choices(thread, "radio"), ["false", "false", "false"]);
    await card(thread).getByRole("radio", { name: "Fix it now" }).click();
    await card(thread).getByRole("radio", { name: PICKED }).click();
    assert.deepEqual(await choices(thread, "radio"), ["false", "true", "false"]);
    // The pick held has the bright outline and no fill; the others don't.
    await page.mouse.move(1437, 450);
    assert.deepEqual(await outlines(thread), [
      "dim rgba(0, 0, 0, 0)",
      "bright rgba(0, 0, 0, 0)",
      "dim rgba(0, 0, 0, 0)",
    ]);
    assert.deepEqual(sends(gateway), [], "nothing sent while it is held");
    await confirm(thread).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(sends(gateway), [{ answer: { to: "v-a6", picks: [[PICK]] } }]);
    // Final, in the plain card's look, with nothing to press.
    assert.deepEqual(await choices(thread, "radio"), [
      "false unavailable",
      "true unavailable",
      "false unavailable",
    ]);
    assert.deepEqual(await settled(thread, "radio"), [
      "dashed 0.5",
      "solid 1 checked",
      "dashed 0.5",
    ]);
    assert.equal(await confirm(thread).count(), 0);
    await sign(thread).waitFor();
    await page.close();
  }),
);

test(
  "several picks: checkboxes, held and changeable, sent once on Confirm in the choices' order",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "many");
    assert.equal(await confirm(thread).isDisabled(), true);
    const box = (name: string) => card(thread).getByRole("checkbox", { name });
    await box("VIP20").click();
    await box("FREESHIP").click();
    await box("WELCOME5").click();
    await box("FREESHIP").click();
    assert.deepEqual(await choices(thread, "checkbox"), ["true", "false", "true", "false"]);
    assert.deepEqual(sends(gateway), []);
    await confirm(thread).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(sends(gateway), [{ answer: { to: "v-a6", picks: [[0, 2]] } }]);
    // Final: still checkboxes, in a group named by the question, the two picked.
    const group = card(thread).getByRole("group", { name: CARDS.many.questions[0]?.question });
    assert.equal(await group.count(), 1);
    assert.deepEqual(await choices(thread, "checkbox"), [
      "true unavailable",
      "false unavailable",
      "true unavailable",
      "false unavailable",
    ]);
    assert.deepEqual(await settled(thread, "checkbox"), [
      "solid 1 checked",
      "dashed 0.5",
      "solid 1 checked",
      "dashed 0.5",
    ]);
    // The provider's words for the picks, which the chat list says as the person's.
    await page
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "You: WELCOME5, VIP20" })
      .waitFor();
    await page.close();
  }),
);

test(
  "by keys: arrows move the pick held, and Confirm is reached by Tab and pressed by Enter",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "confirm");
    await card(thread).getByRole("radio", { name: "Fix it now" }).focus();
    // The group moves its focus on the next turn of the page, and picks there while the key is down,
    // as a key a person presses still is.
    await page.keyboard.down("ArrowDown");
    await card(thread).getByRole("radio", { name: PICKED, checked: true }).waitFor();
    await page.keyboard.up("ArrowDown");
    assert.deepEqual(await choices(thread, "radio"), ["false", "true", "false"]);
    assert.deepEqual(sends(gateway), [], "moving holds, never sends");
    await page.keyboard.press("Tab");
    assert.equal(
      await confirm(thread).evaluate((button) => button === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(sends(gateway), [{ answer: { to: "v-a6", picks: [[PICK]] } }]);
    await page.close();
  }),
);

test(
  "a pick held, then written past: the card is passed over, none picked, and no Confirm",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "confirm");
    await card(thread).getByRole("radio", { name: PICKED }).click();
    await page.getByRole("textbox", { name: "Message" }).fill(TYPED);
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator('[data-ask="passed"]').waitFor();
    assert.deepEqual(await choices(thread, "radio"), [
      "false unavailable",
      "false unavailable",
      "false unavailable",
    ]);
    assert.equal(await confirm(thread).count(), 0);
    assert.deepEqual(sends(gateway), [{ text: TYPED }]);
    await page.close();
  }),
);

test(
  "in a conversation the person only reads, nothing can be held or confirmed",
  withGateway(async (gateway) => {
    gateway.sayWith("a-reviewer", "a-research", {
      id: "q1",
      role: "assistant",
      text: "Which coupons should I check?",
      at: new Date().toISOString(),
      ask: CARDS.many,
    });
    gateway.sayWith("a-triage", "a-research", {
      id: "t1",
      role: "assistant",
      text: "Should I fix it?",
      at: new Date().toISOString(),
      ask: CARDS.confirm,
    });
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    for (const [id, name, words, role, count] of [
      ["a-reviewer", "Reviewer", "Which coupons should I check?", "checkbox", 4],
      ["a-triage", "Triage", "Should I fix it?", "radio", 3],
    ] as const) {
      await page.goto(`${gateway.url}/#/a/${id}`);
      await page
        .getByRole("main")
        .getByRole("list", { name: `${name}'s chats with other agents` })
        .getByRole("button")
        .filter({ hasText: words })
        .click();
      const asks = page.getByRole("group", { name: `${name} asks` });
      await asks.waitFor();
      assert.deepEqual(
        await asks
          .getByRole(role)
          .evaluateAll((rows) => rows.map((row) => (row as HTMLButtonElement).disabled)),
        Array(count).fill(true),
        `${name}'s ${role}es`,
      );
      assert.equal(await asks.getByRole("button", { name: "Confirm" }).isDisabled(), true);
    }
    await page.close();
  }),
);
