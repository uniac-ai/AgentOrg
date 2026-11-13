// A picture from the person: put in a chat's box by its button or by pasting, sent with the words,
// and shown above them in the message. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
/** A small PNG, as one is sent. */
const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_DATA, "base64");
/** A picture far over what a message carries: a 1200 by 800 BMP, grey or of noise. */
function bigBmp(noise = false) {
  const [width, height] = [1200, 800];
  const row = width * 3;
  const data = noise ? randomBytes(row * height) : Buffer.alloc(row * height, 0x7f);
  const head = Buffer.alloc(54);
  head.write("BM", 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

async function open(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-reviewer`);
  await page.getByRole("button", { name: /^Chats/ }).click();
  await panel(page)
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: "Reviewer" })
    .click();
  await input(page).waitFor();
  return page;
}
const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });
const input = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
const box = (page: Page) => panel(page).locator('[data-slot="input-group"]');
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};

test(
  "a picture picked with the box's button sits above the words, can be taken out, and goes with the message, above its words",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const files = panel(page).getByLabel("Pictures to attach");
    await files.setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    const thumb = box(page).getByRole("img", { name: "Picture 1" });
    await thumb.waitFor();
    assert.ok(
      ((await thumb.boundingBox())?.y ?? 0) < ((await input(page).boundingBox())?.y ?? 0),
      "above the words",
    );
    // Its way out shows when it is pointed at.
    const out = box(page).getByRole("button", { name: "Remove picture 1" });
    await page.mouse.move(5, 5);
    assert.equal(await out.evaluate((e) => getComputedStyle(e).opacity), "0");
    await thumb.hover();
    await out.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
    assert.equal(await out.evaluate((e) => getComputedStyle(e).opacity), "1");
    await out.click();
    await thumb.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Message",
      "back at the words",
    );
    // Put in again, with words, and sent.
    await files.setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await thumb.waitFor();
    await input(page).fill("This is what the coupon does.");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await thumb.waitFor({ state: "detached" });
    const sent = gateway.calls.find((c) => c.method === "send")?.input as {
      text: string;
      images?: { mediaType: string; data: string }[];
    };
    assert.equal(sent.text, "This is what the coupon does.");
    assert.deepEqual(sent.images, [{ mediaType: "image/png", data: PNG_DATA }]);
    const shown = panel(page).getByRole("log").getByRole("img", { name: "Picture 1" });
    await shown.waitFor();
    const words = panel(page).locator(".whitespace-pre-wrap", {
      hasText: "This is what the coupon does.",
    });
    assert.ok(((await shown.boundingBox())?.y ?? 0) < ((await words.boundingBox())?.y ?? 0));
    await page.close();
  }),
);

test(
  "a picture pasted into the box is put there, and one too large to send is made smaller to fit",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).focus();
    // Words copied with a picture of them, as from a sheet, go in as words.
    assert.equal(
      await page.evaluate((png) => {
        const files = new DataTransfer();
        files.setData("text/plain", "Orders\t4%");
        files.items.add(
          new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "cells.png", {
            type: "image/png",
          }),
        );
        return document
          .querySelector('textarea[aria-label="Message"]')
          ?.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: files, bubbles: true, cancelable: true }),
          );
      }, PNG_DATA),
      true,
      "the words are pasted",
    );
    await page.evaluate(
      async ([png = "", bmp = ""]) => {
        const box = document.querySelector('textarea[aria-label="Message"]');
        const files = new DataTransfer();
        files.items.add(
          new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "a.png", {
            type: "image/png",
          }),
        );
        files.items.add(
          new File([Uint8Array.from(atob(bmp), (c) => c.charCodeAt(0))], "b.bmp", {
            type: "image/bmp",
          }),
        );
        box?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: files, bubbles: true }));
      },
      [PNG_DATA, bigBmp().toString("base64")],
    );
    await box(page).getByRole("img", { name: "Picture 2" }).waitFor();
    assert.equal(await input(page).inputValue(), "", "nothing pasted as words");
    await input(page).fill("Two of them.");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await panel(page).getByRole("log").getByRole("img", { name: "Picture 2" }).waitFor();
    const sent = gateway.calls.find((c) => c.method === "send")?.input as {
      images: { mediaType: string; data: string }[];
    };
    assert.equal(sent.images.length, 2);
    assert.equal(sent.images[0]?.mediaType, "image/png");
    assert.equal(sent.images[1]?.mediaType, "image/jpeg", "drawn smaller");
    assert.ok((sent.images[1]?.data.length ?? 0) <= 500_000);
    await page.close();
  }),
);

test(
  "a picture can be sent with no words: alone in the message, and named in its chat's row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const send = panel(page).getByRole("button", { name: "Send", exact: true });
    assert.equal(await send.isDisabled(), true, "nothing to send yet");
    await panel(page).getByLabel("Pictures to attach").setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await box(page).getByRole("img", { name: "Picture 1" }).waitFor();
    await send.click();
    const sent = panel(page).getByRole("log").getByRole("img", { name: "Picture 1" });
    await sent.waitFor();
    const input = gateway.calls.find((c) => c.method === "send")?.input as {
      text?: string;
      images?: unknown[];
    };
    assert.equal(input.text?.trim() ?? "", "");
    assert.equal(input.images?.length, 1);
    // No words under it: the picture is the message.
    const message = sent.locator("xpath=ancestor::*[@data-slot='message-scroller-item'][1]");
    assert.equal((await message.innerText()).trim(), "");
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page).getByRole("list", { name: "Chats" }).getByText("You: Picture").waitFor();
    await page.close();
  }),
);

test(
  "a message of pictures with no words is named in its chat's row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.addMessage("a-reviewer", {
      id: "u-pictures",
      role: "user",
      text: "",
      at: new Date().toISOString(),
      images: [
        { mediaType: "image/png", data: PNG_DATA },
        { mediaType: "image/png", data: PNG_DATA },
      ],
    });
    await panel(page).getByRole("log").getByRole("img", { name: "Picture 2" }).waitFor();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page).getByRole("list", { name: "Chats" }).getByText("You: 2 pictures").waitFor();
    await page.close();
  }),
);

test(
  "pictures sent together fit within what one picture carries, and at most eight are put in",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const files = panel(page).getByLabel("Pictures to attach");
    const noise = bigBmp(true);
    await files.setInputFiles([
      { name: "a.bmp", mimeType: "image/bmp", buffer: noise },
      { name: "b.bmp", mimeType: "image/bmp", buffer: noise },
    ]);
    await box(page).getByRole("img", { name: "Picture 2" }).waitFor({ timeout: 20_000 });
    await input(page).fill("Both of them.");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await panel(page).getByRole("log").getByRole("img", { name: "Picture 2" }).waitFor();
    const sent = gateway.calls.find((c) => c.method === "send")?.input as {
      images: { mediaType: string; data: string }[];
    };
    assert.equal(sent.images.length, 2);
    const sizes = sent.images.map((one) => one.data.length);
    assert.ok(Math.min(...sizes) > 0);
    const all = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(all <= 500_000, `together ${all}`);
    // Nine picked, eight are put in.
    await files.setInputFiles(
      Array.from({ length: 9 }, (_, n) => ({
        name: `${n}.png`,
        mimeType: "image/png",
        buffer: PNG,
      })),
    );
    await box(page).getByRole("img", { name: "Picture 8" }).waitFor();
    assert.equal(await box(page).getByRole("img").count(), 8);
    await page.close();
  }),
);

test(
  "a box's pictures stay with its chat, and come back with the words when a send is refused",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await panel(page).getByLabel("Pictures to attach").setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    const thumb = box(page).getByRole("img", { name: "Picture 1" });
    await thumb.waitFor();
    // Another chat's box has none; back, this one has it still.
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasNotText: "Reviewer" })
      .first()
      .click();
    await input(page).waitFor();
    assert.equal(await box(page).getByRole("img").count(), 0);
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page)
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .click();
    await thumb.waitFor();
    // Refused, the words and the picture are back in the box.
    gateway.refuseNext("chat.send", "busy", "A turn is running.");
    await input(page).fill("refuse this");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await panel(page).getByRole("alert").getByText("A turn is running.").waitFor();
    assert.equal(await input(page).inputValue(), "refuse this");
    await thumb.waitFor();
    await page.close();
  }),
);
