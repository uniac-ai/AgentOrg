// A conversation's head, in a real browser over the stand-in gateway: its agent's face in a round
// frame in the middle standing on a pill with its state, its name heard and not seen,
// its other controls at its ends, the head lying over the top of the room, and the blur what is
// said goes up into behind it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { between, computerWith, researchSays } from "./design/samples.ts";
import type { Agent } from "./stand-in.ts";

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
  await rest(page, thread);
  return { page, thread };
}

/** The pill under a head's frame. */
const pillOf = (thread: Locator) => thread.locator('header button[aria-label$="details"] + div');

/** The pointer off the head, and its pill come to rest under the frame. */
async function rest(page: Page, thread: Locator) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(
    (pill) => !!pill && getComputedStyle(pill).translate === "none",
    await pillOf(thread).elementHandle(),
  );
}

/**
 * The head, read at one moment: its middle and height; its frame (the face's button) and the pill
 * behind its foot, each as a box relative to the head, with how the frame is drawn; the pill's word
 * and which of the two is on top where they meet; the text a person sees in it and its heading's
 * words; and each of its other buttons by name, as its box relative to the head.
 */
const head = (thread: Locator) =>
  thread.locator("header").evaluate((header) => {
    const box = header.getBoundingClientRect();
    const relative = (r: DOMRect) => ({
      left: r.left - box.left,
      top: r.top - box.top,
      width: r.width,
      height: r.height,
      right: r.right - box.left,
      bottom: r.bottom - box.top,
    });
    const frame = header.querySelector('button[aria-label$="details"]') as HTMLElement;
    const framed = frame.getBoundingClientRect();
    const drawn = getComputedStyle(frame);
    const avatar = frame.querySelector("[data-face] svg") as Element;
    const pill = frame.nextElementSibling as HTMLElement;
    const pilled = pill.getBoundingClientRect();
    /** A colour as the page resolves it. */
    const colour = (value: string) => {
      const probe = document.createElement("i");
      probe.style.color = value;
      header.append(probe);
      const its = getComputedStyle(probe).color;
      probe.remove();
      return its;
    };
    // Where the two meet, just inside the pill's top: neither takes the pointer but the frame, so
    // for this one look the pill is let take it too, to be found there if it were on top.
    pill.style.pointerEvents = "auto";
    const met = document.elementFromPoint(
      (pilled.left + pilled.right) / 2,
      pilled.top + 2,
    ) as Element;
    pill.style.pointerEvents = "";
    // The words a person sees: text in an element wider than the one clipped pixel a heard-only
    // element is.
    const seen: string[] = [];
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = (node.textContent ?? "").trim();
      const shown = (node.parentElement as Element).getBoundingClientRect().width > 1;
      if (words && shown) seen.push(words);
    }
    const heading = header.querySelector("h2") as Element;
    return {
      middle: (box.left + box.right) / 2,
      deep: Math.round(box.height),
      wide: box.width,
      frame: relative(framed),
      frameMiddle: (framed.left + framed.right) / 2,
      round: Number.parseFloat(drawn.borderTopLeftRadius) >= framed.width / 2,
      border: [drawn.borderTopWidth, drawn.borderTopStyle],
      shadow: drawn.boxShadow !== "none",
      avatar: Math.round(avatar.getBoundingClientRect().width),
      pill: relative(pilled),
      pillMiddle: (pilled.left + pilled.right) / 2,
      pillRound: Number.parseFloat(getComputedStyle(pill).borderTopLeftRadius) >= pilled.height / 2,
      pillBorder: getComputedStyle(pill).borderTopWidth,
      frameOnTop: frame.contains(met),
      lines: [drawn.borderTopColor, getComputedStyle(pill).borderTopColor],
      tokens: [colour("var(--line)"), colour("var(--line)")],
      ground: drawn.backgroundColor,
      thread: colour("var(--thread)"),
      lighter: colour("color-mix(in srgb, var(--thread), white 4%)"),
      darker: colour("color-mix(in srgb, var(--thread), black 3%)"),
      light: document.documentElement.dataset.theme === "light",
      shadows: [drawn.boxShadow, getComputedStyle(pill).boxShadow],
      word: (pill.textContent ?? "").trim(),
      seen,
      heading: (heading.textContent ?? "").trim(),
      headingHidden: heading.getBoundingClientRect().width <= 1,
      buttons: Object.fromEntries(
        [...header.querySelectorAll("button")].map((button) => [
          button.getAttribute("aria-label"),
          relative(button.getBoundingClientRect()),
        ]),
      ),
    };
  });

type Box = { left: number; top: number; right: number; bottom: number };
const apart = (a: Box, b: Box) =>
  a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

for (const [where, width, has] of [
  ["chat", 1440, ["Research's details", "Research's computer"]],
  ["chat", 390, ["All chats", "Research's details", "Research's computer"]],
  ["floating", 1440, ["All chats", "Research's details", "Research's computer", "Close chats"]],
] as const)
  test(
    `the head is the agent's face in a round frame in its middle, standing on a pill with its state, the two centred together, its name heard and not seen, with ${has.length - 1} other control${has.length > 2 ? "s" : ""} on a line through the middle of the two at its ends, apart from both: ${where}, ${width} wide`,
    withGateway(async (gateway) => {
      researchSays(gateway, "receipt");
      const { page, thread } = await conversation(gateway, where, width);
      const now = await head(thread);
      // The frame: a 60 circle 6 from the head's top, edged by one line and a shadow, the face 48
      // in it, centred on the head.
      assert.deepEqual(
        [now.frame.top, now.frame.width, now.frame.height, now.avatar],
        [6, 60, 60, 48],
      );
      assert.ok(now.round, "the frame is round");
      assert.deepEqual(now.border, ["1px", "solid"]);
      assert.ok(now.shadow, "the frame has a shadow");
      assert.ok(
        Math.abs(now.frameMiddle - now.middle) <= 0.5,
        `the frame is centred at ${now.frameMiddle}, the head at ${now.middle}`,
      );
      // The pill at rest: 22 tall, round-ended, edged by one line, centred under the frame and 7 of
      // it under the frame's foot, behind it. Both are edged in the quiet line colour with the same
      // faint shadow. The frame is one small step off the conversation's ground: lighter in the
      // dark, darker in the light.
      assert.equal(now.pill.height, 22);
      assert.ok(now.pillRound, "the pill's ends are round");
      assert.equal(now.pillBorder, "1px");
      assert.ok(Math.abs(now.pillMiddle - now.frameMiddle) <= 0.5, "the pill is centred on it");
      assert.equal(now.frame.bottom - now.pill.top, 7);
      assert.ok(now.frameOnTop, "the frame is in front of the pill");
      assert.deepEqual(now.lines, now.tokens);
      assert.equal(now.shadows[0], now.shadows[1]);
      assert.notEqual(now.shadows[0], "none");
      assert.notEqual(now.ground, now.thread);
      assert.equal(now.ground, now.light ? now.darker : now.lighter);
      if (where === "chat" && width === 1440) {
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "light";
        });
        const light = await head(thread);
        assert.ok(light.light);
        assert.notEqual(light.ground, light.thread);
        assert.equal(light.ground, light.darker);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
      }
      // 6 above the frame and the resting pill, and 6 below them.
      assert.equal(now.deep, 87);
      assert.equal(now.deep - now.pill.bottom, 6);
      // The name is not drawn; it heads the conversation for those who hear it.
      assert.deepEqual(now.seen, ["Working"]);
      assert.equal(now.heading, "Research");
      assert.ok(now.headingHidden, "the heading takes no room on the screen");
      assert.deepEqual(Object.keys(now.buttons), has);
      // The way back starts the head; the last control ends it; each is on the frame's middle
      // line, apart from the frame and the pill.
      if (now.buttons["All chats"]) assert.equal(now.buttons["All chats"].left, 10);
      const last = now.buttons[has.at(-1) as string] as Box;
      assert.equal(Math.round(now.wide - last.right), 10);
      for (const name of has.filter((one) => !one.endsWith("details"))) {
        const button = now.buttons[name] as Box & { top: number; height: number };
        assert.equal(button.top + button.height / 2, (now.frame.top + now.pill.bottom) / 2, name);
        assert.ok(apart(button, now.frame) && apart(button, now.pill), `${name} is apart`);
      }
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
  "the pill says each state in the word the shell has for it, after the mark the face has for it elsewhere, green and pulsing while working, red with a problem, a spinner while starting, grey otherwise; the face in the head has no mark of its own",
  withGateway(async (gateway) => {
    (gateway.agents.get("a-triage") as Agent).status = { state: "starting" };
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    for (const [agent, name, word, mark] of [
      ["a-research", "Research", "Working", "--ok"],
      ["a-reviewer", "Reviewer", "Idle", "grey"],
      ["a-triage", "Triage", "Starting", "spinner"],
      ["a-weekly", "Weekly report", "Stopped", "grey"],
      ["a-broken", "Broken", "Has a problem", "--bad"],
    ] as const) {
      await page.goto(`${gateway.url}/#/chat/${agent}`);
      const header = page
        .getByRole("main")
        .getByRole("region", { name: `Conversation with ${name}` })
        .locator("header");
      await header.getByText(word, { exact: true }).waitFor();
      const read = await header.evaluate((header) => {
        const frame = header.querySelector('button[aria-label$="details"]') as Element;
        const pill = frame.nextElementSibling as Element;
        const first = pill.firstElementChild as Element;
        const colour = (value: string) => {
          const probe = document.createElement("i");
          probe.style.color = value;
          header.append(probe);
          const its = getComputedStyle(probe).color;
          probe.remove();
          return its;
        };
        return {
          word: (pill.textContent ?? "").trim(),
          spins: first.tagName.toLowerCase() === "svg" && first.classList.contains("animate-spin"),
          ground: getComputedStyle(first).backgroundColor,
          pulses: first.classList.contains("pulse"),
          ok: colour("var(--ok)"),
          bad: colour("var(--bad)"),
          marks: frame.querySelectorAll('[role="img"]').length,
        };
      });
      assert.equal(read.word, word);
      assert.equal(read.marks, 0, `${name}: the face has no mark`);
      assert.equal(read.spins, mark === "spinner", `${name}: spins`);
      assert.equal(read.pulses, mark === "--ok", `${name}: pulses`);
      if (mark === "--ok") assert.equal(read.ground, read.ok, name);
      if (mark === "--bad") assert.equal(read.ground, read.bad, name);
      if (mark === "grey")
        assert.ok(![read.ok, read.bad, "rgba(0, 0, 0, 0)"].includes(read.ground), name);
    }
    await page.close();
  }),
);

test(
  "a conversation between two agents is headed by both, heard and not seen, and says under the pill, small and quiet, that it is there to be read; the head is 111 tall, and its first message starts 12 under it",
  withGateway(async (gateway) => {
    between(gateway);
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-release/chats`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Release notes's chats with other agents" })
      .getByRole("button")
      .first()
      .click();
    const thread = page.getByRole("complementary", { name: "Chats" });
    await thread.locator('[data-slot="bubble"]').first().waitFor();
    await rest(page, thread);
    const now = await head(thread);
    assert.equal(now.heading, "Release notes and Research");
    assert.ok(now.headingHidden, "the heading takes no room on the screen");
    assert.deepEqual(now.seen, ["Idle", "You can read it, not write in it"]);
    assert.equal(now.deep, 111);
    const line = await thread
      .locator("header")
      .getByText("You can read it, not write in it")
      .evaluate((line) => {
        const header = (line.closest("header") as Element).getBoundingClientRect();
        const box = line.getBoundingClientRect();
        const style = getComputedStyle(line);
        const muted = document.createElement("i");
        muted.className = "text-muted-foreground";
        line.append(muted);
        const quiet = getComputedStyle(muted).color;
        muted.remove();
        return {
          top: box.top - header.top,
          middle: (box.left + box.right) / 2,
          size: style.fontSize,
          quiet: style.color === quiet,
        };
      });
    // 8 under the resting pill, clear of it slid out.
    assert.equal(line.top, now.pill.bottom + 8);
    assert.ok(Math.abs(line.middle - now.frameMiddle) <= 0.5, "centred under the pill");
    assert.deepEqual([line.size, line.quiet], ["12px", true]);
    // The first message, who said it above its bubble.
    const first = await thread.locator('[data-slot="message-scroller-item"]').first().boundingBox();
    const box = await thread.locator("header").boundingBox();
    assert.ok(first && box);
    assert.equal(Math.round(first.y - (box.y + box.height)), 12);
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
          headDeep: 87,
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

test(
  "with the pointer on the frame or the pill, or the keyboard on the frame, the pill slides 6 px down from under the frame, its words clear of it, and back as they leave; the head's height and the room stay as they are; with reduced motion it moves at once",
  withGateway(async (gateway) => {
    researchSays(gateway, "oneLine");
    const { page, thread } = await conversation(gateway, "chat");
    const pill = pillOf(thread);
    const frame = thread.getByRole("button", { name: "Research's details" });
    /** Where the pill and its words are, the frame's foot, the head's height and the first message. */
    const read = () =>
      pill.evaluate((pill) => {
        const header = pill.closest("header") as Element;
        const words = document.createRange();
        words.selectNodeContents(pill.lastChild as Node);
        const frame = pill.previousElementSibling as Element;
        const section = header.parentElement as Element;
        return {
          top: pill.getBoundingClientRect().top,
          words: words.getBoundingClientRect().top,
          foot: frame.getBoundingClientRect().bottom,
          deep: header.getBoundingClientRect().height,
          first: (section.querySelector('[data-slot="bubble"]') as Element).getBoundingClientRect()
            .top,
        };
      });
    /** Waits for the pill to come to where it moves: out by 6, or at rest. */
    const settles = async (out: boolean) =>
      page.waitForFunction(([pill, want]) => !!pill && getComputedStyle(pill).translate === want, [
        await pill.elementHandle(),
        out ? "0px 6px" : "none",
      ] as const);
    const resting = await read();
    // At rest the frame's foot is over the tops of its words.
    assert.ok(resting.words < resting.foot, "at rest the frame covers the words' tops");
    await frame.hover();
    await settles(true);
    const out = await read();
    assert.equal(out.top - resting.top, 6);
    assert.ok(
      out.words >= out.foot,
      `its words start at ${out.words}, the frame ends at ${out.foot}`,
    );
    assert.deepEqual([out.deep, out.first], [resting.deep, resting.first]);
    // On the pill itself, below the frame, it stays out.
    const box = await pill.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 4, box.y + box.height - 3);
    await settles(true);
    await rest(page, thread);
    assert.deepEqual(await read(), resting);
    // The keyboard on the frame.
    await page.keyboard.press("Tab");
    await frame.focus();
    await settles(true);
    await frame.blur();
    await settles(false);
    // Reduced motion: no slide, the pill out in the same render as the pointer comes.
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await pill.evaluate((pill) => getComputedStyle(pill).transitionProperty), "none");
    await frame.hover();
    assert.equal(await pill.evaluate((pill) => getComputedStyle(pill).translate), "0px 6px");
    await page.close();
  }),
);
