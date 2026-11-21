// The agent's decision card, plain, in a real browser over the stand-in gateway: none while the agent
// is at its turn; one tap is the answer, sent alone and final, shown by the card and never as a bubble;
// writing instead or a newer card passes it over; a page opened later shows the pick; its room; and
// how a keyboard and a screen reader meet it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import {
  CARDS,
  type CardCase,
  COUPONS,
  cardComes,
  DONE,
  PICK,
  PICKED,
  QUESTION,
  researchAsks,
  SECOND_ASK,
  TYPED,
} from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat, opened as it now stands. */
async function conversation(
  gateway: Gateway,
  width = 1440,
): Promise<{ page: Page; thread: Locator }> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/chat/a-research`);
  const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  await thread.locator('[data-slot="bubble"]').first().waitFor();
  return { page, thread };
}
/** Research's conversation at one of the design's states for the card, opened then. */
const at = (gateway: Gateway, state: CardCase, width?: number) => {
  researchAsks(gateway, state);
  return conversation(gateway, width);
};
const card = (thread: Locator) => thread.getByRole("group", { name: "Research asks" });
const choice = (thread: Locator, name: string) => card(thread).getByRole("radio", { name });
const sign = (thread: Locator) => thread.getByRole("status", { name: "Research is typing" });
/** What the person sent to the conversation, as the stand-in was given it. */
const sends = (gateway: Gateway) =>
  gateway.calls.filter((call) => call.slot === "chat_a_research" && call.method === "send");
/** Each choice's name and whether it is picked and pressable, as a screen reader meets them. */
const choices = (thread: Locator) =>
  card(thread)
    .getByRole("radio")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        name: row.textContent,
        checked: row.getAttribute("aria-checked"),
        unavailable:
          row.getAttribute("aria-disabled") === "true" || (row as HTMLButtonElement).disabled,
      })),
    );
/** Whether a row looks picked, or dimmed and dashed. */
const looks = (thread: Locator) =>
  card(thread)
    .getByRole("radio")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const style = getComputedStyle(row);
        return `${style.borderTopStyle} ${style.opacity}${row.querySelector("svg") ? " checked" : ""}`;
      }),
    );
/** The person's bubbles, by their words. */
const mine = (thread: Locator) =>
  thread
    .locator('[data-slot="message"][data-align="end"] [data-slot="bubble-content"]')
    .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.textContent?.trim()));
const box = (locator: Locator) =>
  locator.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });

test(
  "none while the agent is at its turn; once it is idle, the card under its words, nothing picked",
  withGateway(async (gateway) => {
    researchAsks(gateway, "plain", true);
    const { page, thread } = await conversation(gateway);
    await sign(thread).waitFor();
    cardComes(gateway);
    await thread.getByText("The coupons are in cart/coupons").waitFor();
    assert.equal(await card(thread).count(), 0, "none while the agent works");
    gateway.setChatStatus("a-research", { state: "idle" });
    await card(thread).waitFor();
    const group = card(thread).getByRole("radiogroup", { name: QUESTION });
    assert.equal(await group.count(), 1, "a radio group named by the question");
    assert.equal(await card(thread).getByText(QUESTION).count(), 1);
    assert.deepEqual(await choices(thread), [
      { name: "Fix it now", checked: "false", unavailable: false },
      { name: "Fix it and add a test", checked: "false", unavailable: false },
      { name: "Leave it for now", checked: "false", unavailable: false },
    ]);
    assert.equal(await card(thread).getByRole("button").count(), 0, "no Confirm, nothing else");
    await page.close();
  }),
);

test(
  "a tap is the answer: the label's place sent alone, the pick shown on the card and never as a bubble, and a second tap does nothing",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "plain");
    await choice(thread, PICKED).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(
      sends(gateway).map((call) => call.input),
      [{ answer: { to: "v-a6", picks: [[PICK]] } }],
    );
    assert.deepEqual(await choices(thread), [
      { name: "Fix it now", checked: "false", unavailable: true },
      { name: PICKED, checked: "true", unavailable: true },
      { name: "Leave it for now", checked: "false", unavailable: true },
    ]);
    assert.deepEqual(await looks(thread), ["dashed 0.5", "solid 1 checked", "dashed 0.5"]);
    // The agent is at work on it: its sign is under the card, and the person's words are nowhere.
    await sign(thread).waitFor();
    assert.deepEqual(await mine(thread), ["What's in README.md?", SECOND_ASK]);
    await choice(thread, "Leave it for now").click({ force: true });
    await choice(thread, PICKED).click({ force: true });
    assert.equal(sends(gateway).length, 1, "nothing more sent");
    // The record has the label as its words, which the chat list says as the person's.
    const record = gateway.chatOf("a-research").messages;
    assert.equal(record.at(-1), PICKED);
    await page
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: `You: ${PICKED}` })
      .waitFor();
    await page.close();
  }),
);

test(
  "writing in the box instead passes the card over: every choice dimmed, dashed and unavailable, none picked",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "plain");
    await card(thread).waitFor();
    await page.getByRole("textbox", { name: "Message" }).fill(TYPED);
    await page.getByRole("button", { name: "Send" }).click();
    await thread.getByText(TYPED).waitFor();
    await page.locator('[data-ask="passed"]').waitFor();
    assert.deepEqual(
      (await choices(thread)).map(({ checked, unavailable }) => `${checked} ${unavailable}`),
      ["false true", "false true", "false true"],
    );
    assert.deepEqual(await looks(thread), ["dashed 0.5", "dashed 0.5", "dashed 0.5"]);
    assert.deepEqual(
      sends(gateway).map((call) => call.input),
      [{ text: TYPED }],
    );
    await page.close();
  }),
);

test(
  "a newer card passes the older over, and only the newer can be answered",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "plain");
    await card(thread).waitFor();
    gateway.addMessage("a-research", {
      id: "v-a7",
      role: "assistant",
      text: "Or, before that:",
      at: new Date().toISOString(),
      ask: CARDS.bare,
    });
    await thread.getByText("Or, before that:").waitFor();
    const states = () =>
      card(thread).evaluateAll((cards) => cards.map((one) => one.getAttribute("data-ask")));
    await page.waitForFunction(() => document.querySelectorAll('[data-ask="passed"]').length === 1);
    assert.deepEqual(await states(), ["passed", "open"]);
    await card(thread).last().getByRole("radio", { name: "Fix it now" }).click();
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(
      sends(gateway).map((call) => call.input),
      [{ answer: { to: "v-a7", picks: [[0]] } }],
    );
    await page.close();
  }),
);

test(
  "a page opened later shows the pick, read from the answer, with no bubble for it",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "late");
    await thread.getByText(DONE).waitFor();
    assert.deepEqual(
      (await choices(thread)).map(({ checked }) => checked),
      ["false", "true", "false"],
    );
    assert.deepEqual(await mine(thread), ["What's in README.md?", "Thanks!", SECOND_ASK]);
    // The reply to the pick is a turn's 16 px under the card: the pick was the person's turn.
    const [under, reply] = await Promise.all([
      box(card(thread)),
      box(thread.locator('[data-slot="bubble"]', { hasText: DONE })),
    ]);
    assert.equal(reply.top - under.bottom, 16);
    await page.close();
  }),
);

test(
  "its room: 4 px under the agent's words and the conversation's width; alone, a turn's 16 px under the person's",
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      const { page, thread } = await at(gateway, "plain", width);
      await card(thread).waitFor();
      const [words, asked, it] = await Promise.all([
        box(thread.locator('[data-slot="bubble"]', { hasText: "SPRING10, expired" })),
        box(thread.locator('[data-slot="bubble"]', { hasText: SECOND_ASK })),
        box(card(thread)),
      ]);
      assert.equal(it.top - words.bottom, 4, "4 px under the agent's words");
      assert.equal(it.left, words.left, "from the conversation's start");
      assert.equal(it.right, asked.right, "to its end");
      await page.close();
    }
    // The card alone, with no words over it.
    researchAsks(gateway, "plain", true);
    gateway.addMessage("a-research", {
      id: "v-a6",
      role: "assistant",
      text: "",
      at: new Date().toISOString(),
      ask: CARDS.plain,
    });
    gateway.setChatStatus("a-research", { state: "idle" });
    const { page, thread } = await conversation(gateway);
    await card(thread).waitFor();
    const [asked, it] = await Promise.all([
      box(thread.locator('[data-slot="bubble"]', { hasText: SECOND_ASK })),
      box(card(thread)),
    ]);
    assert.equal(it.top - asked.bottom, 16, "a turn's 16 px under the person's");
    assert.equal(await thread.getByText(COUPONS.split("\n")[0] as string).count(), 0);
    await page.close();
  }),
);

test(
  "by keys: arrows move between the choices and picking waits for Enter",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "plain");
    await choice(thread, "Fix it now").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await choice(thread, PICKED).evaluate((row) => row === document.activeElement),
      true,
    );
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    assert.equal(
      await choice(thread, "Leave it for now").evaluate((row) => row === document.activeElement),
      true,
      "round from the first to the last",
    );
    assert.equal(sends(gateway).length, 0, "moving picks nothing");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.locator('[data-ask="answered"]').waitFor();
    assert.deepEqual(
      sends(gateway).map((call) => call.input),
      [{ answer: { to: "v-a6", picks: [[PICK]] } }],
    );
    await page.close();
  }),
);

test(
  "without a question line its choices are named for the agent, and a choice's line shows under its words",
  withGateway(async (gateway) => {
    let { page, thread } = await at(gateway, "bare");
    await card(thread).getByRole("radiogroup", { name: "Research's choices" }).waitFor();
    assert.equal(await card(thread).locator("p").count(), 0);
    await page.close();
    ({ page, thread } = await at(gateway, "detail"));
    await card(thread).waitFor();
    assert.deepEqual(
      (await choices(thread)).map(({ name }) => name),
      [
        "Fix it nowRefuse it after its date, in cart/coupons",
        "Fix it and add a testThe same, with a test that fails today",
        "Leave it for now",
      ],
    );
    await page.close();
  }),
);

test(
  "in a conversation the person only reads, its choices can't be picked",
  withGateway(async (gateway) => {
    gateway.sayWith("a-reviewer", "a-research", {
      id: "q1",
      role: "assistant",
      text: "Which should I look at first?",
      at: new Date().toISOString(),
      ask: CARDS.bare,
    });
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Reviewer's chats with other agents" })
      .getByRole("button")
      .filter({ hasText: "Which should I look at first?" })
      .click();
    const asks = page.getByRole("group", { name: "Reviewer asks" });
    await asks.waitFor();
    assert.deepEqual(
      await asks
        .getByRole("radio")
        .evaluateAll((rows) => rows.map((row) => (row as HTMLButtonElement).disabled)),
      [true, true, true],
    );
    await page.close();
  }),
);
