// An agent's message's menu and the room between messages, in a real browser over the stand-in
// gateway: no Copy under a message; a "⋯" beside each of its bubbles with words, "More" after a
// second, opening Copy with when it was sent; a long press on a phone; none on a code block or on
// the person's own; and 4 px between two of one side's, 16 px where the side changes.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { type Moment, researchSays, researchTypes, SAID, SECOND_ASK } from "./design/samples.ts";

withBrowser();

/** Research's conversation on Chat, as it now stands. What Copy puts on the clipboard is kept. */
async function conversation(
  gateway: Gateway,
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
  await page.goto(`${gateway.url}/#/chat/a-research`);
  const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Research" });
  await thread.locator('[data-slot="bubble"]').first().waitFor();
  await page.mouse.move(1, 1);
  return { page, thread };
}
const at = (gateway: Gateway, moment: Moment, width?: number) => {
  researchSays(gateway, moment);
  return conversation(gateway, width);
};
/** The agent's bubble holding these words. */
const bubble = (thread: Locator, words: string) =>
  thread.locator('[data-slot="bubble"]:not([data-variant="secondary"])').filter({ hasText: words });
/** Words of the result's last bubble. */
const LAST_WORDS = SAID.result.split("\n\n").at(-1)?.slice(0, 20) ?? "";
const more = (of: Locator) => of.getByRole("button", { name: "More" });
const copied = (page: Page) => page.evaluate(() => (globalThis as { copied?: string }).copied);
/** Once what the element shows or hides has finished moving. */
const settled = (of: Locator) =>
  of.evaluate((e) => Promise.all(e.getAnimations().map((one) => one.finished)));
/** The page's own clock, for a while. */
const pageWaits = (page: Page, ms: number) =>
  page.evaluate((wait) => new Promise((done) => setTimeout(done, wait)), ms);

test(
  "no Copy is under an agent's message, and nothing is drawn under its last bubble",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result");
    await bubble(thread, LAST_WORDS).waitFor();
    assert.equal(await thread.getByRole("button", { name: "Copy" }).count(), 0);
    const [message, last] = await thread.evaluate((root) => {
      const item = [...root.querySelectorAll('[data-slot="message-scroller-item"]')].at(-1);
      return [
        item?.getBoundingClientRect().bottom,
        [...(item?.querySelectorAll('[data-slot="bubble"]') ?? [])].at(-1)?.getBoundingClientRect()
          .bottom,
      ];
    });
    assert.equal(message, last);
    await page.close();
  }),
);

test(
  'pointed at, a bubble shows its "⋯" at its outer side, centred on it; pointed at for a second, the "⋯" says "More"',
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result");
    const said = bubble(thread, SAID.receipt);
    const dots = more(said);
    await dots.waitFor();
    await settled(dots);
    assert.equal(await dots.evaluate((e) => getComputedStyle(e).opacity), "0", "hidden at first");
    await said.hover();
    await settled(dots);
    const seen = await said.evaluate((root) => {
      const b = root.getBoundingClientRect();
      const d = (
        root.querySelector('button[aria-label="More"]') as Element
      ).getBoundingClientRect();
      return {
        opacity: getComputedStyle(root.querySelector('button[aria-label="More"]') as Element)
          .opacity,
        outside: d.left >= b.right,
        centred: Math.round(d.top + d.height / 2) === Math.round(b.top + b.height / 2),
      };
    });
    assert.deepEqual(seen, { opacity: "1", outside: true, centred: true });
    const from = Date.now();
    await dots.hover();
    await page.getByRole("tooltip", { name: "More" }).waitFor();
    assert.ok(Date.now() - from >= 900, `"More" after a second, not ${Date.now() - from} ms`);
    await page.close();
  }),
);

test(
  'pressed, the "⋯" opens Copy, which copies the whole message, with when it was sent under it; once it closes, "More" stays away',
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result");
    const said = bubble(thread, SAID.receipt);
    await said.hover();
    await more(said).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    // Copy, and under it when the message was sent, as the chat list says it.
    assert.deepEqual(
      await menu.evaluate((root) =>
        [...root.children].map((one) => [one.getAttribute("role"), one.textContent?.trim()]),
      ),
      [
        ["menuitem", "Copy"],
        [null, "5 min"],
      ],
    );
    await menu.getByRole("menuitem", { name: "Copy" }).click();
    assert.equal(await copied(page), SAID.receipt);
    await menu.waitFor({ state: "detached" });
    // The result has two bubbles: either one's copies all of it.
    const second = bubble(thread, LAST_WORDS);
    await second.hover();
    await more(second).click();
    await page.getByRole("menuitem", { name: "Copy" }).click();
    assert.equal(await copied(page), SAID.result);
    // The pointer still on the "⋯", nothing opens as the menu gives the focus back.
    await pageWaits(page, 1300);
    assert.equal(await page.getByRole("tooltip").count(), 0);
    await page.close();
  }),
);

test(
  "on a phone, a long press on a bubble opens the same menu; a short one doesn't",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "result", 390);
    const said = bubble(thread, SAID.receipt);
    await more(said).waitFor();
    const box = await said.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await pageWaits(page, 700);
    assert.equal(await page.getByRole("menu").count(), 0, "a short press opens nothing");
    await page.mouse.down();
    await pageWaits(page, 200);
    assert.equal(await page.getByRole("menu").count(), 0, "not before half a second");
    await page.getByRole("menu").waitFor();
    await page.mouse.up();
    await page.getByRole("menuitem", { name: "Copy" }).click();
    assert.equal(await copied(page), SAID.receipt);
    await page.close();
  }),
);

test(
  "a code block keeps its own Copy and has no \"⋯\"; the person's bubbles have none; each of the agent's with words has one",
  withGateway(async (gateway) => {
    const { page, thread } = await at(gateway, "long");
    await more(thread).first().waitFor();
    const seen = await thread.evaluate((root) =>
      [...root.querySelectorAll('[data-slot="bubble"]')].map((one) => [
        one.getAttribute("data-variant"),
        !!one.querySelector('button[aria-label="More"]'),
      ]),
    );
    assert.deepEqual(seen, [
      ["secondary", false],
      ["muted", true],
      ["muted", true],
      ["muted", true],
      ["muted", true],
      ["muted", true],
      ["ghost", false],
    ]);
    await page.close();
  }),
);

/** The room between each message drawn and the one before it, and before the sign, read in one frame. */
const gaps = (thread: Locator) =>
  thread.evaluate((root) => {
    const items = [...root.querySelectorAll('[data-slot="message-scroller-item"]')];
    const side = (item: Element) =>
      item.querySelector(".typing-dot")
        ? "sign"
        : item.querySelector('[data-variant="secondary"]')
          ? "you"
          : "agent";
    return items.slice(1).map((item, i) => {
      const before = items[i] as Element;
      return `${side(before)}→${side(item)} ${Math.round(item.getBoundingClientRect().top - before.getBoundingClientRect().bottom)}`;
    });
  });
const within = (thread: Locator) =>
  thread.evaluate((root) => {
    const parts = [
      ...(root
        .querySelectorAll('[data-slot="message-scroller-item"]')[2]
        ?.querySelectorAll('[data-slot="bubble"]') ?? []),
    ];
    return parts
      .slice(1)
      .map((one, i) =>
        Math.round(
          one.getBoundingClientRect().top - (parts[i] as Element).getBoundingClientRect().bottom,
        ),
      );
  });

for (const width of [1440, 390])
  test(
    `${width === 1440 ? "wide" : "on a phone"}: 4 px within one side, between one message's bubbles and between two of its messages, and 16 px where the side changes and before the sign`,
    withGateway(async (gateway) => {
      let { page, thread } = await at(gateway, "result", width);
      await bubble(thread, LAST_WORDS).waitFor();
      assert.deepEqual(await gaps(thread), ["you→agent 16", "agent→agent 4"]);
      assert.deepEqual(await within(thread), [4]);
      await page.close();
      researchTypes(gateway, "two");
      ({ page, thread } = await conversation(gateway, width));
      await thread.getByRole("status", { name: "Research is typing" }).waitFor();
      await thread.getByText(SECOND_ASK).waitFor();
      assert.deepEqual(await gaps(thread), ["you→you 4", "you→sign 16"]);
      await page.close();
    }),
  );
