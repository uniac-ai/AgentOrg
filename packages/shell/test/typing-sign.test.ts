// The agent typing in a conversation, in a real browser over the stand-in gateway: one sign at the
// conversation's end while the agent works on the party's newest message, taken or not yet heard
// of, with no problem; what takes it away; nothing under the person's own messages; and the
// message just sent only making room for the sign as it comes under it.
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
  "one message: the sign at the conversation's end while the agent works on it and while its reply is written, under each bubble of the reply that is whole, 4 px under the last; gone once the reply is whole",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "one");
    await sign(thread).waitFor();
    assert.deepEqual(await drawn(thread), [`you: ${SAID.longAsk}`, "typing"]);
    assert.equal(await sign(thread).locator(".typing-dot").count(), 3);
    // Its first words say nothing yet: they may still be written.
    gateway.delta("a-research", "v-a2", "It's a small shop demo");
    await page.waitForTimeout(300);
    assert.deepEqual(await drawn(thread), [`you: ${SAID.longAsk}`, "typing"]);
    assert.equal(await thread.getByText("It's a small shop demo").count(), 0);
    // Its next paragraph begun, the first is whole, and the sign is under it.
    gateway.delta("a-research", "v-a2", ".\n\nThe README");
    await thread.getByText("It's a small shop demo.").waitFor();
    assert.deepEqual(await drawn(thread), [
      `you: ${SAID.longAsk}`,
      "agent: It's a small shop demo.",
      "typing",
    ]);
    assert.equal(await thread.getByText("The README").count(), 0);
    // Once the bubble has come in: it rises through a few pixels as it does. Its own motion, not
    // the sign's dots', which never ends.
    await thread.evaluate((root) =>
      Promise.all(
        [...root.querySelectorAll('[data-slot="bubble"]')]
          .flatMap((bubble) => bubble.getAnimations())
          .map((one) => one.finished),
      ),
    );
    const [whole, typing] = await thread.evaluate((root) =>
      [...root.querySelectorAll('[data-slot="bubble"]')]
        .slice(-2)
        .map((bubble) => bubble.getBoundingClientRect())
        .map((box) => [Math.round(box.top), Math.round(box.bottom)]),
    );
    assert.equal((typing?.[0] ?? 0) - (whole?.[1] ?? 0), 4, "4 px under the agent's own bubble");
    gateway.addMessage("a-research", {
      id: "v-a2",
      role: "assistant",
      text: "It's a small shop demo.\n\nThe README is short.",
      at: at_(0),
    });
    await thread.getByText("The README is short.").waitFor();
    await sign(thread).waitFor({ state: "detached" });
    assert.deepEqual(await drawn(thread), [
      `you: ${SAID.longAsk}`,
      "agent: It's a small shop demo.",
      "agent: The README is short.",
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

/** Sends words from the conversation's composer, as the person does. */
async function send(page: Page, text: string) {
  const box = page.getByRole("main").getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}
/** The newest message of Research's conversation, as the stand-in has it. */
const newestOf = (gateway: Gateway) =>
  gateway.agents.get("a-research")?.chat.messages.at(-1)?.id as string;
const working = (gateway: Gateway) => gateway.agents.get("a-research")?.chat.status.state;

test(
  "a message closed with an emoji ends it as the emoji comes, though the agent still works",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result");
    await send(page, "Thanks!");
    await sign(thread).waitFor();
    const thanks = newestOf(gateway);
    gateway.progress("a-research", thanks, { state: "taken" });
    gateway.progress("a-research", thanks, { state: "closed", reaction: "👍" });
    await thread.getByRole("img", { name: "Research reacted 👍" }).waitFor();
    await sign(thread).waitFor({ state: "detached" });
    // Its turn goes on: what it does after is its own, and the sign doesn't come back for it.
    assert.equal(working(gateway), "working");
    gateway.setChatStatus("a-research", { state: "idle" });
    await page.waitForFunction(() => !document.querySelector(".typing-dot"));
    await page.close();
  }),
);

test(
  "a message sent after the last was answered brings the sign back until it is answered too",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result");
    await send(page, "Is the coupon fixed?");
    await sign(thread).waitFor();
    const first = newestOf(gateway);
    gateway.progress("a-research", first, { state: "taken" });
    gateway.addMessage("a-research", {
      id: "v-a10",
      role: "assistant",
      text: "Yes: it's refused after its date.",
      at: at_(0),
    });
    gateway.progress("a-research", first, { state: "answered" });
    await thread.getByText("Yes: it's refused after its date.").waitFor();
    await sign(thread).waitFor({ state: "detached" });
    // The agent still works. The next message brings the sign back at once, under it.
    assert.equal(working(gateway), "working");
    await send(page, "And the tests?");
    await sign(thread).waitFor();
    assert.deepEqual((await drawn(thread)).slice(-2), ["you: And the tests?", "typing"]);
    const second = newestOf(gateway);
    gateway.progress("a-research", second, { state: "taken" });
    gateway.addMessage("a-research", {
      id: "v-a11",
      role: "assistant",
      text: "They pass.",
      at: at_(0),
    });
    gateway.progress("a-research", second, { state: "answered" });
    await thread.getByText("They pass.").waitFor();
    await sign(thread).waitFor({ state: "detached" });
    assert.equal(working(gateway), "working");
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
  "in a conversation longer than its room, the message just sent is at the room's foot, and frame by frame only makes room for the sign that comes under it: up by the sign's 56 px at most, never further and never back down",
  withGateway(async (gateway) => {
    researchTypes(gateway, "result");
    // Earlier messages enough to fill the room: what comes then moves it to its end.
    gateway.agents.get("a-research")?.chat.messages.unshift(
      ...Array.from({ length: 30 }, (_, n) => ({
        id: `v-old-${n}`,
        role: "assistant" as const,
        text: `Earlier note ${n}.`,
        at: at_(60),
      })),
    );
    const { page, thread } = await conversation(gateway);
    const box = page.getByRole("textbox", { name: "Message" }).last();
    await box.fill("One more thing");
    // Where the message's place in the room is in each frame from the first it is in, until the
    // sign has been there ten frames: its place, not the few pixels it rises through as it comes
    // in. The agent says it works as soon as the message is sent.
    const drawnAt = page.evaluate(
      () =>
        new Promise<number[]>((done) => {
          const seen: number[] = [];
          let frames = 0;
          let signed = 0;
          const frame = () => {
            const message = [
              ...document.querySelectorAll('main [data-slot="message-scroller-item"]'),
            ].find((one) => one.textContent?.includes("One more thing"));
            if (message) seen.push(Math.round(message.getBoundingClientRect().top));
            if (document.querySelector('[aria-label="Research is typing"]')) signed++;
            if (signed >= 10 || ++frames > 300) done(seen);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
    );
    await box.press("Enter");
    const tops = await drawnAt;
    assert.equal(await sign(thread).count(), 1, "the sign came");
    // The sign's 40 px and the 16 px above it: in the frame the message is first drawn in if the
    // sign is there by then, or in one step after.
    const places = [...new Set(tops)];
    const [first, last] = [places[0] as number, places.at(-1) as number];
    assert.ok(
      places.length <= 2 && (first === last || first - last === 56),
      `drawn at ${tops.join(", ")}`,
    );
    const foot = await thread
      .locator('[data-slot="message-scroller-viewport"]')
      .evaluate((room) => Math.round(room.getBoundingClientRect().bottom));
    const sent = await thread
      .locator('[data-slot="message-scroller-item"]')
      .filter({ hasText: "One more thing" })
      .evaluate((message) => Math.round(message.getBoundingClientRect().bottom));
    assert.equal(foot - sent, 72, "the sign under it, then the room's 16 px");
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
