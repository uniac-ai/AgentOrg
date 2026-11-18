// An agent's message as bubbles, in a real browser over the stand-in gateway: split at its blank
// lines, each filled as the person's own bubble is, with one Copy for the whole message.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { bubblesOf } from "../src/fixed/bubbles.ts";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { chunksOf, type Moment, researchSays, SAID } from "./design/samples.ts";

withBrowser();

/**
 * Research's conversation at one of the design's moments: on Chat, or in the floating chat. What
 * Copy puts on the clipboard is kept, to be read.
 */
async function conversation(
  gateway: Gateway,
  moment: Moment,
  where: "chat" | "floating" = "chat",
  width = 1440,
): Promise<{ page: Page; thread: Locator }> {
  researchSays(gateway, moment);
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
  let thread: Locator;
  if (where === "chat") {
    await page.goto(`${gateway.url}/#/chat/a-research`);
    thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  } else {
    await page.goto(`${gateway.url}/#/a/a-research`);
    await page.getByRole("button", { name: /^Chats/ }).click();
    thread = page.getByRole("complementary", { name: "Chats" });
    await thread
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Research" })
      .click();
  }
  await thread.locator(".whitespace-pre-wrap").first().waitFor();
  // The pointer away from what is said.
  await page.mouse.move(1, 1);
  return { page, thread };
}
/**
 * Each of the agent's messages, read at one moment: its bubbles, each with its kind, its words, its
 * box and its look; its Copy's box; and the width of the conversation it is in.
 */
const messages = (thread: Locator) =>
  thread.evaluate((root) => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const look = (e: Element) => {
      const s = getComputedStyle(e);
      return {
        fill: s.backgroundColor,
        corners: s.borderTopLeftRadius,
        inside: `${s.paddingLeft} ${s.paddingTop}`,
        type: s.fontSize,
      };
    };
    const person = root.querySelector('[data-variant="secondary"] [data-slot="bubble-content"]');
    return {
      person: person ? { ...look(person), ...box(person) } : undefined,
      agent: [...root.querySelectorAll('[data-slot="message"]')]
        .filter((message) => message.querySelector(".prose-chat"))
        .map((message) => ({
          width: box(message).width,
          left: box(message).left,
          bubbles: [...message.querySelectorAll('[data-slot="bubble"]')].map((bubble) => {
            const content = bubble.querySelector('[data-slot="bubble-content"]') as Element;
            return {
              kind: bubble.getAttribute("data-variant"),
              words: (bubble.textContent ?? "").trim(),
              buttons: [...bubble.querySelectorAll("button")].map((b) =>
                b.getAttribute("aria-label"),
              ),
              ...box(bubble),
              ...look(content),
            };
          }),
          copy: (() => {
            const copy = message.querySelector('button[aria-label="Copy"]');
            return copy && { ...box(copy), seen: getComputedStyle(copy).visibility === "visible" };
          })(),
        })),
      page: [innerWidth, document.documentElement.scrollWidth],
    };
  });

test(
  "a one-line answer is one bubble, and the long reply has its five: the first line, two paragraphs, the list with its line, the line after, and the code",
  withGateway(async (gateway) => {
    let { page, thread } = await conversation(gateway, "oneLine");
    await thread.locator(".prose-chat").first().waitFor();
    let said = await messages(thread);
    assert.deepEqual(
      said.agent.at(-1)?.bubbles.map((b) => [b.kind, b.words]),
      [["muted", SAID.oneLine]],
    );
    await page.close();
    ({ page, thread } = await conversation(gateway, "long"));
    await thread.locator(".prose-chat").first().waitFor();
    said = await messages(thread);
    assert.deepEqual(
      said.agent.at(-1)?.bubbles.map((b) => [b.kind, b.words.slice(0, 24)]),
      [
        ["muted", "It's a small shop demo: "],
        ["muted", "The README is about 300 "],
        ["muted", "The code is in three fol"],
        ["muted", "To run it, the README gi"],
        ["ghost", "shnpm install && npm run"],
      ],
    );
    await page.close();
  }),
);

test(
  "each bubble is filled with the person's bubble's grey, in dark and in light, with the person's corners, padding and type; no bubble is wider than 80% of the conversation, and the code keeps its whole width with its Copy and Download",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "long");
    await thread.locator(".prose-chat").first().waitFor();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const said = await messages(thread);
      const reply = said.agent.at(-1);
      assert.ok(reply && said.person);
      const words = reply.bubbles.filter((b) => b.kind === "muted");
      const [code] = reply.bubbles.filter((b) => b.kind === "ghost");
      assert.equal(words.length, 4);
      for (const bubble of words) {
        assert.deepEqual(
          [bubble.fill, bubble.corners, bubble.inside, bubble.type],
          [said.person.fill, said.person.corners, said.person.inside, said.person.type],
          `${theme}: as the person's (${bubble.words.slice(0, 20)})`,
        );
        assert.ok(
          bubble.width <= reply.width * 0.8 + 0.5,
          `at most 80%: ${bubble.width} of ${reply.width}`,
        );
      }
      assert.deepEqual(
        [said.person.corners, said.person.inside, said.person.type],
        ["24px", "16px 8px", "15px"],
      );
      assert.ok(code);
      assert.equal(
        Math.round(code.width),
        Math.round(reply.width),
        "the code keeps the whole width",
      );
      assert.equal(code.fill, "rgba(0, 0, 0, 0)", "with no fill");
      assert.deepEqual(code.buttons, ["Download file", "Copy Code"]);
    }
    await page.close();
  }),
);

test(
  "4 px between a message's bubbles, the larger gap before the next message, and one Copy under the last bubble that copies the whole message as written",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "result");
    await thread.locator(".prose-chat").nth(1).waitFor();
    await thread.getByRole("button", { name: "Copy" }).last().waitFor();
    const said = await messages(thread);
    const [receipt, result] = said.agent.slice(-2);
    assert.ok(receipt && result?.copy);
    const [first, second] = result.bubbles;
    assert.ok(first && second);
    assert.equal(Math.round(second.top - first.bottom), 4, "4 px between its bubbles");
    const before = receipt.bubbles.at(-1);
    assert.ok(before);
    assert.equal(Math.round(first.top - before.bottom), 56, "the gap before the next message");
    assert.ok(result.copy.seen && result.copy.top >= second.bottom, "Copy under the last bubble");
    assert.equal(Math.round(result.copy.left), Math.round(result.left), "at the start side");
    assert.equal(receipt.bubbles.length, 1);
    await thread.getByRole("button", { name: "Copy" }).last().click();
    assert.equal(
      await page.evaluate(() => (globalThis as { copied?: string }).copied),
      SAID.result,
      "the whole message, as written",
    );
    await page.close();
  }),
);

test(
  "a reply being written: nothing shows before its first word, then its bubbles appear one at a time, and those before the last are the same elements throughout",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "writing");
    assert.equal(await thread.locator(".prose-chat").count(), 0, "nothing before the first word");
    const chunks = chunksOf(SAID.long);
    /** The bubbles drawn now, each marked with the place it was first seen at. */
    const seen = () =>
      thread.evaluate((root) =>
        [...root.querySelectorAll('[data-slot="bubble"]:not([data-variant="secondary"])')].map(
          (bubble, n) => {
            const kept = bubble as HTMLElement & { first?: number };
            kept.first ??= n;
            return kept.first;
          },
        ),
      );
    let written = "";
    let was: number[] = [];
    for (let i = 0; i < chunks.length; i += 3) {
      const piece = chunks.slice(i, i + 3).join("");
      written += piece;
      gateway.delta("a-research", "v-a2", piece);
      const expected = bubblesOf(written).length;
      for (let tries = 0; (await seen()).length !== expected; tries++)
        assert.ok(tries < 200, `${expected} bubbles once "${written.slice(-20)}" has come`);
      const now = await seen();
      assert.ok(now.length - was.length <= 1, `one at a time: ${was.length} → ${now.length}`);
      assert.deepEqual(now, [...now.keys()], "each the element it was");
      was = now;
    }
    gateway.addMessage("a-research", {
      id: "v-a2",
      role: "assistant",
      text: SAID.long,
      at: new Date().toISOString(),
    });
    gateway.setChatStatus("a-research", { state: "idle" });
    await thread.getByRole("button", { name: "Copy" }).waitFor();
    assert.deepEqual(await seen(), [0, 1, 2, 3, 4], "recorded, the same five");
    await page.close();
  }),
);

test(
  "the person's own message stays one bubble, with its lines kept",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "writing");
    gateway.addMessage("a-research", {
      id: "u-two",
      role: "user",
      text: "First, the README.\n\nThen the tests.",
      at: new Date().toISOString(),
    });
    const mine = thread.locator(".whitespace-pre-wrap", { hasText: "Then the tests." });
    await mine.waitFor();
    assert.equal(await mine.count(), 1);
    assert.equal(await mine.textContent(), "First, the README.\n\nThen the tests.");
    await page.close();
  }),
);

test(
  "the same in the floating chat, and on a phone nothing is wider than the conversation and nothing scrolls sideways",
  withGateway(async (gateway) => {
    let { page, thread } = await conversation(gateway, "long", "floating");
    await thread.locator(".prose-chat").first().waitFor();
    let said = await messages(thread);
    assert.deepEqual(
      said.agent.at(-1)?.bubbles.map((b) => b.kind),
      ["muted", "muted", "muted", "muted", "ghost"],
    );
    await page.close();
    ({ page, thread } = await conversation(gateway, "long", "chat", 390));
    await thread.locator(".prose-chat").first().waitFor();
    said = await messages(thread);
    const reply = said.agent.at(-1);
    assert.ok(reply);
    assert.equal(reply.bubbles.length, 5);
    for (const bubble of reply.bubbles)
      assert.ok(
        bubble.left >= reply.left - 0.5 && bubble.right <= reply.left + reply.width + 0.5,
        `within the conversation: ${bubble.words.slice(0, 20)}`,
      );
    const [has, needs] = said.page;
    assert.ok(needs !== undefined && has !== undefined && needs <= has, "nothing sideways");
    await page.close();
  }),
);
