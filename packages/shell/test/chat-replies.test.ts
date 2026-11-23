// The chat's replies in a real browser, over the stand-in gateway: how one is written and settles,
// how a message that comes rises in, earlier messages read on asking, the thread's room, a long
// reply followed to its end, and the latest message at the room's foot.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { browser, SESSION, withBrowser } from "./build-kit.ts";
import {
  input,
  mine,
  nothingUnder,
  open,
  panel,
  reply,
  until,
  visit,
  withGateway,
} from "./chat-kit.ts";

withBrowser();

test(
  "a reply's words are never seen part written: none of it shows until a bubble of it is whole, none of its words is revealed apart, and it settles as one message",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // The agent works, and the newest thing said here is the person's: the chat awaits a reply.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    gateway.addMessage("a-reviewer", {
      id: "u-ask",
      role: "user",
      text: "Why did it fail?",
      at: new Date().toISOString(),
    });
    await mine(page, "Why did it fail?").waitFor();
    // While it works on it, the chat shows the message and nothing under it.
    await nothingUnder(page, "Why did it fail?");
    /**
     * The words of the bubbles drawn after the person's message: what each says, how many parts
     * it is in, and what of it moves.
     */
    const words = () =>
      panel(page).evaluate((root) => {
        const all = [...root.querySelectorAll(".prose-chat, .whitespace-pre-wrap")];
        const asked = all.findLastIndex((one) => one.classList.contains("whitespace-pre-wrap"));
        return all.slice(asked + 1).map((written) => ({
          said: (written.textContent ?? "").trim(),
          parts: written.querySelectorAll("span").length,
          moving: written.getAnimations({ subtree: true }).length,
        }));
      });
    const typing = panel(page).getByRole("status", { name: "Reviewer is typing" });
    gateway.delta("a-reviewer", "r1", "Three causes ");
    await page.waitForTimeout(300);
    assert.deepEqual(await words(), [], "its first words may still be written");
    assert.equal(await typing.count(), 1, "the sign says it is being written");
    // Its second paragraph begun, its first is whole.
    gateway.delta("a-reviewer", "r1", "explain it.\n\nThe first ");
    await panel(page).getByText("Three causes explain it.").waitFor();
    assert.deepEqual(await words(), [{ said: "Three causes explain it.", parts: 0, moving: 0 }]);
    assert.equal(await typing.count(), 1, "and the rest is still being written");
    gateway.addMessage(
      "a-reviewer",
      reply("r1", "Three causes explain it.\n\nThe first is the lock file."),
    );
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByRole("button", { name: "More" }).last().waitFor();
    assert.equal(await panel(page).getByText("Three causes explain it.").count(), 1);
    assert.deepEqual(await words(), [
      { said: "Three causes explain it.", parts: 0, moving: 0 },
      { said: "The first is the lock file.", parts: 0, moving: 0 },
    ]);
    assert.equal(await typing.count(), 0);
    await page.close();
  }),
);

/**
 * How each thing said in the chat comes in, top to bottom: the person's messages, and the agent's
 * bubbles with its typing sign marked. "message-in 0.16s" rises in; "none" is simply there.
 */
const comingIn = (page: Page) =>
  panel(page).evaluate((root) => {
    const how = (one: Element) => {
      const style = getComputedStyle(one);
      return style.animationName === "none"
        ? "none"
        : `${style.animationName} ${style.animationDuration}`;
    };
    return {
      mine: [...root.querySelectorAll('[data-slot="message"][data-align="end"]')].map(how),
      theirs: [
        ...root.querySelectorAll('[data-slot="bubble"]:not([data-variant="secondary"])'),
      ].map((bubble) => `${how(bubble)}${bubble.querySelector(".typing-dot") ? ", the sign" : ""}`),
    };
  });

test(
  "what comes while the conversation is open rises in with a fade, in 160 ms: the person's message, the sign under it, and each bubble of the reply as it comes whole; what was there as it opened, and earlier messages read in, are simply there",
  withGateway(async (gateway) => {
    const chat = gateway.agents.get("a-reviewer");
    assert.ok(chat);
    chat.chat.messages.unshift(
      ...Array.from({ length: 120 }, (_, i) => ({
        ...reply(`old${i}`, `Old note ${i}`),
        ...(i % 2 ? {} : { role: "user" as const }),
      })),
    );
    const page = await open(gateway);
    const opened = await comingIn(page);
    assert.ok(opened.mine.length > 0 && opened.theirs.length > 0);
    assert.deepEqual([...new Set([...opened.mine, ...opened.theirs])], ["none"], "as it opens");

    await input(page).fill("Why did it fail?");
    await input(page).press("Enter");
    await panel(page).getByRole("status", { name: "Reviewer is typing" }).waitFor();
    let now = await comingIn(page);
    assert.deepEqual(now.mine, [...opened.mine, "message-in 0.16s"], "the person's message");
    assert.deepEqual(
      now.theirs,
      [...opened.theirs, "message-in 0.16s, the sign"],
      "the sign under a message that came",
    );

    // Its bubbles as each comes whole: the first above the sign, then the last as it is recorded.
    gateway.delta("a-reviewer", "r1", "Three causes explain it.\n\nThe first ");
    await panel(page).getByText("Three causes explain it.").waitFor();
    assert.deepEqual((await comingIn(page)).theirs, [
      ...opened.theirs,
      "message-in 0.16s",
      "message-in 0.16s, the sign",
    ]);
    const written = [...opened.theirs, "message-in 0.16s", "message-in 0.16s"];
    gateway.addMessage(
      "a-reviewer",
      reply("r1", "Three causes explain it.\n\nThe first is the lock file."),
    );
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByRole("button", { name: "More" }).last().waitFor();
    assert.deepEqual((await comingIn(page)).theirs, written, "recorded");

    // Earlier messages read in above: they, and all that was there, are simply there.
    await panel(page).getByRole("button", { name: "Earlier messages" }).click();
    await panel(page).getByText("Old note 3", { exact: true }).waitFor({ state: "attached" });
    now = await comingIn(page);
    assert.deepEqual(
      [now.mine.filter((one) => one !== "none"), now.theirs.filter((one) => one !== "none")],
      [["message-in 0.16s"], ["message-in 0.16s", "message-in 0.16s"]],
      "only what came",
    );
    assert.deepEqual([now.mine.at(-1), ...now.theirs.slice(-2)], Array(3).fill("message-in 0.16s"));
    await page.close();
  }),
);

test(
  "for a person who asks for less motion, a message that comes is simply there",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page)
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Reviewer" })
      .click();
    await input(page).fill("Why did it fail?");
    await input(page).press("Enter");
    await panel(page).getByRole("status", { name: "Reviewer is typing" }).waitFor();
    gateway.addMessage("a-reviewer", reply("r1", "Three causes explain it."));
    await panel(page).getByText("Three causes explain it.").waitFor();
    const now = await comingIn(page);
    assert.deepEqual([...new Set([...now.mine, ...now.theirs])], ["none"]);
    await page.close();
  }),
);

test(
  "earlier messages load on asking, and the model isn't in the chat",
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
    const page = await open(gateway);
    assert.equal(await panel(page).getByText("Old note 3", { exact: true }).count(), 0);
    // The reply shown is the same one after earlier messages come in above it, not drawn anew.
    await panel(page)
      .locator(".prose-chat")
      .last()
      .evaluate((e) => e.setAttribute("data-kept", ""));
    await panel(page).getByRole("button", { name: "Earlier messages" }).click();
    await panel(page).getByText("Old note 3", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await panel(page).getByRole("button", { name: "Earlier messages" }).count(), 0);
    assert.equal(await panel(page).locator("[data-kept]").count(), 1);
    // Read again, as when the agent comes back, what was read before stays where it was.
    chat.status = { state: "down", detail: "Its program exited." };
    gateway.changed();
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText(/exited/)
      .waitFor();
    const reads = () => gateway.calls.filter((c) => c.method === "history").length;
    const read = reads();
    chat.status = { state: "running" };
    gateway.changed();
    await until(() => reads() > read);
    await page.waitForTimeout(300);
    assert.equal(await panel(page).getByText("Old note 3", { exact: true }).count(), 1);
    assert.equal(await panel(page).getByRole("button", { name: "Earlier messages" }).count(), 0);
    assert.equal(await panel(page).getByRole("combobox", { name: "Model" }).count(), 0);
    await page.close();
  }),
);

test(
  "the chat shows no scrollbar and doesn't overflow, wide or phone",
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      const page = await open(gateway, width);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
        for (const el of document.querySelectorAll<HTMLElement>("main, main *, aside, aside *"))
          if (
            /auto|scroll/.test(getComputedStyle(el).overflowY) &&
            el.offsetWidth - el.clientWidth > 0
          )
            out.push(el.className);
        return out;
      });
      assert.deepEqual(bad, [], String(width));
      await page.close();
    }
  }),
);

test(
  "a reply longer than the chat's room is followed to its end, unless the person has scrolled away",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const room = panel(page).locator('[data-slot="message-scroller-viewport"]');
    /** How far what is shown is from the end of what was said. */
    const short = () =>
      room.evaluate((view) => Math.round(view.scrollHeight - view.scrollTop - view.clientHeight));
    /** What is shown comes to the end of what was said: it follows a frame or more behind. */
    const atEnd = async (what: string) => {
      try {
        await page.waitForFunction(
          (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight <= 8,
          await room.elementHandle(),
          { timeout: 3000 },
        );
      } catch {
        assert.fail(`${what} (${await short()} short)`);
      }
    };
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, n) => `Finding ${from + n} is on a line of its own.`);
    const write = async (id: string, said: string[]) => {
      for (const line of said) {
        gateway.delta("a-reviewer", id, `${line}\n\n`);
        await page.waitForTimeout(15);
      }
    };
    await input(page).fill("List every finding.");
    await input(page).press("Enter");
    await mine(page, "List every finding.").waitFor();

    // Its bubbles pass the foot of the room as each comes whole: what is shown stays at the last
    // of them, with the one still being written not yet there.
    await write("long", lines(0, 60));
    await panel(page).getByText("Finding 58 is").waitFor();
    assert.equal(await panel(page).getByText("Finding 59 is").count(), 0);
    await atEnd("the end is in view while it is written");
    gateway.addMessage("a-reviewer", reply("long", lines(0, 60).join("\n\n")));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByRole("button", { name: "More" }).last().waitFor({ state: "attached" });
    await atEnd("and when it is done");
    assert.ok(await panel(page).getByText("Finding 59 is").isVisible());

    // A person who has scrolled away is left where they are.
    await room.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(
      (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight > 300,
      await room.elementHandle(),
    );
    const left = await short();
    await write("more", lines(60, 80));
    await panel(page).getByText("Finding 78 is").waitFor({ state: "attached" });
    await page.waitForTimeout(400);
    assert.ok((await short()) >= left, "nothing pulled it back to the end");
    // The way back is theirs to press, and from the end it is followed again.
    await panel(page).getByRole("button", { name: "Scroll to end" }).click();
    await page.waitForFunction(
      (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight <= 8,
      await room.elementHandle(),
    );
    await write("more", lines(80, 100));
    await panel(page).getByText("Finding 98 is").waitFor();
    await atEnd("followed again from the end");
    await page.close();
  }),
);

test(
  "a conversation's first reply is followed to its end too, though it came whole under a message that was at the top already",
  withGateway(async (gateway) => {
    const agent = "a-triage";
    const page = await visit(gateway, agent);
    await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
    await input(page).fill("List every finding.");
    await input(page).press("Enter");
    await mine(page, "List every finding.").waitFor();
    const room = panel(page).locator('[data-slot="message-scroller-viewport"]');
    const short = () =>
      room.evaluate((view) => Math.round(view.scrollHeight - view.scrollTop - view.clientHeight));
    assert.equal(await short(), 0, "nothing is past the foot yet");
    const said = Array.from({ length: 70 }, (_, n) => `Finding ${n} is on a line of its own.`);
    gateway.addMessage(agent, reply("whole", said.join("\n\n")));
    gateway.setChatStatus(agent, { state: "idle" });
    await panel(page).getByText("Finding 69 is").waitFor();
    await page.waitForFunction(
      (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight <= 8,
      await room.elementHandle(),
    );
    await page.waitForTimeout(300);
    assert.ok((await short()) <= 8, `it stays there (${await short()} short)`);
    await page.close();
  }),
);

/** Reviewer's conversation, longer than the chat's room: thirty messages, a side each in turn. */
const longConversation = (gateway: Parameters<typeof open>[0]) =>
  gateway.converse(
    "a-reviewer",
    Array.from({ length: 30 }, (_, n) => ({
      ...reply(`long-${n}`, `Note ${n} of a conversation longer than its room.`),
      ...(n % 2 ? {} : { role: "user" as const }),
    })),
  );
/** The chat's room, how far it is from its end, and how far its last bubble's foot is above its own. */
const roomOf = (page: Parameters<typeof panel>[0]) => {
  const room = panel(page).locator('[data-slot="message-scroller-viewport"]');
  return {
    room,
    short: () =>
      room.evaluate((view) => Math.round(view.scrollHeight - view.scrollTop - view.clientHeight)),
    under: () =>
      room.evaluate((view) => {
        const last = [...view.querySelectorAll('[data-slot="bubble"]')].at(-1) as Element;
        return Math.round(
          view.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
        );
      }),
    /** The room comes to its end, a frame or more behind what came. */
    atEnd: async (what: string) => {
      try {
        await page.waitForFunction(
          (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight <= 8,
          await room.elementHandle(),
          { timeout: 3000 },
        );
      } catch {
        assert.fail(what);
      }
    },
  };
};

test(
  "in a long conversation the latest message is at the room's foot, 16 px above the box: as it opens, with a message just sent and the agent's sign under it, and with the reply",
  withGateway(async (gateway) => {
    longConversation(gateway);
    const page = await open(gateway);
    const { short, under, atEnd } = roomOf(page);
    await atEnd("it opens at its end");
    assert.equal(await under(), 16, "as it opens");
    await input(page).fill("Is that all of them?");
    await input(page).press("Enter");
    await panel(page).getByRole("status", { name: "Reviewer is typing" }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual([await short(), await under()], [0, 16], "the sign under the message sent");
    assert.ok(await mine(page, "Is that all of them?").isVisible());
    gateway.addMessage("a-reviewer", reply("all", "Yes, that is all thirty."));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByText("Yes, that is all thirty.").waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual([await short(), await under()], [0, 16], "the reply");
    await page.close();
  }),
);

test(
  "a person who has scrolled away is brought to the end by a message of their own",
  withGateway(async (gateway) => {
    longConversation(gateway);
    const page = await open(gateway);
    const { room, short, atEnd } = roomOf(page);
    await atEnd("it opens at its end");
    await room.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(
      (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight > 300,
      await room.elementHandle(),
    );
    await input(page).fill("Back to the newest.");
    await input(page).press("Enter");
    await mine(page, "Back to the newest.").waitFor();
    await atEnd(`their own message is gone to (${await short()} short)`);
    await page.close();
  }),
);

test(
  "a person who moved the wheel where the room had nothing to scroll hasn't scrolled away: a reply that then comes whole, longer than the room, is followed to its end",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const { room, short, atEnd } = roomOf(page);
    assert.equal(
      await room.evaluate((view) => view.scrollHeight - view.clientHeight),
      0,
      "all of it is in view",
    );
    await room.hover();
    await page.mouse.wheel(0, -200);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(600);
    const said = Array.from({ length: 70 }, (_, n) => `Finding ${n} is on a line of its own.`);
    gateway.addMessage("a-reviewer", reply("whole", said.join("\n\n")));
    await panel(page).getByText("Finding 69 is").waitFor({ state: "attached" });
    await atEnd(`its end is gone to (${await short()} short)`);
    await page.close();
  }),
);

test(
  "a reply in which nothing was said has nothing to copy",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("Read the issue.");
    await input(page).press("Enter");
    await mine(page, "Read the issue.").waitFor();
    // A reply with no words, as an earlier reply read as sent can be. What was said is counted, not
    // the agent's sign while it types, which goes as the reply comes.
    const said = '[data-slot="message-scroller-item"]:not(:has(.typing-dot))';
    const items = panel(page).locator(said);
    const before = await items.count();
    gateway.addMessage("a-reviewer", reply("r-none", ""));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await page.waitForFunction(
      ([one, n]) => document.querySelectorAll(one as string).length === n,
      [said, before + 1] as const,
    );
    // It has no bubble, and so no menu to copy from.
    const turn = items.last();
    assert.equal(await turn.locator('[data-slot="bubble"]').count(), 0);
    assert.equal(await turn.getByRole("button", { name: "More" }).count(), 0);
    // A reply with words has one, as before.
    gateway.addMessage("a-reviewer", reply("r-said", "It is a duplicate of #3."));
    await panel(page)
      .locator('[data-slot="message-scroller-item"]')
      .filter({ hasText: "It is a duplicate of #3." })
      .getByRole("button", { name: "More" })
      .waitFor();
    await page.close();
  }),
);
