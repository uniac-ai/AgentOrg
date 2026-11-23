// Which conversation the chat shows, in a real browser over the stand-in gateway: a stopped agent's,
// one begun from Message, another party's kept apart, and the one it showed last.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import { input, mine, open, panel, reply, until, visit, withGateway } from "./chat-kit.ts";
import { computerWith } from "./design/samples.ts";

withBrowser();

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
    // Its conversation with another agent speaks, then yours: by then both readers have heard it.
    gateway.sayWith("a-reviewer", "a-research", reply("x1", "Said to Research."));
    gateway.addMessage("a-reviewer", reply("r4", "Said to you again."));
    await panel(page).getByText("Said to you again.").waitFor();
    assert.equal(await panel(page).getByText("Said to Research.").count(), 0);
    await panel(page).getByRole("button", { name: "All chats" }).click();
    const listed = panel(page).getByRole("list", { name: "Chats" });
    await listed.getByText("Said to you again.").waitFor();
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
    gateway.addMessage("a-reviewer", reply("r9", "Said to you."));
    gateway.sayWith("a-reviewer", "a-research", reply("q4", "Three touch the retry path."));
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
  "the chat opens on what it showed last, its face goes to its agent's details, and nothing in it starts, renames or archives a chat",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
    // Its head is the agent, with nothing to rename or archive.
    await panel(page).getByRole("heading", { name: "Reviewer" }).waitFor();
    assert.equal(await panel(page).getByRole("button", { name: "Chat options" }).count(), 0);
    // The face in a conversation's head is its agent: its details, with the chat out of the way.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Team" })
      .click();
    await page.waitForURL(/#\/team$/);
    await panel(page).getByRole("button", { name: "Reviewer's details" }).click();
    await page.waitForURL(/#\/team\/a-reviewer$/);
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
