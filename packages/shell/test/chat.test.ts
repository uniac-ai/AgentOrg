// The chat page in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computerWith } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });

/** A signed-in page on an agent's page, with nothing open in the chat. */
async function visit(gateway: Gateway, agent: string, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/${agent}`);
  return page;
}
/** A signed-in page with Reviewer's chat open in the panel. */
async function open(gateway: Gateway, width = 1440): Promise<Page> {
  const page = await visit(gateway, "a-reviewer", width);
  await page.getByRole("button", { name: /^Chats/ }).click();
  await panel(page)
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: "Reviewer" })
    .click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
  await panel(page).locator(".prose-chat, .whitespace-pre-wrap").first().waitFor();
  return page;
}
const input = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
/** What the person said, in the thread: a chat's title may say the same words. */
const mine = (page: Page, text: string | RegExp) =>
  panel(page).locator(".whitespace-pre-wrap", { hasText: text });

/**
 * Nothing is shown under what the person said last while its work runs: no row, no word that it is
 * being worked on, and no problem. The agent's line says it works.
 */
async function nothingUnder(page: Page, text: string) {
  const items = panel(page).locator('[data-slot="message-scroller-item"]');
  await page
    .getByRole("main")
    .getByRole("status", { name: "State" })
    .getByText("Working")
    .waitFor();
  await page.waitForTimeout(300);
  assert.equal((await items.last().innerText()).trim(), text);
  assert.equal(await panel(page).getByRole("status").count(), 0);
  assert.equal(await panel(page).getByRole("alert").count(), 0);
}

const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Waits for what the stand-in will see, which nothing on the page shows. */
async function until(seen: () => boolean) {
  for (let i = 0; i < 100 && !seen(); i++) await new Promise((done) => setTimeout(done, 20));
  assert.ok(seen(), "it never happened");
}
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "Enter sends and empties the box, and Shift+Enter makes a new line",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("first line");
    await input(page).press("Shift+Enter");
    await input(page).pressSequentially("second line");
    assert.equal(await input(page).inputValue(), "first line\nsecond line");
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "not sent yet");
    await input(page).press("Enter");
    assert.equal(await input(page).inputValue(), "");
    await mine(page, /first line/).waitFor();
    await page.close();
  }),
);

test(
  "a sent message shows at once, once, and stays where it is when the record has it",
  withGateway(async (gateway) => {
    gateway.delaySends(1200);
    const page = await open(gateway);
    await input(page).fill("slow to record");
    await input(page).press("Enter");
    const sent = mine(page, "slow to record");
    await sent.waitFor();
    await page.waitForTimeout(400);
    const before = await sent.boundingBox();
    await page.waitForTimeout(1200);
    assert.equal(await sent.count(), 1, "never twice");
    assert.deepEqual(await sent.boundingBox(), before);
    await page.close();
  }),
);

test(
  "a refused send goes, and its text is back in the box",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "A turn is running.");
    const page = await open(gateway);
    await input(page).fill("refuse this");
    await input(page).press("Enter");
    await panel(page).getByRole("alert").getByText("A turn is running.").waitFor();
    assert.equal(await input(page).inputValue(), "refuse this");
    await page.close();
  }),
);

test(
  "a message longer than a message's text may be isn't sent: the box keeps it as it is, the line says why, and the next send clears it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // Its words are counted once trimmed, as the chat counts them.
    const long = `  ${"a".repeat(100_001)}\n`;
    await input(page).fill(long);
    await input(page).evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(7, 7));
    await input(page).press("Enter");
    await panel(page)
      .getByRole("alert")
      .getByText(
        "That's too long to send: a message can be at most 100,000 characters. This one has 100,001.",
      )
      .waitFor();
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "nothing sent");
    assert.equal(await input(page).inputValue(), long);
    assert.deepEqual(
      await input(page).evaluate((box: HTMLTextAreaElement) => [
        box.selectionStart,
        box.selectionEnd,
      ]),
      [7, 7],
    );
    // Shortened and sent, the line goes.
    await input(page).fill("a".repeat(100_000));
    await input(page).press("Enter");
    await panel(page).getByRole("alert").waitFor({ state: "detached" });
    await until(() => gateway.calls.some((c) => c.method === "send"));
    await page.close();
  }),
);

test(
  "a reply reveals word by word, then settles as one message with no spans",
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
    gateway.delta("a-reviewer", "r1", "Three causes ");
    await panel(page).locator("[data-sd-animate]").first().waitFor();
    gateway.delta("a-reviewer", "r1", "explain it.");
    await panel(page).getByText("explain it.").waitFor();
    gateway.addMessage("a-reviewer", reply("r1", "Three causes explain it."));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByText("Three causes explain it.").waitFor();
    assert.equal(await panel(page).getByText("Three causes explain it.").count(), 1);
    assert.equal(await panel(page).locator("[data-sd-animate]").count(), 0);
    await page.close();
  }),
);

test(
  "a chat is messages only: its button is always Send, with no Stop and no Retry, and a message goes while the agent works",
  withGateway(async (gateway) => {
    gateway.addMessage("a-reviewer", {
      id: "u1",
      role: "user",
      text: "Again",
      at: new Date().toISOString(),
    });
    gateway.addMessage("a-reviewer", reply("r2", "The old answer."));
    const page = await open(gateway);
    await panel(page).getByText("The old answer.").waitFor();
    // The agent works elsewhere: the newest thing said here is its reply, and nothing awaits one.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await input(page).fill("One more thing");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await mine(page, "One more thing").waitFor();
    await nothingUnder(page, "One more thing");
    await until(() =>
      gateway.calls.some((c) => c.method === "send" && c.input.text === "One more thing"),
    );
    // Still Send while it awaits the reply, and nothing stops or retries.
    await panel(page).getByRole("button", { name: "Send", exact: true }).waitFor();
    for (const name of ["Stop", "Retry"])
      assert.equal(await panel(page).getByRole("button", { name, exact: true }).count(), 0, name);
    await page.close();
  }),
);

test(
  "a message that got no answer says why in one line, until the chat's next reply",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.failChat("a-reviewer", { code: "failed", message: "The model refused it." });
    // One line in the problem's colour, with nothing to press: nothing here can be done about it.
    const said = panel(page).getByRole("alert");
    await said.getByText("The model refused it.").waitFor();
    assert.equal(await said.getByRole("button").count(), 0);
    await page.close();
    // The chat's entry says it too: it is there on a page opened late.
    const late = await visit(gateway, "a-reviewer");
    await late.getByRole("button", { name: /^Chats/ }).click();
    await panel(late)
      .getByRole("list", { name: "Chats" })
      .getByText("The model refused it.")
      .click();
    await panel(late).getByRole("alert").getByText("The model refused it.").waitFor();
    // Asked again, the chat awaits a reply and says no problem; failing again, it says it again.
    await input(late).fill("Try again");
    await input(late).press("Enter");
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    // Recorded, it still awaits its reply while the agent works: the problem stays away.
    await until(() =>
      gateway.calls.some((c) => c.method === "send" && c.input.text === "Try again"),
    );
    await panel(late).locator(".whitespace-pre-wrap", { hasText: "Try again" }).waitFor();
    await late.waitForTimeout(400);
    assert.equal(await panel(late).getByRole("alert").count(), 0);
    gateway.failChat("a-reviewer", { code: "failed", message: "The model refused it." });
    await panel(late).getByRole("alert").getByText("The model refused it.").waitFor();
    // Its next reply ends the problem.
    gateway.addMessage("a-reviewer", reply("r3", "Here it is."));
    await panel(late).getByText("Here it is.").waitFor();
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    await late.close();
  }),
);

test(
  "a message its work didn't answer says so, whatever the agent then does elsewhere",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("Is the branch pushed?");
    await input(page).press("Enter");
    await mine(page, "Is the branch pushed?").waitFor();
    // Its turn ends without a reply.
    gateway.failChat("a-reviewer", { code: "not_answered", message: "Not answered" });
    const line = panel(page).getByRole("alert");
    await line.getByText("Not answered").waitFor();
    // The agent works again, on something else: this conversation still says its message wasn't answered.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText("Working")
      .waitFor();
    await page.waitForTimeout(300);
    await line.getByText("Not answered").waitFor();
    await page.close();
  }),
);

test(
  "the plan's limit ends its line with the way to the plan's page; being signed out, or a refused send, with nothing",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const line = panel(page).getByRole("alert");
    gateway.failChat("a-reviewer", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await line.getByText("You've reached your plan's limit.").waitFor();
    // The plan's page is ChatGPT's own: it is answered here, so the test goes nowhere else.
    await page
      .context()
      .route("https://chatgpt.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<title>Usage</title>" }),
      );
    const opened = page.context().waitForEvent("page");
    await line.getByRole("button", { name: "Manage usage" }).click();
    await (await opened).waitForURL(/chatgpt\.com\/settings\/usage/);
    // Signing in isn't offered from the line.
    gateway.failChat("a-reviewer", { code: "not_signed_in", message: "Sign in to go on." });
    await line.getByText("Sign in to go on.").waitFor();
    assert.equal(await line.getByRole("button").count(), 0);
    // A send that was refused has no fix either, whatever the chat's problem is.
    gateway.failChat("a-reviewer", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await line.getByRole("button", { name: "Manage usage" }).waitFor();
    gateway.refuseNext("chat.send", "unavailable", "It can't take that now.");
    await input(page).fill("Try again");
    await input(page).press("Enter");
    await line.getByText("It can't take that now.").waitFor();
    assert.equal(await line.getByRole("button").count(), 0);
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
  "a stopped agent's chat is for reading: it has no composer until the agent starts",
  withGateway(async (gateway) => {
    gateway.converse("a-weekly", [reply("w1", "Signups were up 4%.")]);
    const page = await visit(gateway, "a-weekly");
    // Its own page still lists your conversation with it; Message waits for it to start.
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats with Weekly report" })
      .getByText("Signups were up 4%.")
      .waitFor();
    const chat = page.getByRole("main").getByRole("button", { name: "Message", exact: true });
    assert.equal(await chat.isDisabled(), true);
    // It stays in the list, to be read.
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page)
      .getByRole("list", { name: "Chats" })
      .getByRole("button")
      .filter({ hasText: "Weekly report" })
      .click();
    await panel(page).getByText("Signups were up 4%.").waitFor();
    assert.equal(await input(page).count(), 0);
    // The panel lies over the page's right side: closed, the page's own controls are in reach.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page
      .getByRole("status", { name: "State" })
      .getByRole("button", { name: "Start" })
      .click();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("heading", { name: "Weekly report" }).waitFor();
    await input(page).waitFor();
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
  "Message opens your conversation with the agent, empty until its first message makes it, and every message goes on in it",
  withGateway(async (gateway) => {
    assert.deepEqual(gateway.chatOf("a-triage").messages, [], "Triage has no conversation yet");
    const page = await visit(gateway, "a-triage");
    const message = page.getByRole("main").getByRole("button", { name: "Message", exact: true });
    await message.click();
    // Its head is the agent, and there is nobody to pick.
    await panel(page).getByRole("heading", { name: "Triage" }).waitFor();
    assert.equal(await panel(page).getByRole("list", { name: "Who with" }).count(), 0);
    assert.equal(await panel(page).locator('[data-slot="message-scroller-item"]').count(), 0);
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    await mine(page, "Route today's issues").waitFor();
    gateway.addMessage("a-triage", reply("t1", "Routed seven."));
    gateway.setChatStatus("a-triage", { state: "idle" });
    await panel(page).getByText("Routed seven.").waitFor();
    // Begun, it is the same view: the box has kept the keyboard.
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Message",
    );
    await input(page).fill("And yesterday's?");
    await input(page).press("Enter");
    await mine(page, "And yesterday's?").waitFor();
    await until(() => gateway.calls.filter((c) => c.method === "send").length === 2);
    assert.deepEqual(gateway.chatOf("a-triage").messages, [
      "Route today's issues",
      "Routed seven.",
      "And yesterday's?",
    ]);
    // No message names a conversation: the agent knows whose it is.
    assert.deepEqual(
      gateway.calls.filter((c) => c.method === "send").map((c) => Object.keys(c.input)),
      [["text"], ["text"]],
    );
    // Message again is the same conversation, and the list has one row for the agent.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await message.click();
    await mine(page, "Route today's issues").waitFor();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    const listed = panel(page).getByRole("list", { name: "Chats" }).getByRole("button");
    await listed.filter({ hasText: "Triage" }).waitFor();
    assert.equal(await listed.filter({ hasText: "Triage" }).count(), 1);
    await page.close();
  }),
);

test(
  "a conversation not yet begun has its agent's computer in its head, its name on the line a begun one has",
  withGateway(async (gateway) => {
    gateway.noChats();
    computerWith(gateway, "terminal");
    const page = await visit(gateway, "a-research");
    await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
    // Not begun, the name is the head's own heading; begun, it heads a block of its own. Each is
    // read once it is there, since beginning replaces the one with the other.
    const lineOf = async (selector: string) => {
      const head = panel(page).locator(selector, { hasText: "Research" });
      await head.waitFor();
      return head.evaluate((h) => getComputedStyle(h).lineHeight);
    };
    assert.equal(await lineOf("header > h2"), "20px");
    const computer = panel(page).getByRole("button", { name: "Research's computer" });
    await computer.click();
    assert.equal(await computer.getAttribute("aria-pressed"), "true");
    await input(page).fill("Why are checkouts failing?");
    await input(page).press("Enter");
    await mine(page, "Why are checkouts failing?").waitFor();
    assert.equal(await lineOf("header > div > h2"), "20px");
    await page.close();
  }),
);

test(
  "a first message that is refused stays in the box, with the reason",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "It can't take that now.");
    const page = await visit(gateway, "a-triage");
    await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    await panel(page).getByRole("alert").getByText("It can't take that now.").waitFor();
    assert.equal(await input(page).inputValue(), "Route today's issues");
    await panel(page).getByRole("heading", { name: "Triage" }).waitFor();
    await page.close();
  }),
);

test(
  "what the agent says with another party stays out of your conversation, and out of the list",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.addMessage("a-reviewer", reply("r3", "Said to you."));
    await panel(page).getByText("Said to you.").waitFor();
    // Its conversation with another agent speaks last, then yours streams: by then both readers
    // have heard it.
    gateway.sayWith("a-reviewer", "a-research", reply("x1", "Said to Research."));
    gateway.delta("a-reviewer", "x2", "Writing to Research", "a-research");
    gateway.delta("a-reviewer", "r4", "Still writing");
    await panel(page).getByText("Still writing").waitFor();
    assert.equal(await panel(page).getByText("Said to Research.").count(), 0);
    assert.equal(await panel(page).getByText("Writing to Research").count(), 0);
    await panel(page).getByRole("button", { name: "All chats" }).click();
    const listed = panel(page).getByRole("list", { name: "Chats" });
    await listed.getByText("Said to you.").waitFor();
    assert.equal(await listed.getByText("Said to Research.").count(), 0);
    assert.equal(await listed.getByRole("button").filter({ hasText: "Reviewer" }).count(), 1);
    await page.close();
  }),
);

test(
  "an agent's conversations with other agents are on both their pages, named by the other, and read in the chat with nothing to write in",
  withGateway(async (gateway) => {
    gateway.sayWith("a-reviewer", "a-research", {
      id: "q1",
      role: "user",
      text: "Which changes touched checkout?",
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    gateway.sayWith("a-reviewer", "a-research", reply("q2", "28 of the 62."));
    // One with a party that is no agent here is left out.
    gateway.sayWith("a-reviewer", "management", reply("q3", "Said to nobody here."));
    // Research has one of its own with Reviewer too: a second conversation, the other way.
    gateway.sayWith("a-research", "a-reviewer", {
      id: "p1",
      role: "user",
      text: "Is #482 merged?",
      at: new Date(Date.now() - 120_000).toISOString(),
    });
    const page = await visit(gateway, "a-reviewer");
    const others = (name: string) =>
      page.getByRole("main").getByRole("list", { name: `${name}'s chats with other agents` });
    await others("Reviewer").getByRole("button").filter({ hasText: "28 of the 62." }).waitFor();
    // Its own with Research, and Research's with it.
    await others("Reviewer").getByRole("button").nth(1).waitFor();
    assert.deepEqual(
      (await others("Reviewer").getByRole("button").allInnerTexts()).map((row) =>
        row.split("\n").filter(Boolean).slice(1, 3),
      ),
      [
        ["Research", "28 of the 62."],
        ["Research", "Is #482 merged?"],
      ],
    );
    // A reply between agents is not yours to read: nothing is new, there or in the chat.
    gateway.sayWith("a-reviewer", "a-research", reply("q5", "One more thing."));
    await others("Reviewer").getByText("One more thing.").waitFor();
    assert.equal(await others("Reviewer").getByRole("img", { name: "New" }).count(), 0);
    await page.getByRole("button", { name: "Chats", exact: true }).waitFor();
    // The other agent's page lists it too, by the agent it is with.
    await page.goto(`${gateway.url}/#/a/a-research/chats`);
    const row = others("Research").getByRole("button").filter({ hasText: "One more thing." });
    await row.getByText("Reviewer").waitFor();
    await row.click();
    await panel(page).getByRole("heading", { name: "Reviewer and Research" }).waitFor();
    await panel(page).getByText("You can read it, not write in it").waitFor();
    // Who asked is said above what they asked; there is no box.
    const asked = panel(page).locator('[data-slot="message-scroller-item"]').first();
    assert.deepEqual((await asked.innerText()).split("\n").filter(Boolean), [
      "Research",
      "Which changes touched checkout?",
    ]);
    await panel(page).getByText("28 of the 62.").waitFor();
    assert.equal(await input(page).count(), 0);
    const read = gateway.calls.find((c) => c.method === "history" && c.input.with);
    assert.equal(read?.input.with, "a-research");
    // What comes in it shows as it comes; what is said to you doesn't.
    gateway.delta("a-reviewer", "q4", "Three touch the retry path.", "a-research");
    gateway.delta("a-reviewer", "r9", "Said to you.");
    await panel(page).getByText("Three touch the retry path.").waitFor();
    assert.equal(await panel(page).getByText("Said to you.").count(), 0);
    // Reading it marks nothing of yours as read.
    const note = gateway.notes.get("ui/read-conversations") as { at: Record<string, string> };
    assert.deepEqual(Object.keys(note?.at ?? {}), []);
    // With an agent of it gone, the chat shows the list.
    gateway.agents.delete("a-research");
    gateway.changed();
    await panel(page).getByRole("list", { name: "Chats" }).waitFor();
    await page.close();
  }),
);

test(
  "search in the bar finds agents, not what was said to them",
  withGateway(async (gateway) => {
    gateway.converse("a-research", [reply("o1", "The three oldest are #212, #240 and #251.")]);
    const page = await visit(gateway, "a-reviewer");
    const bar = page.getByRole("navigation", { name: "Main" });
    await bar.getByRole("searchbox", { name: "Search" }).fill("oldest");
    await page.waitForTimeout(300);
    assert.equal(await bar.getByRole("list", { name: "Chats found" }).count(), 0);
    await page.close();
  }),
);

test(
  "the chat opens on what it showed last, its face goes to its agent's page, and nothing in it starts, renames or archives a chat",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
    // Its head is the agent, with nothing to rename or archive.
    await panel(page).getByRole("heading", { name: "Reviewer" }).waitFor();
    assert.equal(await panel(page).getByRole("button", { name: "Chat options" }).count(), 0);
    // The face in a conversation's head is its agent: its page, with the chat out of the way.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await panel(page).getByRole("button", { name: "Reviewer's page" }).click();
    await page.waitForURL(/#\/a\/a-reviewer$/);
    await panel(page).waitFor({ state: "detached" });
    // The list starts nothing and keeps nothing archived: an agent is messaged from its page.
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page).getByRole("list", { name: "Chats" }).waitFor();
    assert.equal(await panel(page).getByRole("button", { name: "New chat" }).count(), 0);
    assert.equal(
      await panel(page)
        .getByRole("button", { name: /^Archived/ })
        .count(),
      0,
    );
    await page.close();
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

    // Its words pass the foot of the room as they come: what is shown stays at the last of them.
    await write("long", lines(0, 60));
    await panel(page).getByText("Finding 59 is").waitFor();
    await atEnd("the end is in view while it is written");
    gateway.addMessage("a-reviewer", reply("long", lines(0, 60).join("\n\n")));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).locator("[data-sd-animate]").first().waitFor({ state: "detached" });
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
    await panel(page).getByText("Finding 79 is").waitFor({ state: "attached" });
    await page.waitForTimeout(400);
    assert.ok((await short()) >= left, "nothing pulled it back to the end");
    // The way back is theirs to press, and from the end it is followed again.
    await panel(page).getByRole("button", { name: "Scroll to end" }).click();
    await page.waitForFunction(
      (view) => !!view && view.scrollHeight - view.scrollTop - view.clientHeight <= 8,
      await room.elementHandle(),
    );
    await write("more", lines(80, 100));
    await panel(page).getByText("Finding 99 is").waitFor();
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

test(
  "a reply in which nothing was said has nothing to copy",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("Read the issue.");
    await input(page).press("Enter");
    await mine(page, "Read the issue.").waitFor();
    // A reply with no words, as an earlier reply read as sent can be.
    const items = panel(page).locator('[data-slot="message-scroller-item"]');
    const before = await items.count();
    gateway.addMessage("a-reviewer", reply("r-none", ""));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-slot="message-scroller-item"]').length === n,
      before + 1,
    );
    // It is the last reply, whose Copy is seen without pointing at it: this one has none.
    const turn = items.last();
    const copy = turn.getByRole("button", { name: "Copy" });
    assert.equal(await copy.count(), 0);
    await turn.hover();
    assert.equal(await copy.count(), 0, "nor when it is pointed at");
    // A reply with words has one, as before.
    gateway.addMessage("a-reviewer", reply("r-said", "It is a duplicate of #3."));
    await panel(page)
      .locator('[data-slot="message-scroller-item"]')
      .filter({ hasText: "It is a duplicate of #3." })
      .getByRole("button", { name: "Copy" })
      .waitFor();
    await page.close();
  }),
);
