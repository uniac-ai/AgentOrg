// Deleting a chat, in a real browser over the stand-in gateway: "Delete chat" is the last item of a
// conversation's menu, by a right-click and by its row's "⋯". It takes the conversation off the
// list and clears nothing; which are off is kept in the app's store. One comes back when it is
// opened again, or when something is said in it; a pinned one leaves the tiles; and with the open
// one deleted, the page moves on.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { withBrowser, withGateway } from "./build-kit.ts";
import {
  chatsOf,
  choose,
  floating,
  one,
  open,
  PINS,
  rowNames,
  said,
  tileNames,
  until,
} from "./chat-list-kit.ts";

withBrowser();

/** Where the conversations taken off the list are kept in the app's store. */
const HIDDEN = "ui/hidden-conversations";
const conversation = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name: `Conversation with ${name}` });
/** The agents whose conversations the store has as taken off the list. */
const hidden = (gateway: { notes: Map<string, unknown> }) =>
  Object.keys((gateway.notes.get(HIDDEN) as Record<string, string> | undefined) ?? {});
/** Deletes a conversation from its menu, opened by a right-click. */
const remove = (page: Page, list: Locator, name: string, pinned = false) =>
  choose(page, one(list, name), pinned ? "Unpin" : "Pin", "Delete chat");

test(
  "Delete chat is the last item of a row's menu, set apart and in the colour of what takes something away; it takes the row off the list and clears nothing, the agent stays on Team, and it is still off after a reload",
  withGateway(async (gateway) => {
    // An agent that is gone is kept as taken off no longer, once the store is next written.
    gateway.notes.set(HIDDEN, { "a-gone": "2026-01-01T00:00:00Z" });
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    const before = gateway.chatOf("a-reviewer").messages;
    await one(list, "Reviewer").click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Pin", "Delete chat"]);
    const drawn = await menu.evaluate((root) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--bad)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      const last = root.lastElementChild as Element;
      return {
        apart: last.previousElementSibling?.getAttribute("role"),
        inColour: getComputedStyle(last).color === colour,
        others: getComputedStyle(root.firstElementChild as Element).color === colour,
      };
    });
    assert.deepEqual(drawn, { apart: "separator", inColour: true, others: false });
    await menu.getByRole("menuitem", { name: "Delete chat" }).click();
    await until(() => rowNames(list), ["Research"]);
    await until(() => hidden(gateway), ["a-reviewer"]);
    // Nothing was asked first, nothing said in it is gone, and the agent was not deleted.
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(gateway.chatOf("a-reviewer").messages, before);
    assert.equal(
      gateway.calls.some((call) => call.slot === "agents" && call.method === "remove"),
      false,
    );
    // The open conversation is the one it was.
    assert.match(page.url(), /#\/chat\/a-research$/);
    await page.reload();
    await until(() => rowNames(list), ["Research"]);
    await page.goto(`${gateway.url}/#/team`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Agents" })
      .getByRole("button", { name: /Reviewer/ })
      .waitFor();
    await page.close();
  }),
);

test(
  "a row's \"⋯\" deletes it too, and the keyboard is then on the row that follows; the floating chat's list deletes, and is the same list",
  withGateway(async (gateway) => {
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-02T10:00:00Z")]);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer", "Triage"]);
    await one(list, "Reviewer").hover();
    await list.getByRole("button", { name: "More for Reviewer" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Pin", "Delete chat"]);
    await menu.getByRole("menuitem", { name: "Delete chat" }).click();
    await until(() => rowNames(list), ["Research", "Triage"]);
    await until(
      () =>
        page.evaluate(() =>
          document.activeElement?.closest("li[data-chat]")?.getAttribute("data-chat"),
        ),
      "a-triage",
    );
    await until(() => hidden(gateway), ["a-reviewer"]);
    // On Team, the chat at the right lists what the page listed, and deletes from its own menu.
    await page.goto(`${gateway.url}/#/team`);
    await page.getByRole("button", { name: /^Chats/ }).click();
    const beside = floating(page);
    await until(() => rowNames(beside), ["Research", "Triage"]);
    await remove(page, beside, "Triage");
    await until(() => rowNames(beside), ["Research"]);
    await until(() => hidden(gateway).sort(), ["a-reviewer", "a-triage"]);
    await page.close();
  }),
);

test(
  "a deleted chat comes back when it is opened again, from the picker, from an address or from its agent's page, with everything that was said in it; then the store no longer has it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    /** What Reviewer said last, as its conversation shows it. */
    const last = "#482 with 3 comments";
    const kept = gateway.chatOf("a-reviewer").messages;
    for (const reopen of [
      // The "To" picker, from the list's plus.
      async () => {
        await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "Message" });
        await picker.getByRole("option", { name: "Reviewer" }).click();
      },
      // An address that names it.
      () => page.goto(`${gateway.url}/#/chat/a-reviewer`),
    ]) {
      await remove(page, list, "Reviewer");
      await until(() => rowNames(list), ["Research"]);
      await until(() => hidden(gateway), ["a-reviewer"]);
      await reopen();
      await conversation(page, "Reviewer").getByText(last).first().waitFor();
      await until(() => rowNames(list), ["Research", "Reviewer"]);
      await until(() => hidden(gateway), []);
      await page.goto(`${gateway.url}/#/chat/a-research`);
      await until(() => rowNames(list), ["Research", "Reviewer"]);
    }
    // Its agent's page has the way to message it in its row's place, and that brings it back.
    await remove(page, list, "Reviewer");
    await until(() => hidden(gateway), ["a-reviewer"]);
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats with Reviewer" })
      .getByRole("button", { name: "Message Reviewer" })
      .click();
    await page.getByRole("complementary", { name: "Chats" }).getByText(last).first().waitFor();
    await until(() => hidden(gateway), []);
    assert.deepEqual(gateway.chatOf("a-reviewer").messages, kept);
    await page.close();
  }),
);

test(
  "a deleted chat comes back when something is said in it, marked as new, and the store no longer has it",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    await remove(page, list, "Reviewer");
    await until(() => rowNames(list), ["Research"]);
    await until(() => hidden(gateway), ["a-reviewer"]);
    gateway.addMessage(
      "a-reviewer",
      said("r-late", "One more comment on #482.", new Date(Date.now() + 1000).toISOString()),
    );
    await until(() => rowNames(list), ["Reviewer", "Research"]);
    await one(list, "Reviewer").getByText("One more comment on #482.").waitFor();
    await one(list, "Reviewer").getByRole("img", { name: "New" }).waitFor();
    await until(() => hidden(gateway), []);
    // It is on the list after a reload too.
    await page.reload();
    await until(() => rowNames(list), ["Reviewer", "Research"]);
    await page.close();
  }),
);

test(
  "a pinned chat's menu deletes it too: it leaves the tiles and is pinned no longer",
  withGateway(async (gateway) => {
    gateway.notes.set(PINS, ["a-reviewer"]);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => tileNames(list), ["Reviewer"]);
    await remove(page, list, "Reviewer", true);
    await until(() => list.getByRole("list", { name: "Pinned" }).count(), 0);
    assert.deepEqual(await rowNames(list), ["Research"]);
    await until(() => gateway.notes.get(PINS), []);
    await until(() => hidden(gateway), ["a-reviewer"]);
    // Opened again, it is a row: it is not pinned again.
    await page.goto(`${gateway.url}/#/chat/a-reviewer`);
    await until(() => rowNames(list), ["Research", "Reviewer"]);
    assert.equal(await list.getByRole("list", { name: "Pinned" }).count(), 0);
    await page.close();
  }),
);

test(
  "with the open chat deleted the page opens the one after it, or the one before when it was the last; with none left the list says so, nothing is open, and no agent's empty conversation is opened in its place",
  withGateway(async (gateway) => {
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-02T10:00:00Z")]);
    const page = await open(gateway, "#/chat/a-research");
    const list = chatsOf(page);
    await until(() => rowNames(list), ["Research", "Reviewer", "Triage"]);
    await conversation(page, "Research").waitFor();
    // The first of three: the one after it.
    await remove(page, list, "Research");
    await page.waitForURL(/#\/chat\/a-reviewer$/);
    await conversation(page, "Reviewer").waitFor();
    await until(() => rowNames(list), ["Reviewer", "Triage"]);
    // The last of two: the one before it.
    await one(list, "Triage").click();
    await conversation(page, "Triage").waitFor();
    await remove(page, list, "Triage");
    await page.waitForURL(/#\/chat\/a-reviewer$/);
    await conversation(page, "Reviewer").waitFor();
    // The only one: none.
    await remove(page, list, "Reviewer");
    await page.waitForURL(/#\/chat$/);
    const region = page.getByRole("main").getByRole("region", { name: "Chats" });
    await region.getByText("No chats", { exact: true }).waitFor();
    const any = page.getByRole("main").getByRole("region", { name: /^Conversation with / });
    await until(() => any.count(), 0);
    await until(() => hidden(gateway).sort(), ["a-research", "a-reviewer", "a-triage"]);
    await page.reload();
    await region.getByText("No chats", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await any.count(), 0);
    assert.deepEqual(hidden(gateway).sort(), ["a-research", "a-reviewer", "a-triage"]);
    await page.close();
  }),
);

test(
  "until the store says which chats are deleted none is listed, so the page never opens a deleted one in the meantime and brings it back",
  withGateway(async (gateway) => {
    // Research's, the most recent and so the one the page would open, was deleted.
    gateway.notes.set(HIDDEN, { "a-research": new Date().toISOString() });
    gateway.refuseNext(`store.get.${HIDDEN}`, "busy", "Too much at once.");
    const page = await open(gateway, "#/chat");
    const list = chatsOf(page);
    // The store is asked again after five seconds. Until it answers, long after the agents'
    // conversations are read, nothing is listed or open.
    await page.waitForTimeout(2500);
    assert.equal(await list.count(), 0);
    const any = page.getByRole("main").getByRole("region", { name: /^Conversation with / });
    assert.equal(await any.count(), 0);
    await until(() => rowNames(list), ["Reviewer"]);
    await conversation(page, "Reviewer").waitFor();
    assert.deepEqual(hidden(gateway), ["a-research"]);
    await page.close();
  }),
);

test(
  "a chat deleted in one tab is kept off when another tab, open since before it, deletes another",
  withGateway(async (gateway) => {
    gateway.converse("a-triage", [said("t", "Routed seven.", "2026-01-02T10:00:00Z")]);
    const first = await open(gateway, "#/chat/a-research");
    await until(() => rowNames(chatsOf(first)), ["Research", "Reviewer", "Triage"]);
    const second = await open(gateway, "#/chat/a-research");
    await until(() => rowNames(chatsOf(second)), ["Research", "Reviewer", "Triage"]);
    await remove(second, chatsOf(second), "Reviewer");
    await until(() => hidden(gateway), ["a-reviewer"]);
    await remove(first, chatsOf(first), "Triage");
    await until(() => hidden(gateway).sort(), ["a-reviewer", "a-triage"]);
    await until(() => rowNames(chatsOf(first)), ["Research"]);
    await first.close();
    await second.close();
  }),
);
