// The agent's emoji on the party's message, in a real browser over the stand-in gateway: it comes as
// the typing sign goes, a page opened late shows it, a screen reader hears whose it is, it sits on
// the bubble's end corner ringed in the conversation's ground, the message keeps room under it, and
// it never meets the message's words.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { REACTION, type Reacted, researchReacts } from "./design/samples.ts";

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
/** Research's conversation at one of the design's states for the emoji, opened then. */
const at = (gateway: Gateway, state: Reacted, width?: number) => {
  researchReacts(gateway, state);
  return conversation(gateway, width ? { width } : {});
};
const sign = (thread: Locator) => thread.getByRole("status", { name: "Research is typing" });
const emoji = (thread: Locator) =>
  thread.getByRole("img", { name: `Research reacted ${REACTION}` });
/** What a box shadow draws: the shadows it lists that have a colour. */
const drawnOf = (shadow: string) =>
  shadow
    .split(/,(?![^(]*\))/)
    .map((one) => one.trim())
    .filter((one) => !one.startsWith("rgba(0, 0, 0, 0)"));
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/**
 * In one read: the emoji's box, its bubble's, each line of the bubble's words, the next bubble
 * drawn after it, the conversation's, the emoji's look, and the ground its ring is to match: the
 * nearest surface under the message.
 */
const read = (thread: Locator) =>
  thread.evaluate((root) => {
    const box = (b: DOMRect): Box => ({
      left: b.left,
      top: b.top,
      right: b.right,
      bottom: b.bottom,
    });
    const pill = root.querySelector('[data-slot="bubble-reactions"]');
    const bubble = pill?.closest('[data-slot="bubble"]');
    const words = bubble?.querySelector('[data-slot="bubble-content"]');
    if (!pill || !bubble || !words) throw new Error("no emoji on a bubble");
    const range = document.createRange();
    range.selectNodeContents(words);
    const bubbles = [...root.querySelectorAll('[data-slot="bubble"]')];
    const next = bubbles[bubbles.indexOf(bubble) + 1];
    let under = bubble.closest('[data-slot="message"]')?.parentElement;
    while (under && getComputedStyle(under).backgroundColor === "rgba(0, 0, 0, 0)")
      under = under.parentElement;
    const style = getComputedStyle(pill);
    return {
      pill: box(pill.getBoundingClientRect()),
      bubble: box(bubble.getBoundingClientRect()),
      lines: [...range.getClientRects()].map(box),
      next: next ? box(next.getBoundingClientRect()) : null,
      region: box(root.getBoundingClientRect()),
      ring: style.boxShadow,
      size: style.fontSize,
      animation: style.animationName,
      ground: under ? getComputedStyle(under).backgroundColor : null,
    };
  });

test(
  "the emoji comes as the typing sign goes, grows in, and stays whatever is said of the message after",
  withGateway(async (gateway) => {
    researchReacts(gateway, "arrives", "taken");
    const { page, thread } = await conversation(gateway);
    await sign(thread).waitFor();
    assert.equal(await emoji(thread).count(), 0, "none while the agent works on the message");
    gateway.progress("a-research", "v-u7", { state: "closed", reaction: REACTION });
    gateway.setChatStatus("a-research", { state: "idle" });
    await emoji(thread).waitFor();
    await sign(thread).waitFor({ state: "detached" });
    assert.equal(await emoji(thread).textContent(), REACTION);
    assert.equal((await read(thread)).animation, "reaction-in");
    // A reply may still follow the close: that word on the message doesn't say the emoji again.
    gateway.progress("a-research", "v-u7", { state: "answered" });
    gateway.addMessage("a-research", reply("v-a8", "Glad it helped."));
    await thread.getByText("Glad it helped.").waitFor();
    assert.equal(await emoji(thread).count(), 1);
    await page.close();
  }),
);

test(
  "a page opened late shows the emoji as the record has it, still",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "arrives");
    await emoji(thread).waitFor();
    assert.equal(await emoji(thread).textContent(), REACTION);
    assert.equal((await read(thread)).animation, "none");
    await page.close();
  }),
);

test(
  "for a person who asks for less motion, the emoji is simply there as it comes",
  withGateway(async (gateway) => {
    researchReacts(gateway, "arrives", "taken");
    const { page, thread } = await conversation(gateway, { reducedMotion: "reduce" });
    await sign(thread).waitFor();
    gateway.progress("a-research", "v-u7", { state: "closed", reaction: REACTION });
    await emoji(thread).waitFor();
    assert.equal((await read(thread)).animation, "none");
    await page.close();
  }),
);

test(
  "the emoji sits on the bubble's end corner, 16 px in a 24 px pill, ringed in the ground on Chat and in the floating chat",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "arrives");
    await emoji(thread).waitFor();
    const chat = await read(thread);
    assert.equal(chat.size, "16px");
    assert.equal(chat.pill.bottom - chat.pill.top, 24);
    assert.equal(chat.pill.right - chat.bubble.right, 8, "8 px past the bubble's end");
    assert.equal(chat.bubble.bottom - chat.pill.top, 4, "4 px over its foot");
    assert.ok(chat.ground, "the conversation has a ground");
    assert.deepEqual(drawnOf(chat.ring), [`${chat.ground} 0px 0px 0px 3px`]);
    // The same conversation in the floating chat, whose ground is its own.
    await page.goto(`${gateway.url}/#/a/a-research`);
    await page.getByRole("button", { name: /^Chats/ }).click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    await panel
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Research" })
      .click();
    const floating = panel.getByRole("region", { name: "Messages" });
    await emoji(floating).waitFor();
    const over = await read(floating);
    assert.notEqual(over.ground, chat.ground, "the floating chat's ground isn't the page's");
    assert.deepEqual(drawnOf(over.ring), [`${over.ground} 0px 0px 0px 3px`]);
    await page.close();
  }),
);

test(
  "a reacted message keeps room under its emoji: 4 px to the party's next message, 16 px to the agent's",
  withGateway(async (gateway) => {
    const followed = await at(gateway, "followed");
    await emoji(followed.thread).waitFor();
    const same = await read(followed.thread);
    assert.equal(same.next && same.next.top - same.pill.bottom, 4);
    await followed.page.close();
    const { page, thread } = await at(gateway, "arrives");
    await emoji(thread).waitFor();
    gateway.addMessage("a-research", reply("v-a8", "Glad it helped."));
    await thread.getByText("Glad it helped.").waitFor();
    // Once the reply has come in: it rises through a few pixels as it does.
    await thread.evaluate((root) =>
      Promise.all(
        [...root.querySelectorAll('[data-slot="bubble"]')]
          .flatMap((bubble) => bubble.getAnimations())
          .map((one) => one.finished),
      ),
    );
    const changes = await read(thread);
    assert.equal(changes.next && changes.next.top - changes.pill.bottom, 16);
    await page.close();
  }),
);

for (const [width, size] of [
  [1440, "wide"],
  [390, "on a phone"],
] as const)
  test(
    `the emoji and its ring never meet the words, on one line and wrapping, ${size}`,
    withGateway(async (gateway) => {
      for (const state of ["arrives", "long"] as const) {
        const { page, thread } = await at(gateway, state, width);
        await emoji(thread).waitFor();
        const { pill, lines, region } = await read(thread);
        assert.equal(lines.length > 1, state === "long", "the long thanks wraps");
        // Its ring is 3 px wide, outside its box.
        const [left, top, right, bottom] = [
          pill.left - 3,
          pill.top - 3,
          pill.right + 3,
          pill.bottom + 3,
        ];
        for (const line of lines)
          assert.ok(
            line.right <= left || line.left >= right || line.bottom <= top || line.top >= bottom,
            `${state}: the emoji at ${JSON.stringify(pill)} meets the words at ${JSON.stringify(line)}`,
          );
        assert.ok(pill.right <= region.right, "inside the conversation");
        await page.close();
      }
    }),
  );
