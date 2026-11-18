// Each of an agent's messages on its own, in a real browser over the stand-in gateway: its own
// words, its own Copy, and the same gap before the next as between any two messages.
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
 * The agent's messages, read at one moment once each Copy has settled: each one's words, whether
 * its Copy is seen, and its box; and the box of the person's last message above them.
 */
const said = (thread: Locator) =>
  thread.evaluate(async (root) => {
    // Once each Copy has finished showing or going.
    await Promise.all(
      [...root.querySelectorAll('button[aria-label="Copy"]')].flatMap((copy) =>
        copy.getAnimations().map((one) => one.finished),
      ),
    );
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
        .map((item) => {
          const copy = item.querySelector('button[aria-label="Copy"]');
          return {
            text: (item.querySelector(".prose-chat")?.textContent ?? "").trim(),
            copy: !!copy && getComputedStyle(copy).visibility === "visible",
            ...box(item),
          };
        }),
    };
  });
/** The agent's message with these words, by its place in the thread. */
const message = (thread: Locator, text: string) =>
  thread.locator('[data-slot="message-scroller-item"]').filter({ hasText: text });
/** What the last Copy pressed put on the clipboard. */
const copied = (page: Page) => page.evaluate(() => (globalThis as { copied?: string }).copied);

/**
 * A receipt, then its result: two messages, each with its own Copy that copies its words alone,
 * the earlier one's seen only under the pointer, and the gap between them any two messages' gap.
 */
async function receiptThenResult(gateway: Gateway, page: Page, thread: Locator) {
  await ask(gateway, thread, "Is #482 ready to merge?");
  gateway.addMessage("a-reviewer", reply("r-receipt", "Looking at #482 now."));
  await message(thread, "Looking at #482 now.").waitFor();
  // While the result is being written, its Copy isn't offered.
  gateway.delta("a-reviewer", "r-result", "It is ready: ");
  await message(thread, "It is ready:").waitFor();
  let now = await said(thread);
  assert.deepEqual(
    now.agent.slice(-2).map(({ text, copy }) => [text, copy]),
    [
      ["Looking at #482 now.", false],
      ["It is ready:", false],
    ],
  );
  gateway.addMessage("a-reviewer", reply("r-result", "It is ready: the tests pass."));
  gateway.setChatStatus("a-reviewer", { state: "idle" });
  await message(thread, "the tests pass.").getByRole("button", { name: "Copy" }).waitFor();
  now = await said(thread);
  const [receipt, result] = now.agent.slice(-2);
  assert.ok(receipt && result && now.asked);
  assert.deepEqual(
    [
      [receipt.text, receipt.copy],
      [result.text, result.copy],
    ],
    [
      ["Looking at #482 now.", false],
      ["It is ready: the tests pass.", true],
    ],
    "two messages; the latest's Copy is seen once it is done",
  );
  assert.equal(
    Math.round(result.top - receipt.bottom),
    Math.round(receipt.top - now.asked.bottom),
    "the gap between them is any two messages' gap",
  );
  await message(thread, "the tests pass.").getByRole("button", { name: "Copy" }).click();
  assert.equal(await copied(page), "It is ready: the tests pass.");
  // The earlier one's Copy is seen while the pointer is on it, and copies its own words.
  await message(thread, "Looking at #482 now.").hover();
  await message(thread, "Looking at #482 now.").getByRole("button", { name: "Copy" }).click();
  assert.equal(await copied(page), "Looking at #482 now.");
}

test(
  "a receipt and its result are two messages, each with its own Copy that copies it alone; the earlier one's is seen under the pointer, the latest one's once it is done",
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
    gateway.delta("a-reviewer", "r1", "Three causes ");
    await thread.locator("[data-sd-animate]").first().waitFor();
    gateway.delta("a-reviewer", "r1", "explain it.");
    await message(thread, "explain it.").waitFor();
    await message(thread, "explain it.").evaluate((e) => {
      (e as HTMLElement & { kept?: true }).kept = true;
    });
    gateway.addMessage("a-reviewer", reply("r1", "Three causes explain it."));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await message(thread, "Three causes explain it.")
      .getByRole("button", { name: "Copy" })
      .waitFor();
    await thread.locator("[data-sd-animate]").waitFor({ state: "detached" });
    // Its words: what Copy does as it appears is Copy's own.
    const after = await message(thread, "Three causes explain it.").evaluate((e) => ({
      kept: !!(e as HTMLElement & { kept?: true }).kept,
      moving: (e.querySelector(".prose-chat") as Element)
        .getAnimations({ subtree: true })
        .filter((one) => one.playState === "running").length,
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
  "a message nobody asked for, after a result, is a third message with its own Copy",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "floating");
    await receiptThenResult(gateway, page, thread);
    await page.mouse.move(1, 1);
    gateway.addMessage("a-reviewer", reply("r-later", "#483 needs a rebase too."));
    await message(thread, "#483 needs a rebase too.")
      .getByRole("button", { name: "Copy" })
      .waitFor();
    const now = await said(thread);
    assert.deepEqual(
      now.agent.slice(-3).map(({ text, copy }) => [text, copy]),
      [
        ["Looking at #482 now.", false],
        ["It is ready: the tests pass.", false],
        ["#483 needs a rebase too.", true],
      ],
    );
    await message(thread, "#483 needs a rebase too.").getByRole("button", { name: "Copy" }).click();
    assert.equal(await copied(page), "#483 needs a rebase too.");
    await page.close();
  }),
);
