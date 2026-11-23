// Each of an agent's messages on its own, in a real browser over the stand-in gateway: its own
// words, its own menu with Copy, 4 px before the agent's next message and 16 px where the side
// changes.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

/**
 * Reviewer's conversation: in the floating chat, over its page, or on Chat. What Copy puts on the
 * clipboard is kept, to be read.
 */
async function conversation(
  gateway: Gateway,
  where: "floating" | "chat",
  width = 1440,
): Promise<{ page: Page; thread: Locator }> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => {
    localStorage.setItem("agentorg.session", session);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (globalThis as { copied?: string }).copied = text;
        },
      },
    });
  }, SESSION);
  // Wherever it opens, the pointer is then away from what is said.
  const away = () => page.mouse.move(1, 1);
  if (where === "chat") {
    await page.goto(`${gateway.url}/#/chat/a-reviewer`);
    const thread = page
      .getByRole("main")
      .getByRole("region", { name: "Conversation with Reviewer" });
    await thread.locator(".prose-chat").first().waitFor();
    await away();
    return { page, thread };
  }
  await page.goto(`${gateway.url}/#/a/a-reviewer`);
  await page.getByRole("button", { name: /^Chats/ }).click();
  const thread = page.getByRole("complementary", { name: "Chats" });
  await thread
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: "Reviewer" })
    .click();
  await thread.locator(".prose-chat").first().waitFor();
  await away();
  return { page, thread };
}
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});
/** The person asks; the agent works on it. */
async function ask(gateway: Gateway, thread: Locator, text: string) {
  gateway.setChatStatus("a-reviewer", { state: "working" });
  gateway.addMessage("a-reviewer", {
    id: `u-${text.length}`,
    role: "user",
    text,
    at: new Date().toISOString(),
  });
  await thread.locator(".whitespace-pre-wrap", { hasText: text }).waitFor();
}
/**
 * The agent's messages, read at one moment: each one's words, whether it offers its menu, and its
 * box; and the box of the person's last message above them.
 */
const said = (thread: Locator) =>
  thread.evaluate((root) => {
    const items = [...root.querySelectorAll('[data-slot="message-scroller-item"]')];
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    const asked = items.filter((item) => item.querySelector(".whitespace-pre-wrap")).at(-1);
    return {
      asked: asked && box(asked),
      agent: items
        .filter((item) => item.querySelector(".prose-chat"))
        .map((item) => ({
          text: (item.querySelector(".prose-chat")?.textContent ?? "").trim(),
          more: !!item.querySelector('button[aria-label="More"]'),
          ...box(item),
        })),
    };
  });
/** The agent's message with these words, by its place in the thread. */
const message = (thread: Locator, text: string) =>
  thread.locator('[data-slot="message-scroller-item"]').filter({ hasText: text });
/** Copies a message as a person does: points at its bubble, presses its "⋯", then Copy. */
async function copyThrough(page: Page, thread: Locator, text: string) {
  const bubble = message(thread, text).locator('[data-slot="bubble"]').first();
  await bubble.hover();
  await bubble.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Copy" }).click();
}
/** What the last Copy pressed put on the clipboard. */
const copied = (page: Page) => page.evaluate(() => (globalThis as { copied?: string }).copied);

/**
 * A receipt, then its result: two messages, each with its own menu whose Copy copies its words
 * alone, 4 px apart as any two of the agent's are, and 16 px under the person's.
 */
async function receiptThenResult(gateway: Gateway, page: Page, thread: Locator) {
  await ask(gateway, thread, "Is #482 ready to merge?");
  gateway.addMessage("a-reviewer", reply("r-receipt", "Looking at #482 now."));
  await message(thread, "Looking at #482 now.").waitFor();
  // While the result is being written, none of it is drawn: the agent's sign is under the receipt,
  // which, settled, offers its menu.
  gateway.delta("a-reviewer", "r-result", "It is ready: ");
  await thread.getByRole("status", { name: "Reviewer is typing" }).waitFor();
  let now = await said(thread);
  assert.deepEqual(
    now.agent.slice(-1).map(({ text, more }) => [text, more]),
    [["Looking at #482 now.", true]],
  );
  assert.equal(await thread.getByText("It is ready:").count(), 0);
  gateway.addMessage("a-reviewer", reply("r-result", "It is ready: the tests pass."));
  gateway.setChatStatus("a-reviewer", { state: "idle" });
  await message(thread, "the tests pass.").getByRole("button", { name: "More" }).waitFor();
  now = await said(thread);
  const [receipt, result] = now.agent.slice(-2);
  assert.ok(receipt && result && now.asked);
  assert.deepEqual(
    [
      [receipt.text, receipt.more],
      [result.text, result.more],
    ],
    [
      ["Looking at #482 now.", true],
      ["It is ready: the tests pass.", true],
    ],
    "two messages, each with its menu once it is done",
  );
  assert.equal(Math.round(result.top - receipt.bottom), 4, "4 px between the agent's two");
  assert.equal(Math.round(receipt.top - now.asked.bottom), 16, "16 px where the side changes");
  await copyThrough(page, thread, "the tests pass.");
  assert.equal(await copied(page), "It is ready: the tests pass.");
  await copyThrough(page, thread, "Looking at #482 now.");
  assert.equal(await copied(page), "Looking at #482 now.");
}

test(
  "a receipt and its result are two messages, 4 px apart, each with its own menu whose Copy copies it alone, the latest's once it is done",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "floating");
    await receiptThenResult(gateway, page, thread);
    await page.close();
  }),
);

test(
  "the same on Chat, on a phone",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "chat", 390);
    await receiptThenResult(gateway, page, thread);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "nothing goes sideways",
    );
    await page.close();
  }),
);

test(
  "a message being written and the same one once recorded are one element, and nothing animates again",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "floating");
    await ask(gateway, thread, "Why did it fail?");
    // Its first paragraph is drawn once its second has begun.
    gateway.delta("a-reviewer", "r1", "Three causes explain it.\n\nThe first ");
    await message(thread, "Three causes explain it.").waitFor();
    // Once its bubble has come in: that is the one time it moves.
    await message(thread, "Three causes explain it.").evaluate(async (e) => {
      const bubble = e.querySelector('[data-slot="bubble"]') as Element;
      await Promise.all(bubble.getAnimations().map((one) => one.finished));
      (e as HTMLElement & { kept?: true }).kept = true;
    });
    gateway.addMessage(
      "a-reviewer",
      reply("r1", "Three causes explain it.\n\nThe first is the lock file."),
    );
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await message(thread, "The first is the lock file.")
      .getByRole("button", { name: "More" })
      .first()
      .waitFor();
    // Its bubble and its words: what its "⋯" does as it appears is its own.
    const after = await message(thread, "Three causes explain it.").evaluate((e) => ({
      kept: !!(e as HTMLElement & { kept?: true }).kept,
      moving: [
        ...(e.querySelector('[data-slot="bubble"]') as Element).getAnimations(),
        ...(e.querySelector(".prose-chat") as Element).getAnimations({ subtree: true }),
      ].filter((one) => one.playState === "running").length,
    }));
    assert.deepEqual(after, { kept: true, moving: 0 });
    assert.equal(await message(thread, "Three causes explain it.").count(), 1);
    await page.close();
  }),
);

test(
  "earlier messages read in above leave the messages below as they were",
  withGateway(async (gateway) => {
    const chat = gateway.agents.get("a-reviewer");
    assert.ok(chat);
    const at = new Date(Date.now() - 86_400_000).toISOString();
    chat.chat.messages.unshift(
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `old${i}`,
        role: "assistant" as const,
        text: `Old note ${i}`,
        at,
      })),
    );
    const { page, thread } = await conversation(gateway, "floating");
    // Each of the last two agent messages shown, marked.
    const marked = () =>
      thread.evaluate((root) =>
        [...root.querySelectorAll('[data-slot="message-scroller-item"]')]
          .filter((item) => item.querySelector(".prose-chat"))
          .slice(-2)
          .map((item) => !!(item as HTMLElement & { kept?: true }).kept),
      );
    await thread.evaluate((root) => {
      for (const item of [...root.querySelectorAll('[data-slot="message-scroller-item"]')]
        .filter((one) => one.querySelector(".prose-chat"))
        .slice(-2))
        (item as HTMLElement & { kept?: true }).kept = true;
    });
    await thread.getByRole("button", { name: "Earlier messages" }).click();
    await thread.getByText("Old note 3", { exact: true }).waitFor({ state: "attached" });
    assert.deepEqual(await marked(), [true, true]);
    await page.close();
  }),
);

test(
  "a message nobody asked for, after a result, is a third message with its own menu",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "floating");
    await receiptThenResult(gateway, page, thread);
    await page.mouse.move(1, 1);
    gateway.addMessage("a-reviewer", reply("r-later", "#483 needs a rebase too."));
    await message(thread, "#483 needs a rebase too.")
      .getByRole("button", { name: "More" })
      .waitFor();
    const now = await said(thread);
    assert.deepEqual(
      now.agent.slice(-3).map(({ text, more }) => [text, more]),
      [
        ["Looking at #482 now.", true],
        ["It is ready: the tests pass.", true],
        ["#483 needs a rebase too.", true],
      ],
    );
    await copyThrough(page, thread, "#483 needs a rebase too.");
    assert.equal(await copied(page), "#483 needs a rebase too.");
    await page.close();
  }),
);
