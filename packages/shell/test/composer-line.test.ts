// The box a message is written in, in a real browser over the stand-in gateway: its thin line, a
// little thicker and stronger under the pointer and the same while its words have the keyboard;
// pictures above the words with the line of buttons at its foot; and, signed out, the place that
// stands for it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { sampleChats } from "./design/samples.ts";

withBrowser();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function open(gateway: Gateway, theme = "dark", hash = "#/chat"): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(
    ([session, theme]) => {
      localStorage.setItem("agentorg.session", session as string);
      document.documentElement.dataset.theme = theme as string;
    },
    [SESSION, theme],
  );
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const main = (page: Page) => page.getByRole("main");
const words = (page: Page) => main(page).getByRole("textbox", { name: "Message" });
const box = (page: Page) => main(page).locator('[data-slot="input-group"]');

/** The box's line, once any change of it has run its course; and whether anything is drawn outside it. */
async function line(page: Page, shadow: string) {
  await page.waitForFunction(
    (shadow) =>
      getComputedStyle(document.querySelector('main [data-slot="input-group"]') as Element)
        .boxShadow === shadow,
    shadow,
  );
  return box(page).evaluate((element) => getComputedStyle(element).outlineStyle);
}

for (const [theme, rest, strong] of [
  ["dark", "rgba(255, 255, 255, 0.08)", "rgba(255, 255, 255, 0.14)"],
  ["light", "rgba(0, 0, 0, 0.07)", "rgba(0, 0, 0, 0.14)"],
] as const)
  test(
    `the box's line is 1 px of the card's line at rest, 1.5 px and stronger under the pointer, and the same while its words have the keyboard, with nothing drawn outside it (${theme})`,
    withGateway(async (gateway) => {
      sampleChats(gateway);
      const page = await open(gateway, theme);
      await words(page).waitFor();
      // As the person chose it in Settings, once the page has read what it was.
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await words(page).blur();
      await page.mouse.move(700, 400);
      assert.equal(await line(page, `${rest} 0px 0px 0px 1px inset`), "none");
      const before = await words(page).boundingBox();
      await box(page).hover();
      assert.equal(await line(page, `${strong} 0px 0px 0px 1.5px inset`), "none");
      assert.deepEqual(await words(page).boundingBox(), before, "its width moves nothing");
      await page.mouse.move(700, 400);
      assert.equal(await line(page, `${rest} 0px 0px 0px 1px inset`), "none");
      // With the keyboard and the pointer elsewhere, it is the line it has under the pointer.
      await words(page).focus();
      assert.equal(await line(page, `${strong} 0px 0px 0px 1.5px inset`), "none");
      // Both, it is still that line.
      await box(page).hover();
      assert.equal(await line(page, `${strong} 0px 0px 0px 1.5px inset`), "none");
      // The words themselves draw no ring of their own.
      const own = await words(page).evaluate((text) => {
        const style = getComputedStyle(text);
        return [style.outlineStyle, style.boxShadow, style.borderTopWidth];
      });
      assert.deepEqual(own, ["none", "none", "0px"]);
      await page.close();
    }),
  );

test(
  "pictures sit above the words inside the box, the line of the plus, the words and Send at its foot; with the last taken out it is one line again",
  withGateway(async (gateway) => {
    sampleChats(gateway);
    const page = await open(gateway);
    await words(page).waitFor();
    const empty = await box(page).boundingBox();
    await main(page)
      .getByLabel("Pictures to attach")
      .setInputFiles([
        { name: "a.png", mimeType: "image/png", buffer: PNG },
        { name: "b.png", mimeType: "image/png", buffer: PNG },
      ]);
    await box(page).getByRole("img", { name: "Picture 2" }).waitFor();
    const seen = await words(page).evaluate((text) => {
      const group = text.closest('[data-slot="input-group"]') as Element;
      const rect = (one: Element | null) => (one as Element).getBoundingClientRect();
      const g = rect(group);
      return {
        box: { top: g.top, bottom: g.bottom },
        picture: rect(group.querySelector('img[alt="Picture 1"]')).bottom,
        words: { top: rect(text).top, height: rect(text).height },
        plus: g.bottom - rect(group.querySelector('[aria-label="Attach a picture"]')).bottom,
        send: g.bottom - rect(group.querySelector('[aria-label="Send"]')).bottom,
      };
    });
    assert.ok(seen.picture <= seen.words.top, "above the words");
    assert.equal(seen.words.height, 48, "the words are still one line");
    assert.deepEqual([seen.plus, seen.send], [8, 8]);
    assert.equal(seen.box.bottom, (empty?.y ?? 0) + (empty?.height ?? 0), "its foot stays");
    assert.ok(seen.box.top < (empty?.y ?? 0), "it grew up");
    for (const n of [2, 1]) {
      await box(page)
        .getByRole("img", { name: `Picture ${n}` })
        .hover();
      await box(page)
        .getByRole("button", { name: `Remove picture ${n}` })
        .click();
    }
    assert.equal(await box(page).getByRole("img").count(), 0);
    assert.deepEqual(await box(page).boundingBox(), empty);
    await page.close();
  }),
);

test(
  "signed out, the place that says so has the box's width, corners and line, and the sentence over the whole way in, as large as it is everywhere",
  withGateway(async (gateway) => {
    sampleChats(gateway);
    const page = await open(gateway);
    await words(page).waitFor();
    const signedIn = await box(page).boundingBox();
    gateway.setAccount("signed_out");
    const place = main(page).getByRole("group", { name: "Sign in to send" });
    await place.waitFor();
    const seen = await place.evaluate((element) => {
      const style = getComputedStyle(element);
      const way = (element.querySelector("button") as Element).getBoundingClientRect();
      const { x, y, width, height } = element.getBoundingClientRect();
      return {
        place: { x, width, foot: y + height, height },
        corners: style.borderRadius,
        line: style.boxShadow,
        way: { width: way.width, height: way.height },
      };
    });
    assert.deepEqual(seen.place, {
      x: signedIn?.x,
      width: signedIn?.width,
      foot: (signedIn?.y ?? 0) + (signedIn?.height ?? 0),
      height: 108,
    });
    assert.equal(seen.corners, "24px");
    assert.equal(seen.line, "rgba(255, 255, 255, 0.08) 0px 0px 0px 1px inset");
    // The way in is the one the app has everywhere a person signs in from a chat: its full width.
    assert.deepEqual(seen.way, { width: (signedIn?.width ?? 0) - 32, height: 40 });
    await place.getByRole("button", { name: "Continue with ChatGPT" }).waitFor();
    gateway.setAccount("signed_in");
    await words(page).waitFor();
    assert.deepEqual(await box(page).boundingBox(), signedIn);
    await page.close();
  }),
);
