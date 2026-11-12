// The chat in the layer over the page, in a real browser: collapsed at the foot on the right, open
// as a panel, every agent's chats in one list, and what hasn't been read.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash = "#/", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await chatButton(page).waitFor();
  await noted(gateway);
  return page;
}
/** The shell has its note of what is read: a reply said from here on is new. */
async function noted(gateway: Gateway) {
  for (let tries = 0; !gateway.notes.has("ui/read"); tries++) {
    assert.ok(tries < 400, "the note of what is read is begun");
    await new Promise((done) => setTimeout(done, 20));
  }
  await new Promise((done) => setTimeout(done, 5));
}
/** The list, open, with every chat it will show: `count` rows. */
async function listed(page: Page, count: number) {
  await chatButton(page).click();
  await rows(page)
    .nth(count - 1)
    .waitFor();
}
/** Waits for what the page or the stand-in will come to, which arrives a call at a time. */
async function until<T>(read: () => T | Promise<T>, expected: T) {
  for (let tries = 0; ; tries++) {
    const now = await read();
    try {
      assert.deepEqual(now, expected);
      return;
    } catch (error) {
      if (tries > 200) throw error;
      await new Promise((done) => setTimeout(done, 40));
    }
  }
}
const noteAt = (gateway: Gateway) =>
  (gateway.notes.get("ui/read") as { at: Record<string, string> } | undefined)?.at;
const closeChats = (page: Page) => panel(page).getByRole("button", { name: "Close chats" }).click();
const pill = (page: Page) => page.getByRole("group", { name: "Chats, collapsed" });
const chatButton = (page: Page) => pill(page).getByRole("button", { name: /^Chats/ });
const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });
const main = (page: Page) => page.getByRole("main");
const rows = (page: Page) => panel(page).getByRole("list").getByRole("button");
/** A part's box as [x, y, width, height], to the hundredth. */
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 100) / 100);
};
/** Opens an agent's newest chat, from the list. */
const openNewest = async (page: Page, name: string) => {
  if (!(await panel(page).count())) await chatButton(page).click();
  const all = panel(page).getByRole("button", { name: "All chats" });
  if (await all.count()) await all.click();
  await rows(page).filter({ hasText: name }).first().click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
};
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});
const said = (id: string, role: "user" | "assistant", text: string, minutes: number) => ({
  id,
  role,
  text,
  at: new Date(Date.now() - minutes * 60_000).toISOString(),
});
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};

test(
  "the chat is collapsed at the foot on the right, and opens as a panel that changes nothing beside it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // One inset of 20 from the screen's edges: the chat button alone, 40 across in a pill of 48.
    assert.deepEqual(await boxOf(pill(page)), [1372, 832, 48, 48]);
    assert.deepEqual(await boxOf(chatButton(page)), [1376, 836, 40, 40]);
    const room = await boxOf(main(page));
    const look = () =>
      page.evaluate(() =>
        [document.querySelector("nav"), document.querySelector("main")].map((e) => {
          const style = getComputedStyle(e as Element);
          return [style.opacity, style.filter, style.pointerEvents, (e as HTMLElement).inert];
        }),
      );
    const undimmed = await look();

    await chatButton(page).click();
    // The panel: 420 wide, one inset from the top, the right and the foot.
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    assert.equal(await pill(page).count(), 0, "open, the panel stands for the collapsed chat");
    assert.deepEqual(await boxOf(main(page)), room, "the page keeps its room");
    assert.deepEqual(await look(), undimmed, "and isn't dimmed or put out of use");
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.equal(await focused(), "Chats", "the panel has the keyboard");

    // It closes by its own Close only: not Escape, not a press on the page, not going elsewhere.
    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await page.getByRole("tab", { name: "Skills" }).waitFor();
    await main(page).click({ position: { x: 300, y: 600 } });
    assert.deepEqual(await boxOf(panel(page)), [1000, 20, 420, 860]);
    await closeChats(page);
    await panel(page).waitFor({ state: "detached" });
    assert.deepEqual(await boxOf(pill(page)), [1372, 832, 48, 48], "back where it was");
    assert.equal(await chatButton(page).evaluate((e) => e === document.activeElement), true);
    await page.close();
  }),
);

test(
  "on a phone the panel takes the screen",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/", 390);
    await chatButton(page).click();
    assert.deepEqual(await boxOf(panel(page)), [0, 0, 390, 900]);
    await page.close();
  }),
);

test(
  "every agent's chats are one list, newest first: its agent, its last words or its problem; the rest are archived",
  withGateway(async (gateway) => {
    gateway.addChat("a-research", {
      id: "c-oldest",
      title: "Which issues are oldest?",
      said: [
        said("o1", "user", "Which issues are oldest?", 130),
        said("o2", "assistant", "The three oldest are **#212**, #240 and #251.\nMore below.", 120),
      ],
    });
    gateway.addChat("a-triage", {
      id: "c-route",
      title: "Route today's issues",
      said: [said("t1", "user", "Route today's issues", 60)],
    });
    // Research's last message got no answer.
    gateway.failChat("a-research", { code: "failed", message: "The model refused it." });
    gateway.addChat("a-research", {
      id: "c-kept",
      title: "An old question",
      said: [said("k1", "user", "An old question", 3000)],
      archived: true,
    });
    // Weekly report is stopped: its chat is read, among the archived ones.
    gateway.addChat("a-weekly", {
      id: "c-weekly",
      title: "Numbers for last week",
      said: [said("w1", "user", "Numbers for last week", 500)],
    });
    const page = await open(gateway);
    await listed(page, 4);
    const lines = async () =>
      (await rows(page).allInnerTexts()).map((text) => text.split("\n").filter(Boolean).slice(1));
    await until(lines, [
      ["Why are checkouts failing?", "Research", "The model refused it.", "8 min"],
      // The stand-in's Reviewer was never asked anything, so its chat has no title.
      ["Reviewer", "Reviewed #482 with 3 comments", "12 min"],
      ["Route today's issues", "Triage", "You: Route today's issues", "1 h"],
      ["Which issues are oldest?", "Research", "The three oldest are #212, #240 and #251.", "2 h"],
    ]);
    // A problem is said in the problem's colour, where the last words would be.
    const problem = rows(page).nth(0).getByText("The model refused it.");
    assert.notEqual(
      await problem.evaluate((e) => getComputedStyle(e).color),
      await rows(page)
        .nth(1)
        .getByText("Reviewed #482")
        .evaluate((e) => getComputedStyle(e).color),
    );
    // Rows are 68 tall, one under the other, 8 in from the panel's edges, under a head of 56.
    assert.deepEqual(await boxOf(rows(page).nth(0)), [1008, 76, 404, 68]);
    assert.deepEqual(await boxOf(rows(page).nth(1)), [1008, 144, 404, 68]);

    // The archived ones, and a stopped agent's, are behind Archived, which says how many.
    const archived = panel(page).getByRole("button", { name: /^Archived\s*2$/ });
    await archived.click();
    await panel(page).getByRole("heading", { name: "Archived" }).waitFor();
    assert.deepEqual(
      (await lines()).map((line) => line[0]),
      ["Numbers for last week", "An old question"],
    );
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page).getByRole("heading", { name: "Chats" }).waitFor();

    // What is said in a chat takes it to the top, with its words.
    await closeChats(page);
    await openNewest(page, "Reviewer");
    await panel(page).getByRole("textbox", { name: "Message" }).fill("Look at #490 too");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await rows(page).nth(0).getByText("You: Look at #490 too").waitFor();
    // The others stay as they were.
    assert.deepEqual((await lines())[3], [
      "Which issues are oldest?",
      "Research",
      "The three oldest are #212, #240 and #251.",
      "2 h",
    ]);
    await page.close();
  }),
);

test(
  "a reply you haven't read puts its chat's face behind the chat button and a mark on its row, until it has been on screen",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // What was said before this was first opened is read: nothing is new.
    await listed(page, 2);
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 0);
    await closeChats(page);
    assert.equal(await pill(page).getByRole("listitem").count(), 0);
    const first = reply("r9", "All clear on #482.");
    gateway.addMessage("a-reviewer", first);
    await pill(page).getByRole("button", { name: "Chats, 1 new" }).waitFor();
    assert.equal(await pill(page).getByRole("listitem").count(), 1);

    // Across a reload it is still new, and its row says so.
    await page.reload();
    await pill(page).getByRole("button", { name: "Chats, 1 new" }).click();
    const row = rows(page).filter({ hasText: "All clear on #482." });
    await row.getByRole("img", { name: "New" }).waitFor();
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 1);
    // Its title is heavier than a read one's.
    const weight = (which: Locator) =>
      which.locator("span.block").evaluate((e) => getComputedStyle(e).fontWeight);
    assert.deepEqual([await weight(row), await weight(rows(page).nth(1))], ["600", "500"]);

    // Shown, it is read, here and after a reload: the note says when, by agent and chat.
    await row.click();
    await panel(page).getByText("All clear on #482.").waitFor();
    // The row that was pressed is gone: the panel has the keyboard.
    assert.equal(await panel(page).evaluate((e) => e === document.activeElement), true);
    await closeChats(page);
    await pill(page).getByRole("button", { name: "Chats", exact: true }).waitFor();
    await until(() => noteAt(gateway), { "a-reviewer c-a-reviewer": first.at });
    const { since } = gateway.notes.get("ui/read") as { since: string };
    assert.ok(Date.parse(since) < Date.parse(first.at));
    await page.reload();
    await listed(page, 2);
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 0);
    await closeChats(page);

    // A face opens its agent's thread.
    gateway.addMessage("a-reviewer", reply("r10", "One more thing."));
    await pill(page)
      .getByRole("button", { name: /^Open/ })
      .click({ position: { x: 4, y: 20 } });
    await panel(page).getByText("One more thing.").waitFor();
    await page.close();
  }),
);

test(
  "two agents' chats of one id are two chats, each read by itself",
  withGateway(async (gateway) => {
    for (const [agent, title] of [
      ["a-research", "Research's first"],
      ["a-triage", "Triage's first"],
    ] as const)
      gateway.addChat(agent, { id: "first", title, said: [said(`${agent}-1`, "user", title, 90)] });
    const page = await open(gateway);
    gateway.sayIn("a-triage", "first", reply("f1", "Routed."));
    // Triage has a newer chat too: something was said in it after that.
    gateway.addMessage("a-triage", {
      id: "t-newer",
      role: "user",
      text: "Route today's issues",
      at: new Date(Date.now() + 1000).toISOString(),
    });
    await pill(page).getByRole("button", { name: "Chats, 1 new" }).click();
    await rows(page).nth(4).waitFor();
    assert.equal(await rows(page).filter({ hasText: "Research's first" }).count(), 1);
    const routed = rows(page).filter({ hasText: "Triage's first" });
    await routed.getByText("Routed.").waitFor();
    assert.equal(await routed.getByRole("img", { name: "New" }).count(), 1);
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 1);

    // A row opens the chat it names: Triage's, and not Research's of the same id, nor Triage's
    // newer one.
    await routed.click();
    await panel(page).getByRole("heading", { name: "Triage's first" }).waitFor();
    await panel(page).locator(".prose-chat").getByText("Routed.").waitFor();
    assert.equal(await panel(page).getByText("Route today's issues").count(), 0);
    // Shown, it is read.
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await routed.waitFor();
    await until(() => panel(page).getByRole("img", { name: "New" }).count(), 0);
    assert.deepEqual(Object.keys(noteAt(gateway) ?? {}), ["a-triage first"]);
    await page.close();
  }),
);

test(
  "an agent's chats past one page of its list are listed too",
  withGateway(async (gateway) => {
    for (let i = 0; i < 53; i++)
      gateway.addChat("a-research", {
        id: `c-old-${i}`,
        title: `Old ${i}`,
        said: [said(`old-${i}`, "user", `Old ${i}`, 5000 + i)],
        archived: true,
      });
    const page = await open(gateway);
    await chatButton(page).click();
    await panel(page)
      .getByRole("button", { name: /^Archived\s*53$/ })
      .click();
    await rows(page).nth(52).getByText("You: Old 52").waitFor();
    await page.close();
  }),
);

test(
  "what is read in one tab stays read when another tab reads something else",
  withGateway(async (gateway) => {
    const tabs = [await open(gateway), await open(gateway)] as const;
    const replies = [reply("r9", "All clear on #482."), reply("s9", "Checkout is fixed.")] as const;
    gateway.addMessage("a-reviewer", replies[0]);
    gateway.addMessage("a-research", replies[1]);
    // Each tab shows one of the two.
    for (const [i, name] of ["Reviewer", "Research"].entries()) {
      const tab = tabs[i] as Page;
      await pill(tab).getByRole("button", { name: "Chats, 2 new" }).waitFor();
      await openNewest(tab, name);
      await panel(tab)
        .getByText((replies[i] as { text: string }).text)
        .waitFor();
      await closeChats(tab);
      await pill(tab).getByRole("button", { name: "Chats, 1 new" }).waitFor();
    }
    await until(() => noteAt(gateway), {
      "a-reviewer c-a-reviewer": replies[0].at,
      "a-research c-a-research": replies[1].at,
    });
    await tabs[0].reload();
    await pill(tabs[0]).getByRole("button", { name: "Chats", exact: true }).waitFor();
    for (const tab of tabs) await tab.close();
  }),
);

test(
  "a note of what is read that can't be read is asked for again, and never written over",
  withGateway(async (gateway) => {
    const kept = { since: new Date().toISOString(), at: { "a-research c-a-research": "kept" } };
    gateway.notes.set("ui/read", kept);
    gateway.refuseNext("store.get.ui/read", "busy", "Too much at once.");
    const page = await open(gateway);
    const shown = reply("r9", "All clear on #482.");
    gateway.addMessage("a-reviewer", shown);
    // A reply shown before the note is read is marked once it is, beside what the note held.
    await openNewest(page, "Reviewer");
    await panel(page).getByText("All clear on #482.").waitFor();
    assert.deepEqual(gateway.notes.get("ui/read"), kept, "nothing is written until it is read");
    await until(() => gateway.notes.get("ui/read"), {
      since: kept.since,
      at: { ...kept.at, "a-reviewer c-a-reviewer": shown.at },
    });
    await page.close();
  }),
);

test(
  "a stored note of another shape is taken for none",
  withGateway(async (gateway) => {
    gateway.notes.set("ui/read", { "c-a-reviewer": "r9" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/`);
    await until(() => Object.keys(gateway.notes.get("ui/read") as object).sort(), ["at", "since"]);
    // A reply counts as new from the moment after the note is begun, not in that same moment.
    await noted(gateway);
    gateway.addMessage("a-reviewer", reply("r9", "All clear on #482."));
    await pill(page).getByRole("button", { name: "Chats, 1 new" }).waitFor();
    await page.close();
  }),
);

test(
  "the collapsed chat is one row of stacked icons: 64 wide at rest and 80 under the pointer, for any count of unread chats",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const still = [await boxOf(main(page)), await boxOf(chatButton(page))];
    const another = (agent: string, n: number) => {
      gateway.addChat(agent, { id: `c-more-${n}`, title: `Chat ${n}`, said: [] });
      gateway.sayIn(agent, `c-more-${n}`, reply(`n${n}`, "A reply."));
    };
    /** Where each icon starts, the chat button first, once the pill is `width` wide. */
    const lefts = async (width: number) => {
      // Once its width has stopped changing.
      await pill(page).evaluate(async (e) => {
        void getComputedStyle(e).width;
        await Promise.all(e.getAnimations().map((moving) => moving.finished));
      });
      assert.deepEqual(await boxOf(pill(page)), [1420 - width, 832, width, 48]);
      const faces = pill(page).getByRole("listitem");
      const at = [(await boxOf(chatButton(page)))[0] as number];
      for (let i = 0; i < (await faces.count()); i++)
        at.push((await boxOf(faces.nth(i)))[0] as number);
      return at;
    };
    const agents = ["a-reviewer", "a-research", "a-triage", "a-broken"];
    for (let unread = 1; unread <= 4; unread++) {
      const agent = agents[unread - 1] as string;
      if (unread <= 2) gateway.addMessage(agent, reply(`n${unread}`, "A reply."));
      else another(agent, unread);
      await pill(page)
        .getByRole("button", { name: `Chats, ${unread} new` })
        .waitFor();
      const shown = Math.min(unread, 3);
      assert.equal(await pill(page).getByRole("listitem").count(), shown, "three faces at most");
      for (const width of [64, 80]) {
        if (width === 80) await pill(page).hover({ position: { x: 60, y: 24 } });
        else await page.mouse.move(700, 300);
        // The chat button at the right inner edge, the last face at the left, equal steps between.
        const at = await lefts(width);
        assert.equal(at[0], 1376);
        assert.equal(at.at(-1), 1420 - width + 4);
        const step = (width - 48) / shown;
        for (let i = 1; i < at.length; i++)
          assert.ok(Math.abs((at[i - 1] as number) - (at[i] as number) - step) < 0.02, `${at}`);
        assert.deepEqual([await boxOf(main(page)), await boxOf(chatButton(page))], still);
      }
    }

    // A stopped agent's chat is among the archived ones: new there, and not counted here.
    another("a-weekly", 5);
    await chatButton(page).click();
    await panel(page)
      .getByRole("button", { name: /^Archived\s*1$/ })
      .click();
    await rows(page).nth(0).getByRole("img", { name: "New" }).waitFor();
    // Closed by the pointer, the chat button has the keyboard and the pill is at rest.
    await closeChats(page);
    await page.mouse.move(700, 300);
    await pill(page).getByRole("button", { name: "Chats, 4 new" }).waitFor();
    assert.equal(await chatButton(page).evaluate((e) => e === document.activeElement), true);
    assert.equal((await lefts(64)).length, 4);
    // Reached by the keyboard, it widens as under the pointer.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.equal((await lefts(80)).length, 4);

    // Asked for less motion, it changes width at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await pill(page).evaluate((e) => getComputedStyle(e).transitionDuration), "0s");
    await page.close();
  }),
);

test(
  "what arrives in the open chat is read as it comes",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openNewest(page, "Reviewer");
    gateway.addMessage("a-reviewer", reply("r9", "Looking now."));
    await panel(page).getByText("Looking now.").waitFor();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await rows(page).filter({ hasText: "Looking now." }).waitFor();
    assert.equal(await panel(page).getByRole("img", { name: "New" }).count(), 0);
    await closeChats(page);
    await pill(page).getByRole("button", { name: "Chats", exact: true }).waitFor();
    await page.close();
  }),
);

test(
  "half-typed text waits in its chat",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openNewest(page, "Reviewer");
    await panel(page).getByRole("textbox", { name: "Message" }).fill("half a thought");
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await rows(page).filter({ hasText: "Reviewer" }).click();
    assert.equal(
      await panel(page).getByRole("textbox", { name: "Message" }).inputValue(),
      "half a thought",
    );
    await page.close();
  }),
);

test(
  "the panel stays open across pages, and a deleted agent's chats go from the list",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openNewest(page, "Reviewer");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
    gateway.agents.delete("a-reviewer");
    gateway.changed();
    // Its thread goes too: the panel shows the list.
    await rows(page).filter({ hasText: "Research" }).waitFor();
    assert.equal(await rows(page).filter({ hasText: "Reviewer" }).count(), 0);
    await page.close();
  }),
);
