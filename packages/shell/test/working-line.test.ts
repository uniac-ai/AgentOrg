// The line under a person's message while it is in hand, in a real browser over the stand-in
// gateway: taken, its step, answered or closed, read live and from the record; and how it reads,
// wraps and is heard.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import {
  type Hold,
  researchHolds,
  researchSays,
  SAID,
  SECOND_ASK,
  STEP_WORDS,
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
  await thread.locator(".whitespace-pre-wrap").first().waitFor();
  await page.mouse.move(1, 1);
  return { page, thread };
}
/** Research's conversation at one of the design's states, opened then. */
const holding = (gateway: Gateway, state: Hold, width?: number) => {
  researchHolds(gateway, state);
  return conversation(gateway, width);
};

/** Each of the person's messages, with the line under it. */
const said = (thread: Locator) =>
  thread.evaluate((root) =>
    [...root.querySelectorAll('[data-slot="message"][data-align="end"]')].map((message) => {
      const line = message.querySelector('[data-slot="marker"][role="status"]');
      const words = line?.querySelector('[data-slot="marker-content"]');
      return {
        said: message.querySelector('[data-slot="bubble"]')?.textContent?.trim(),
        line: line && {
          heard: line.querySelector(".sr-only")?.textContent,
          words: words?.textContent ?? null,
          shimmers: !!words && getComputedStyle(words).animationName === "tw-shimmer",
          spinner: !!line.querySelector('[data-slot="spinner"]'),
          // Nothing else is in it to press.
          pressable: line.querySelectorAll("button, a, [tabindex]").length,
        },
      };
    }),
  );
const line = (thread: Locator) => thread.locator('[data-slot="marker"][role="status"]');

test(
  "taken, a spinner under that message alone; its step, the step's words shimmering; answered and closed, no line; a closed message has its problem line, never with a line",
  withGateway(async (gateway) => {
    const at = new Date().toISOString();
    gateway.converse("a-research", [
      { id: "v-u1", role: "user", text: SAID.oneLineAsk, at },
      { id: "v-a1", role: "assistant", text: SAID.oneLine, at },
      { id: "v-u2", role: "user", text: SAID.longAsk, at },
    ]);
    gateway.setChatStatus("a-research", { state: "working" });
    const { page, thread } = await conversation(gateway);
    assert.equal(await line(thread).count(), 0, "nothing before any word on it");
    gateway.progress("a-research", "v-u2", { state: "taken" });
    await thread.locator('[data-slot="spinner"]').waitFor();
    assert.deepEqual(
      (await said(thread)).map((one) => one.line),
      [null, { heard: "Taken", words: null, shimmers: false, spinner: true, pressable: 0 }],
    );
    gateway.progress("a-research", "v-u2", { state: "taken", step: "Reading the README" });
    await line(thread).locator('[data-slot="marker-content"]').waitFor();
    assert.deepEqual((await said(thread))[1]?.line, {
      heard: "Reading the README",
      words: "Reading the README",
      shimmers: true,
      spinner: false,
      pressable: 0,
    });
    gateway.progress("a-research", "v-u2", { state: "answered" });
    gateway.addMessage("a-research", { id: "v-a2", role: "assistant", text: SAID.long, at });
    await line(thread).waitFor({ state: "detached" });
    // A message closed with no answer: while it is in hand its line, and then its problem.
    gateway.addMessage("a-research", { id: "v-u3", role: "user", text: SECOND_ASK, at });
    gateway.progress("a-research", "v-u3", { state: "taken" });
    await line(thread).waitFor();
    const limit = "You've reached your plan's limit.";
    gateway.failChat("a-research", { code: "usage_limit", message: limit });
    // The problem is heard: the list beside says it, and the conversation does once nothing is in hand.
    await page.getByRole("main").getByText(limit).first().waitFor();
    assert.equal(await thread.getByRole("alert").count(), 0, "no problem while its line is drawn");
    gateway.progress("a-research", "v-u3", { state: "closed" });
    await thread.getByRole("alert").waitFor();
    assert.equal(await line(thread).count(), 0, "its line gone with its problem said");
    // Closed with nothing said before: nothing was drawn, and its problem is.
    gateway.progress("a-research", "v-u1", { state: "closed" });
    assert.equal(await line(thread).count(), 0);
    await page.close();
  }),
);

test(
  "a page opened late draws each message in hand from the record, and the step's words are the step's active wording",
  withGateway(async (gateway) => {
    const { page, thread } = await holding(gateway, "inProgress");
    await line(thread).locator('[data-slot="marker-content"]').waitFor();
    assert.deepEqual(
      (await said(thread)).map((one) => one.line?.words),
      [STEP_WORDS.tests],
    );
    await page.close();
  }),
);

test(
  "two messages in hand at once, each with its own line: a step without an active wording is its text",
  withGateway(async (gateway) => {
    const { page, thread } = await holding(gateway, "two");
    await thread.locator('[data-slot="spinner"]').waitFor();
    await line(thread).locator('[data-slot="marker-content"]').waitFor();
    assert.deepEqual(
      (await said(thread)).map((one) => [one.said, one.line?.heard, one.line?.spinner]),
      [
        [SAID.longAsk, STEP_WORDS.files, false],
        [SECOND_ASK, "Taken", true],
      ],
    );
    await page.close();
  }),
);

for (const width of [1440, 390])
  test(
    `a long step wraps inside 80% of the conversation, its end at the bubble's, nothing scrolling sideways (${width} px)`,
    withGateway(async (gateway) => {
      const { page, thread } = await holding(gateway, "longStep", width);
      await line(thread).locator('[data-slot="marker-content"]').waitFor();
      const seen = await thread.evaluate((root) => {
        const message = root.querySelector('[data-slot="message"][data-align="end"]') as Element;
        const box = (e: Element | null) => (e as Element).getBoundingClientRect();
        const line = box(message.querySelector('[data-slot="marker"][role="status"]'));
        const words = box(message.querySelector('[data-slot="marker-content"]'));
        const bubble = box(message.querySelector('[data-slot="bubble"]'));
        return {
          room: box(message).width,
          width: line.width,
          end: Math.round(bubble.right - line.right),
          rows: Math.round(
            words.height /
              Number.parseFloat(
                getComputedStyle(message.querySelector('[data-slot="marker-content"]') as Element)
                  .lineHeight,
              ),
          ),
          page: [innerWidth, document.documentElement.scrollWidth],
        };
      });
      assert.ok(seen.width <= seen.room * 0.8 + 0.5, `at most 80%: ${seen.width} of ${seen.room}`);
      assert.equal(seen.end, 0, "its end at the bubble's");
      assert.ok(seen.rows >= 2, `it wraps: ${seen.rows} rows`);
      const [has, needs] = seen.page;
      assert.ok(needs !== undefined && has !== undefined && needs <= has, "nothing sideways");
      await page.close();
    }),
  );

test(
  "an answered message, as the record has it, has no line",
  withGateway(async (gateway) => {
    researchSays(gateway, "long");
    gateway.progress("a-research", "v-u2", { state: "answered" });
    const { page, thread } = await conversation(gateway);
    await thread.locator(".prose-chat").first().waitFor();
    assert.equal(await line(thread).count(), 0);
    await page.close();
  }),
);
