// The agent typing in a conversation, in a real browser over the stand-in gateway: one sign at the
// conversation's end while the agent works on the party's newest message, taken or not yet heard
// of, with no problem; what takes it away; and nothing under the person's own messages.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { researchTypes, SAID, SECOND_ASK, type Typing } from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat, opened as it now stands. */
async function conversation(
  gateway: Gateway,
  options: { width?: number; reducedMotion?: "reduce" } = {},
): Promise<{ page: Page; thread: Locator }> {
  const page = await browser().newPage({
    viewport: { width: options.width ?? 1440, height: 900 },
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/chat/a-research`);
  const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  await thread.locator('[data-slot="bubble"]').first().waitFor();
  return { page, thread };
}
/** Research's conversation at one of the design's states, opened then. */
const at = (gateway: Gateway, state: Typing, width?: number) => {
  researchTypes(gateway, state);
  return conversation(gateway, width ? { width } : {});
};
const sign = (thread: Locator) => thread.getByRole("status", { name: "Research is typing" });
/** What the thread draws, in order: each bubble's side and words, the sign as "typing". */
const drawn = (thread: Locator) =>
  thread.evaluate((root) =>
    [...root.querySelectorAll('[data-slot="bubble"]')].map((bubble) =>
      bubble.querySelector(".typing-dot")
        ? "typing"
        : `${bubble.closest('[data-slot="message"]')?.getAttribute("data-align") === "end" ? "you" : "agent"}: ${bubble.textContent?.trim().slice(0, 24)}`,
    ),
  );
/** Whatever is drawn under each of the person's messages besides its words and pictures. */
const under = (thread: Locator) =>
  thread.evaluate(
    (root) =>
      root.querySelectorAll(
        '[data-slot="message"][data-align="end"] :is([role="status"], [data-slot="marker"])',
      ).length,
  );
const at_ = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test(
  "one message: the sign at the conversation's end while the agent works on it, gone once its first piece is streamed",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    assert.deepEqual(await drawn(thread), [`you: ${SAID.longAsk}`, "typing"]);
    assert.equal(await sign(thread).locator(".typing-dot").count(), 3);
    gateway.delta("a-research", "v-a2", "It's a small shop demo");
    await thread.getByText("It's a small shop demo").waitFor();
    await sign(thread).waitFor({ state: "detached" });
    assert.deepEqual(await drawn(thread), [
      `you: ${SAID.longAsk}`,
      "agent: It's a small shop demo",
    ]);
    await page.close();
  }),
);

test(
  "two messages sent: one sign, after the second",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "two");
    await sign(thread).waitFor();
    assert.deepEqual(await drawn(thread), [
      `you: ${SAID.longAsk}`,
      `you: ${SECOND_ASK.slice(0, 24)}`,
      "typing",
    ]);
    await page.close();
  }),
);

test(
  "a message from the agent ends it: a receipt, though the agent still works",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    gateway.addMessage("a-research", {
      id: "v-a9",
      role: "assistant",
      text: SAID.receipt,
      at: at_(0),
    });
    await thread.getByText(SAID.receipt).waitFor();
    await sign(thread).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.querySelectorAll(".typing-dot").length), 0);
    await page.close();
  }),
);

test(
  "a message closed with no reply ends it, and no problem is said",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    gateway.progress("a-research", "v-u2", { state: "closed" });
    await sign(thread).waitFor({ state: "detached" });
    gateway.setChatStatus("a-research", { state: "idle" });
    await page.waitForFunction(() => !document.querySelector(".typing-dot"));
    assert.equal(await thread.getByRole("alert").count(), 0);
    await page.close();
  }),
);

test(
  "the turn ending unanswered ends it, and the problem line says why",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    // As the agent's loop ends a turn that failed: what it left open is closed, and the
    // conversation says why.
    gateway.progress("a-research", "v-u2", { state: "closed" });
    gateway.failChat("a-research", { code: "not_answered", message: "Not answered" });
    await thread.getByRole("alert").getByText("Not answered").waitFor();
    assert.equal(await sign(thread).count(), 0, "never both");
    await page.close();
  }),
);

test(
  "a send refused while the agent types says why at once, and the sign gives way to it",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    gateway.refuseNext("chat.send", "busy", "It can't take that now.");
    const box = page.getByRole("textbox", { name: "Message" }).last();
    await box.fill("One more thing");
    await box.press("Enter");
    await thread.getByRole("alert").getByText("It can't take that now.").waitFor();
    assert.equal(await sign(thread).count(), 0, "one or the other, never both");
    await page.close();
  }),
);

test(
  "a page opened while the agent types shows the sign from the record; one opened after the turn ended unanswered shows the problem alone",
  withGateway(async (gateway) => {
    const typing = await at(gateway, "late");
    await sign(typing.thread).waitFor();
    await typing.page.close();
    const ended = await at(gateway, "ended");
    await ended.thread.getByRole("alert").getByText("Not answered").waitFor();
    assert.equal(await sign(ended.thread).count(), 0);
    await ended.page.close();
  }),
);

test(
  "an idle agent shows no sign, even with the person's message newest",
  withGateway(async (gateway) => {
    researchTypes(gateway, "one");
    gateway.setChatStatus("a-research", { state: "idle" });
    const { page, thread } = await conversation(gateway);
    await page.waitForTimeout(300);
    assert.equal(await sign(thread).count(), 0);
    await page.close();
  }),
);

test(
  "nothing is under the person's messages in any state, a step taken included",
  withGateway(async (gateway) => {
    for (const state of ["one", "two", "receipt", "result", "noReply", "ended"] as const) {
      const { page, thread } = await at(gateway, state);
      if (state === "one" || state === "two") {
        await sign(thread).waitFor();
        // A step said while it is taken draws nothing either.
        gateway.progress("a-research", "v-u2", {
          state: "taken",
          step: "Running the demo's tests",
        });
        await page.waitForTimeout(200);
      }
      assert.equal(await under(thread), 0, state);
      assert.equal(await thread.getByText("Running the demo's tests").count(), 0, state);
      await page.close();
    }
  }),
);

test(
  "its dots rise in turn, and stay still for a person who asks for less motion",
  withGateway(async (gateway) => {
    researchTypes(gateway, "one");
    for (const reducedMotion of [undefined, "reduce"] as const) {
      const { page, thread } = await conversation(gateway, reducedMotion ? { reducedMotion } : {});
      await sign(thread).waitFor();
      const moving = await sign(thread)
        .locator(".typing-dot")
        .evaluateAll((dots) => dots.map((dot) => getComputedStyle(dot).animationName));
      assert.deepEqual(
        moving,
        reducedMotion ? ["none", "none", "none"] : ["typing-dot", "typing-dot", "typing-dot"],
      );
      await page.close();
    }
  }),
);
