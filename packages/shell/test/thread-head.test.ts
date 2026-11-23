// A conversation's head, in a real browser over the stand-in gateway: its agent's face and name in
// the middle, its other controls at its ends, the head lying over the top of the room, and the blur
// what is said goes up into behind it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { computerWith, researchSays } from "./design/samples.ts";

withBrowser();

/** Research's conversation, its agent with a computer: on Chat, or in the floating chat. */
async function conversation(
  gateway: Gateway,
  where: "chat" | "floating",
  width = 1440,
): Promise<{ page: Page; thread: Locator }> {
  computerWith(gateway, "terminal");
  const page = await browser().newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
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
  await thread.locator('[data-slot="bubble"]').first().waitFor();
  return { page, thread };
}

/**
 * The head, read at one moment: its own middle; the middle of its face and name together; and each
 * of its buttons by name, as how far it starts from the head's start and ends from the head's end.
 */
const head = (thread: Locator) =>
  thread.locator("header").evaluate((header) => {
    const box = header.getBoundingClientRect();
    const face = header.querySelector('button[aria-label$="details"]') as Element;
    const name = header.querySelector("h2") as Element;
    // The name as wide as its words, not as the room it is given.
    const words = document.createRange();
    words.selectNodeContents(name);
    return {
      middle: (box.left + box.right) / 2,
      who: (face.getBoundingClientRect().left + words.getBoundingClientRect().right) / 2,
      named: (name.textContent ?? "").trim(),
      buttons: Object.fromEntries(
        [...header.querySelectorAll("button")].map((button) => {
          const b = button.getBoundingClientRect();
          return [
            button.getAttribute("aria-label"),
            [Math.round(b.left - box.left), Math.round(box.right - b.right)],
          ];
        }),
      ),
    };
  });

for (const [where, width, has] of [
  ["chat", 1440, ["Research's details", "Research's computer"]],
  ["chat", 390, ["All chats", "Research's details", "Research's computer"]],
  ["floating", 1440, ["All chats", "Research's details", "Research's computer", "Close chats"]],
] as const)
  test(
    `the agent's face and name are in the middle of the head, with ${has.length - 1} other control${has.length > 2 ? "s" : ""} at its ends: ${where}, ${width} wide`,
    withGateway(async (gateway) => {
      researchSays(gateway, "oneLine");
      const { page, thread } = await conversation(gateway, where, width);
      const now = await head(thread);
      assert.equal(now.named, "Research");
      assert.ok(
        Math.abs(now.who - now.middle) <= 1,
        `its face and name are centred at ${now.who}, the head at ${now.middle}`,
      );
      assert.deepEqual(Object.keys(now.buttons), has);
      // The way back starts the head; the last control ends it.
      if (now.buttons["All chats"]) assert.equal(now.buttons["All chats"][0], 10);
      assert.equal(now.buttons[has.at(-1) as string]?.[1], 10);
      // Each still does what it did. On a phone the computer opens over the conversation, so
      // there the way back is the one pressed.
      if (width >= 1440) {
        await thread.getByRole("button", { name: "Research's computer" }).click();
        assert.equal(
          await thread
            .getByRole("button", { name: "Research's computer" })
            .getAttribute("aria-pressed"),
          "true",
        );
      }
      if (now.buttons["All chats"]) {
        await thread.getByRole("button", { name: "All chats" }).click();
        await page.getByRole("list", { name: "Chats" }).waitFor();
      }
      await page.close();
    }),
  );

test(
  "the head takes no room: it lies over the top of the room, whose first message starts 12 px under it; behind it and 40 px under it a blur in the conversation's ground lies over what is said, none where the room is at its start, all of it once what is said has gone up; and the wheel over the head moves the room",
  withGateway(async (gateway) => {
    for (const where of ["chat", "floating"] as const) {
      researchSays(gateway, "oneLine");
      const { page, thread } = await conversation(gateway, where);
      /**
       * The head over the room, and the blur: where each lies, how much of the blur shows, and
       * what it is washed in.
       */
      const read = () =>
        thread.locator('[data-slot="message-scroller"]').evaluate((scroller) => {
          const over = scroller.querySelector(':scope > [aria-hidden="true"]') as HTMLElement;
          const box = over.getBoundingClientRect();
          const room = scroller.getBoundingClientRect();
          const thread = scroller.parentElement as Element;
          const head = (thread.querySelector("header") as Element).getBoundingClientRect();
          const first = (
            scroller.querySelector('[data-slot="bubble"]') as Element
          ).getBoundingClientRect();
          const wash = getComputedStyle(over.lastElementChild as Element).backgroundColor;
          const ground = document.createElement("i");
          ground.style.background = "var(--thread)";
          scroller.append(ground);
          const its = getComputedStyle(ground).backgroundColor;
          ground.remove();
          return {
            headOverRoom: [Math.round(head.top - room.top), Math.round(head.width - room.width)],
            headDeep: Math.round(head.height),
            first: Math.round(first.top - head.bottom),
            blurFrom: Math.round(box.top - room.top),
            blurPastHead: Math.round(box.bottom - head.bottom),
            wide: Math.round(box.width - room.width),
            shows: Number(over.style.getPropertyValue("--gradual-blur-reveal")),
            layers: [...over.children].filter(
              (one) => getComputedStyle(one).backdropFilter !== "none",
            ).length,
            washed: wash === its,
            pointer: getComputedStyle(over).pointerEvents,
          };
        });
      const start = await read();
      assert.deepEqual(
        { ...start, layers: start.layers > 0 },
        {
          headOverRoom: [0, 0],
          headDeep: 56,
          first: 12,
          blurFrom: 0,
          blurPastHead: 40,
          wide: 0,
          shows: 0,
          layers: true,
          washed: true,
          pointer: "none",
        },
        `${where}: a room at its start`,
      );
      // A reply longer than the room: its start has gone up behind the head.
      const said = Array.from({ length: 70 }, (_, n) => `Finding ${n} is on a line of its own.`);
      gateway.addMessage("a-research", {
        id: "whole",
        role: "assistant",
        text: said.join("\n\n"),
        at: new Date().toISOString(),
      });
      await thread.getByText("Finding 69 is").waitFor();
      await page.waitForFunction(
        (scroller) =>
          scroller
            ?.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')
            ?.style.getPropertyValue("--gradual-blur-reveal") === "1.000",
        await thread.locator('[data-slot="message-scroller"]').elementHandle(),
      );
      assert.equal((await read()).shows, 1, `${where}: scrolled`);
      // The wheel over the head, beside its name, moves the room under it.
      const room = thread.locator('[data-slot="message-scroller-viewport"]');
      const short = () =>
        room.evaluate((view) => Math.round(view.scrollHeight - view.scrollTop - view.clientHeight));
      assert.equal(await short(), 0, "at its end");
      const head = await thread.locator("header").boundingBox();
      assert.ok(head);
      await page.mouse.move(head.x + head.width * 0.25, head.y + head.height / 2);
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(
        (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight === 300,
        await room.elementHandle(),
      );
      await page.close();
    }
  }),
);

test(
  "a conversation with nothing said yet says what went wrong right under the head",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "It can't take that now.");
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/chat/a-triage`);
    const thread = page.getByRole("main").getByRole("region", { name: "Conversation with Triage" });
    const box = thread.getByRole("textbox", { name: "Message" });
    await box.fill("Route today's issues");
    await box.press("Enter");
    const wrong = thread.getByRole("alert");
    await wrong.getByText("It can't take that now.").waitFor();
    const [head, line] = [await thread.locator("header").boundingBox(), await wrong.boundingBox()];
    assert.ok(head && line);
    assert.equal(Math.round(line.y - (head.y + head.height)), 0);
    await page.close();
  }),
);
