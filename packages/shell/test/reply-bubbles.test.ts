// An agent's message as bubbles, in a real browser over the stand-in gateway: split at its blank
// lines, each filled as the person's own bubble is, each with a menu whose Copy copies the whole
// message.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page, WebSocket } from "@playwright/test";
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
): Promise<{ page: Page; thread: Locator; sockets: WebSocket[] }> {
  researchSays(gateway, moment);
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  // The page's sockets to the gateway: a piece that changes nothing drawn is known to have come
  // by the frame that carries it.
  const sockets: WebSocket[] = [];
  page.on("websocket", (socket) => sockets.push(socket));
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
  return { page, thread, sockets };
}
/** Copies a message as a person does: points at one of its bubbles, presses its "⋯", then Copy. */
async function copyThrough(page: Page, bubble: Locator) {
  await bubble.hover();
  await bubble.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Copy" }).click();
}
/**
 * Each of the agent's messages, read at one moment: its bubbles, each with its kind, its words, its
 * buttons, its box and its look; the bottom of what is drawn for it; and the width of the
 * conversation it is in.
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
        // From the top left, clockwise.
        corners: [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ].join(" "),
        edge: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        inside: `${s.paddingLeft} ${s.paddingTop}`,
        type: s.fontSize,
      };
    };
    // The hairline every line of the page is drawn in, as this theme has it.
    const line = document.createElement("i");
    line.style.border = "1px solid var(--line)";
    root.append(line);
    const hairline = getComputedStyle(line).borderTopColor;
    line.remove();
    const person = root.querySelector('[data-variant="secondary"] [data-slot="bubble-content"]');
    return {
      hairline,
      person: person ? { ...look(person), ...box(person) } : undefined,
      // The person's bubbles, each one's corners.
      mine: [
        ...root.querySelectorAll('[data-variant="secondary"] [data-slot="bubble-content"]'),
      ].map((one) => look(one).corners),
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
          bottom: box(message).bottom,
        })),
      page: [innerWidth, document.documentElement.scrollWidth],
    };
  });

test(
  "a one-line answer is one bubble, and the long reply has its six: the first line, two paragraphs, the line before the list, the list, the line after, and the code",
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
        ["muted", "web: the storefront's pa"],
        ["muted", "To run it, the README gi"],
        ["ghost", "shnpm install && npm run"],
      ],
    );
    await page.close();
  }),
);

test(
  "each bubble is filled with the person's bubble's grey and edged with the page's hairline, in dark and in light, with the person's padding and type; no bubble is wider than 80% of the conversation, and the code keeps its whole width with its Copy and Download",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "long");
    await thread.locator(".prose-chat").first().waitFor();
    const edges: string[] = [];
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const said = await messages(thread);
      const reply = said.agent.at(-1);
      assert.ok(reply && said.person);
      const words = reply.bubbles.filter((b) => b.kind === "muted");
      const [code] = reply.bubbles.filter((b) => b.kind === "ghost");
      assert.equal(words.length, 5);
      for (const bubble of words) {
        assert.deepEqual(
          [bubble.fill, bubble.edge, bubble.inside, bubble.type],
          [said.person.fill, said.person.edge, said.person.inside, said.person.type],
          `${theme}: as the person's (${bubble.words.slice(0, 20)})`,
        );
        assert.ok(
          bubble.width <= reply.width * 0.8 + 0.5,
          `at most 80%: ${bubble.width} of ${reply.width}`,
        );
      }
      assert.deepEqual(
        [said.person.edge, said.person.inside, said.person.type],
        [`1px solid ${said.hairline}`, "16px 8px", "15px"],
      );
      edges.push(said.person.edge);
      assert.ok(code);
      assert.equal(
        Math.round(code.width),
        Math.round(reply.width),
        "the code keeps the whole width",
      );
      assert.equal(code.fill, "rgba(0, 0, 0, 0)", "with no fill");
      assert.deepEqual(code.buttons, ["Download file", "Copy Code"]);
    }
    assert.notEqual(edges[0], edges[1], "each theme's own hairline");
    await page.close();
  }),
);

test(
  "a bubble's corners are 18 px, and 6 px on its own side where it meets what the same side said just above or under it: a message's bubbles, and one side's messages in a row",
  withGateway(async (gateway) => {
    // The agent's receipt and its result of two bubbles, under the person's one message.
    const { page, thread } = await conversation(gateway, "result");
    await thread.locator(".prose-chat").nth(1).waitFor();
    let said = await messages(thread);
    assert.deepEqual(said.mine, ["18px 18px 18px 18px"], "one message alone");
    assert.deepEqual(
      said.agent.flatMap((message) => message.bubbles.map((b) => b.corners)),
      ["18px 18px 18px 6px", "6px 18px 18px 6px", "6px 18px 18px 18px"],
      "the agent's three, at the start side",
    );
    // Then the person's three in a row.
    for (const [n, text] of ["Thanks.", "One more thing.", "Which file has the most?"].entries())
      gateway.addMessage("a-research", {
        id: `u-row-${n}`,
        role: "user",
        text,
        at: new Date().toISOString(),
      });
    await thread.locator(".whitespace-pre-wrap", { hasText: "Which file has the most?" }).waitFor();
    said = await messages(thread);
    assert.deepEqual(
      said.mine.slice(-3),
      ["18px 18px 6px 18px", "18px 6px 6px 18px", "18px 6px 18px 18px"],
      "the person's three, at the end side",
    );
    assert.equal(
      said.agent.at(-1)?.bubbles.at(-1)?.corners,
      "6px 18px 18px 18px",
      "the agent's last is as it was: the side changes under it",
    );
    await page.close();
  }),
);

test(
  "4 px between a message's bubbles and before the agent's next message, nothing under the last bubble, and each bubble's menu copies the whole message as written",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "result");
    await thread.locator(".prose-chat").nth(1).waitFor();
    await thread.getByRole("button", { name: "More" }).last().waitFor();
    const said = await messages(thread);
    const [receipt, result] = said.agent.slice(-2);
    assert.ok(receipt && result);
    const [first, second] = result.bubbles;
    assert.ok(first && second);
    assert.equal(Math.round(second.top - first.bottom), 4, "4 px between its bubbles");
    const before = receipt.bubbles.at(-1);
    assert.ok(before);
    assert.equal(Math.round(first.top - before.bottom), 4, "4 px before the next message");
    assert.equal(Math.round(result.bottom), Math.round(second.bottom), "nothing under the last");
    assert.equal(receipt.bubbles.length, 1);
    for (const bubble of result.bubbles) assert.deepEqual(bubble.buttons, ["More"]);
    await copyThrough(
      page,
      thread.locator('[data-slot="bubble"]').filter({ hasText: second.words }),
    );
    assert.equal(
      await page.evaluate(() => (globalThis as { copied?: string }).copied),
      SAID.result,
      "the whole message, as written",
    );
    await page.close();
  }),
);

test(
  "a reply being written: none of it shows part written; each bubble comes whole once the next has begun, one at a time, the typing sign under them, and each is the same element with the same words to the end",
  withGateway(async (gateway) => {
    const { page, thread } = await conversation(gateway, "writing");
    assert.equal(await thread.locator(".prose-chat").count(), 0, "nothing before the first word");
    const chunks = chunksOf(SAID.long);
    /**
     * The reply's bubbles drawn now, each marked with the place and the words it was first seen
     * with: its place, and whether its words are still those; and whether the sign is under them.
     */
    const seen = () =>
      thread.evaluate((root) => {
        const all = [
          ...root.querySelectorAll('[data-slot="bubble"]:not([data-variant="secondary"])'),
        ];
        const reply = all.filter((bubble) => !bubble.querySelector(".typing-dot"));
        return {
          sign: all.length - reply.length === 1 && all.at(-1)?.querySelector(".typing-dot") != null,
          bubbles: reply.map((bubble, n) => {
            const kept = bubble as HTMLElement & { first?: number; words?: string };
            kept.first ??= n;
            kept.words ??= bubble.textContent ?? "";
            return kept.words === bubble.textContent ? kept.first : -1;
          }),
        };
      });
    let written = "";
    let was: number[] = [];
    for (let i = 0; i < chunks.length; i += 3) {
      const piece = chunks.slice(i, i + 3).join("");
      written += piece;
      gateway.delta("a-research", "v-a2", piece);
      // Every bubble but the one being written.
      const expected = Math.max(bubblesOf(written, true).length - 1, 0);
      for (let tries = 0; (await seen()).bubbles.length !== expected; tries++)
        assert.ok(tries < 200, `${expected} bubbles once "${written.slice(-20)}" has come`);
      const now = await seen();
      assert.ok(now.sign, "the sign is under what has come");
      assert.ok(
        now.bubbles.length - was.length <= 1,
        `one at a time: ${was.length} → ${now.bubbles.length}`,
      );
      assert.deepEqual(
        now.bubbles,
        [...now.bubbles.keys()],
        "each the element and the words it was",
      );
      was = now.bubbles;
    }
    assert.equal(was.length, 5, "the code, the last, isn't drawn while it may still be written");
    gateway.addMessage("a-research", {
      id: "v-a2",
      role: "assistant",
      text: SAID.long,
      at: new Date().toISOString(),
    });
    gateway.setChatStatus("a-research", { state: "idle" });
    await thread.getByRole("button", { name: "More" }).first().waitFor();
    assert.deepEqual(
      await seen(),
      { sign: false, bubbles: [0, 1, 2, 3, 4, 5] },
      "recorded, the same five and the code, and no sign",
    );
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
      ["muted", "muted", "muted", "muted", "muted", "ghost"],
    );
    await page.close();
    ({ page, thread } = await conversation(gateway, "long", "chat", 390));
    await thread.locator(".prose-chat").first().waitFor();
    said = await messages(thread);
    const reply = said.agent.at(-1);
    assert.ok(reply);
    assert.equal(reply.bubbles.length, 6);
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

/**
 * A piece of a reply, sent, and the page past it: the frame that carries it has reached the page,
 * and two frames have been drawn since.
 */
async function piece(page: Page, gateway: Gateway, sockets: WebSocket[], words: string) {
  const sent = JSON.stringify(words);
  const came = Promise.any(
    sockets.map((socket) =>
      socket.waitForEvent("framereceived", {
        predicate: (frame) => typeof frame.payload === "string" && frame.payload.includes(sent),
      }),
    ),
  );
  gateway.delta("a-research", "v-a2", words);
  await came;
  await page.evaluate(async () => {
    for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done));
  });
}
/**
 * The reply's bubbles drawn now, the typing sign aside: each one's words, and whether it is one
 * seen before.
 */
const drawn = (thread: Locator) =>
  thread.evaluate((root) =>
    [...root.querySelectorAll('[data-slot="bubble"]:not([data-variant="secondary"])')]
      .filter((bubble) => !bubble.querySelector(".typing-dot"))
      .map((bubble) => {
        const kept = bubble as HTMLElement & { seen?: true };
        const was = !!kept.seen;
        kept.seen = true;
        return { words: (bubble.textContent ?? "").trim(), was };
      }),
  );

test(
  'a numbered list after a line and a blank line, as it is written: the line is drawn once the list has begun, which its "1" alone doesn\'t say; the list is drawn once the message is whole; and the line stays the same element',
  withGateway(async (gateway) => {
    const { page, thread, sockets } = await conversation(gateway, "writing");
    await piece(page, gateway, sockets, "Here are the steps:\n\n");
    assert.deepEqual(await drawn(thread), [], "the line may still be written");
    await piece(page, gateway, sockets, "1");
    assert.deepEqual(await drawn(thread), [], 'after "1", which may be words or a list');
    await piece(page, gateway, sockets, ".");
    assert.deepEqual(
      await drawn(thread),
      [{ words: "Here are the steps:", was: false }],
      'after ".", the list has begun: the line is whole',
    );
    await piece(page, gateway, sockets, " Install it");
    assert.deepEqual(
      await drawn(thread),
      [{ words: "Here are the steps:", was: true }],
      "the list isn't drawn while it is written",
    );
    gateway.addMessage("a-research", {
      id: "v-a2",
      role: "assistant",
      text: "Here are the steps:\n\n1. Install it",
      at: new Date().toISOString(),
    });
    gateway.setChatStatus("a-research", { state: "idle" });
    await thread.getByRole("button", { name: "More" }).nth(1).waitFor();
    assert.deepEqual(await drawn(thread), [
      { words: "Here are the steps:", was: true },
      { words: "Install it", was: false },
    ]);
    await page.close();
  }),
);

test(
  "a message whose last paragraph is only a number: neither it nor the line above, which it doesn't yet end, is drawn while it is written; both are once it is settled, with its menu as for any message",
  withGateway(async (gateway) => {
    const { page, thread, sockets } = await conversation(gateway, "writing");
    await piece(page, gateway, sockets, "The answer is below.\n\n42");
    assert.deepEqual(await drawn(thread), []);
    gateway.addMessage("a-research", {
      id: "v-a2",
      role: "assistant",
      text: "The answer is below.\n\n42",
      at: new Date().toISOString(),
    });
    gateway.setChatStatus("a-research", { state: "idle" });
    await thread.getByRole("button", { name: "More" }).nth(1).waitFor();
    assert.deepEqual(await drawn(thread), [
      { words: "The answer is below.", was: false },
      { words: "42", was: false },
    ]);
    await copyThrough(page, thread.locator('[data-slot="bubble"]').filter({ hasText: "42" }));
    assert.equal(
      await page.evaluate(() => (globalThis as { copied?: string }).copied),
      "The answer is below.\n\n42",
    );
    await page.close();
  }),
);
