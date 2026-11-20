// An agent's face, wherever the page draws it: a rounded square, its corners a quarter of its
// size, with its state's dot still round. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { noted } from "./design/samples.ts";

withBrowser();

async function open(gateway: Gateway, hash: string, width = 1440): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** Each face drawn, as its width and height, its corner and its state's dot's corner, if any. */
const faces = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[aria-hidden="true"][style*="linear-gradient(140deg"]')].map(
      (face) => {
        const box = face.getBoundingClientRect();
        const dot = face.parentElement?.querySelector(':scope > span[role="img"]');
        return {
          size: `${box.width}x${box.height}`,
          corner: getComputedStyle(face).borderTopLeftRadius,
          dotRound: dot
            ? Number.parseFloat(getComputedStyle(dot).borderTopLeftRadius) >=
              dot.getBoundingClientRect().width / 2
            : null,
        };
      },
    ),
  );

test(
  "every face on Chat and Team is a rounded square, its corners a quarter of its size, and a state's dot stays round",
  withGateway(async (gateway) => {
    for (const [hash, width] of [
      ["#/chat", 1440],
      ["#/team", 1440],
      ["#/a/a-research", 1440],
      ["#/chat", 390],
    ] as const) {
      const page = await open(gateway, hash, width);
      await page.locator('[style*="linear-gradient(140deg"]').first().waitFor();
      const seen = await faces(page);
      assert.ok(seen.length > 0, `faces on ${hash}`);
      for (const face of seen) {
        const [w, h] = face.size.split("x");
        assert.equal(w, h, `a square on ${hash}`);
        assert.equal(face.corner, "25%", `corners a quarter of its size on ${hash}`);
        if (face.dotRound !== null) assert.ok(face.dotRound, `its dot round on ${hash}`);
      }
      assert.ok(
        seen.some((face) => face.dotRound !== null) || hash !== "#/team",
        "a state's dot is among them",
      );
      await page.close();
    }
  }),
);

test(
  "the collapsed chat's faces, each in its ring, are rounded squares too",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team");
    const pill = page.getByRole("group", { name: "Chats, collapsed" });
    await pill.waitFor();
    // Said before the page's note of what is read begins, a reply is read already: no ring.
    await noted(gateway);
    gateway.addMessage("a-research", {
      id: "n1",
      role: "assistant",
      text: "A reply.",
      at: new Date().toISOString(),
    });
    const ring = pill.getByRole("button", { name: /^Open / });
    await ring.waitFor();
    const seen = await ring.evaluate((button) => ({
      ring: getComputedStyle(button).borderTopLeftRadius,
      drawn: getComputedStyle(button).boxShadow !== "none",
      face: getComputedStyle(button.querySelector('[aria-hidden="true"]') as Element)
        .borderTopLeftRadius,
    }));
    assert.deepEqual(seen, { ring: "25%", drawn: true, face: "25%" });
    await page.close();
  }),
);
