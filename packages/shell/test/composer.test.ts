// The box a message is written in, in a real browser over the stand-in gateway: one line when it is
// empty, the plus at its left and Send at its right; taller a line at a time, up from its foot, as
// the words need, with the two buttons on the last line; and back to one line.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { sampleChats } from "./design/samples.ts";

withBrowser();

type Where = "chat" | "floating";
async function open(gateway: Gateway, where: Where = "chat"): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  if (where === "chat") {
    await page.goto(`${gateway.url}/#/chat`);
    await scope(page, where).getByRole("button").filter({ hasText: "Reviewer" }).first().click();
    await scope(page, where).getByRole("region", { name: "Conversation with Reviewer" }).waitFor();
  } else {
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page.getByRole("button", { name: /^Chats/ }).click();
    await scope(page, where)
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .click();
  }
  await words(page, where).waitFor();
  return page;
}
const scope = (page: Page, where: Where) =>
  where === "chat" ? page.getByRole("main") : page.getByRole("complementary", { name: "Chats" });
const words = (page: Page, where: Where = "chat") =>
  scope(page, where).getByRole("textbox", { name: "Message" });

/** The box, its words and its two buttons, as drawn now. */
const parts = (page: Page, where: Where = "chat") =>
  words(page, where).evaluate((text) => {
    const box = text.closest('[data-slot="input-group"]') as HTMLElement;
    const rect = (one: Element | null) => {
      const { x, y, width, height, bottom } = (one as Element).getBoundingClientRect();
      return { x, y, width, height, bottom, middle: y + height / 2 };
    };
    return {
      box: rect(box),
      words: rect(text),
      plus: rect(box.querySelector('[aria-label="Attach a picture"]')),
      send: rect(box.querySelector('[aria-label="Send"]')),
      scrolls: text.scrollHeight > text.clientHeight,
    };
  });

for (const where of ["chat", "floating"] as const)
  test(
    `empty, the box is one line 48 tall, the plus at its left, the words and Send at its right all on it (${where})`,
    withGateway(async (gateway) => {
      sampleChats(gateway);
      const page = await open(gateway, where);
      const now = await parts(page, where);
      assert.equal(now.box.height, 48);
      assert.equal(now.words.height, 48);
      for (const button of [now.plus, now.send]) {
        assert.equal(button.height, 32);
        assert.equal(button.middle, now.box.middle, "on the line");
      }
      assert.ok(now.plus.x < now.words.x && now.words.x + now.words.width <= now.send.x);
      assert.equal(now.plus.x - now.box.x, 8);
      assert.equal(now.box.x + now.box.width - (now.send.x + now.send.width), 8);
      assert.equal(await words(page, where).getAttribute("placeholder"), "Message Reviewer");
      assert.equal(
        await scope(page, where).getByRole("button", { name: "Send" }).isDisabled(),
        true,
      );
      const look = await words(page, where).evaluate((text) => {
        const style = getComputedStyle(text);
        const box = getComputedStyle(text.closest('[data-slot="input-group"]') as Element);
        return { size: style.fontSize, line: style.lineHeight, corners: box.borderRadius };
      });
      assert.deepEqual(look, { size: "15px", line: "24px", corners: "24px" });
      await page.close();
    }),
  );

test(
  "each new line makes the box 24 taller up from its foot, the buttons staying on the last line; at two fifths of the window it scrolls; emptied, it is one line again",
  withGateway(async (gateway) => {
    sampleChats(gateway);
    const page = await open(gateway);
    const first = await parts(page);
    await words(page).click();
    await page.keyboard.type("A first line");
    let was = await parts(page);
    assert.equal(was.box.height, 48, "one line typed is still one line");
    for (let line = 2; line <= 20; line++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`Line ${line}`);
      const now = await parts(page);
      assert.equal(now.box.bottom, first.box.bottom, "its foot stays");
      assert.ok(now.box.y <= was.box.y, "its top only goes up");
      assert.equal(now.box.height, Math.min(48 + 24 * (line - 1), 360), `at line ${line}`);
      for (const button of [now.plus, now.send])
        assert.equal(now.box.bottom - button.bottom, 8, "on the last line");
      assert.equal(now.words.width, first.words.width, "the words have the width between them");
      assert.equal(now.scrolls, 48 + 24 * (line - 1) > 360);
      was = now;
    }
    // 360 is two fifths of the 900 window.
    assert.equal(was.box.height, 360);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    assert.deepEqual((await parts(page)).box, first.box);
    await page.close();
  }),
);

test(
  "words that wrap grow the box in the frame they wrap in: no frame has the buttons off the last line, nor a height between lines",
  withGateway(async (gateway) => {
    sampleChats(gateway);
    const page = await open(gateway, "floating");
    // Every size the box is laid out at, with where its buttons are then, before it is drawn.
    await words(page, "floating").evaluate((text) => {
      const box = text.closest('[data-slot="input-group"]') as HTMLElement;
      const seen: { height: number; plus: number; send: number }[] = [];
      (window as unknown as { seen: typeof seen }).seen = seen;
      new ResizeObserver(() => {
        const foot = box.getBoundingClientRect().bottom;
        const gap = (label: string) =>
          foot -
          (box.querySelector(`[aria-label="${label}"]`) as Element).getBoundingClientRect().bottom;
        seen.push({
          height: box.getBoundingClientRect().height,
          plus: gap("Attach a picture"),
          send: gap("Send"),
        });
      }).observe(box);
    });
    await words(page, "floating").click();
    await page.keyboard.type(
      "The coupon is applied before the cart is priced, so a percentage coupon is taken off zero, and the order total is wrong.",
    );
    const seen = await page.evaluate(
      () => (window as unknown as { seen: { height: number; plus: number; send: number }[] }).seen,
    );
    const heights = seen.map((one) => one.height);
    assert.ok(heights.length >= 3, `it wrapped at least twice: ${heights.join(", ")}`);
    heights.reduce((before, height) => {
      assert.ok(height >= before, "it only grows while words are added");
      assert.equal((height - 48) % 24, 0, `a whole number of lines: ${height}`);
      return height;
    });
    for (const one of seen) assert.deepEqual([one.plus, one.send], [8, 8]);
    await page.close();
  }),
);

test(
  "as the box grows, a long conversation's latest message stays clear of it, 16 above the room's foot, in every frame",
  withGateway(async (gateway) => {
    sampleChats(gateway, "long");
    const page = await open(gateway);
    const messages = page.getByRole("main").getByRole("region", { name: "Messages" });
    await messages.getByText(/^Three comments on #482/).waitFor();
    // How far the latest message is above the room's foot each time the box is laid out at a new
    // height, read after layout and before the frame is drawn, to the whole pixel.
    await messages.evaluate((room) => {
      const clear: number[] = [];
      (window as unknown as { clear: number[] }).clear = clear;
      const box = document.querySelector('main [data-slot="input-group"]') as Element;
      new ResizeObserver(() => {
        const items = room.querySelectorAll('[data-slot="message-scroller-item"]');
        const last = items[items.length - 1] as Element;
        clear.push(
          Math.round(room.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom),
        );
      }).observe(box);
    });
    await words(page).click();
    await page.keyboard.type("One");
    for (let line = 2; line <= 16; line++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`Line ${line}`);
    }
    const clear = await page.evaluate(() => (window as unknown as { clear: number[] }).clear);
    // Once as it is observed, then in each frame it was taller in: lines typed within one frame
    // are laid out together.
    assert.ok(clear.length >= 4, `laid out at ${clear.length} heights`);
    assert.deepEqual(
      clear,
      clear.map(() => 16),
    );
    await page.close();
  }),
);
