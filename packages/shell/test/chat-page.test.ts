// The chat page in a real browser, over the stand-in gateway: your conversations at the left and
// the open one beside them, or one at a time where there is no room for both.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computerWith, noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

const WIDE = 1440;
/** Narrower than the page holds its list and a conversation side by side. */
const NARROW = 800;
const PHONE = 390;

async function open(gateway: Gateway, hash = "#/chat", width = WIDE): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  await noted(gateway);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** The page's list of your conversations. */
const list = (page: Page) => page.getByRole("main").getByRole("region", { name: "Chats" });
const rows = (page: Page) => list(page).getByRole("list", { name: "Chats" }).getByRole("button");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
/** The agents the rows name, top to bottom: each row's face comes first, then its name. */
const names = async (page: Page) =>
  (await rows(page).allInnerTexts()).map((text) => text.split("\n").filter(Boolean)[1]);
/** The open conversation, on the page. */
const conversation = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name: `Conversation with ${name}` });
const anyConversation = (page: Page) =>
  page.getByRole("main").getByRole("region", { name: /^Conversation with / });
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});
/** Waits for what the page will come to, which arrives a call at a time. */
async function until<T>(read: () => Promise<T> | T, expected: T) {
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

test(
  "wide, the chat page lists your conversations newest first, opens on the most recent, and marks its row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await until(() => names(page), ["Research", "Reviewer"]);
    await conversation(page, "Research").getByRole("heading", { name: "Research" }).waitFor();
    assert.equal(await row(page, "Research").getAttribute("aria-current"), "true");
    assert.equal(await row(page, "Reviewer").getAttribute("aria-current"), null);
    // A row opens its conversation beside the list, and is marked in its place.
    await row(page, "Reviewer").click();
    await page.waitForURL(/#\/chat\/a-reviewer$/);
    await conversation(page, "Reviewer").getByText("Reviewed").waitFor();
    assert.equal(await row(page, "Reviewer").getAttribute("aria-current"), "true");
    assert.equal(await row(page, "Research").getAttribute("aria-current"), null);
    // The list stays beside it, with no way back to it and no close.
    assert.equal(
      await conversation(page, "Reviewer").getByRole("button", { name: "All chats" }).count(),
      0,
    );
    assert.equal(
      await conversation(page, "Reviewer").getByRole("button", { name: "Close chats" }).count(),
      0,
    );
    await page.close();
  }),
);

test(
  "the chat page stays on its conversation while another gets a reply, which shows as new on its row; a reply in the open one is read",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const research = conversation(page, "Research");
    await research.getByText("Why are checkouts failing?").waitFor();
    // Reviewer replies: its row comes to the top and says it's new; Research stays open.
    gateway.addMessage("a-reviewer", reply("v-new", "Two more comments on #482."));
    await until(() => names(page), ["Reviewer", "Research"]);
    await row(page, "Reviewer").getByRole("img", { name: "New" }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await research.count(), 1);
    assert.equal(await row(page, "Research").getAttribute("aria-current"), "true");
    // Research replies where it is open: read as it shows, so its row says nothing new.
    gateway.addMessage("a-research", reply("r-new", "Found it: the retry reuses the session."));
    await research.getByText("Found it: the retry reuses the session.").waitFor();
    await until(() => names(page), ["Research", "Reviewer"]);
    await page.waitForTimeout(300);
    assert.equal(await row(page, "Research").getByRole("img", { name: "New" }).count(), 0);
    assert.equal(await row(page, "Reviewer").getByRole("img", { name: "New" }).count(), 1);
    await page.close();
  }),
);

test(
  "a message sent from the chat page is recorded, and its reply arrives there",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/chat/a-reviewer");
    const reviewer = conversation(page, "Reviewer");
    const box = reviewer.getByRole("textbox", { name: "Message" });
    await box.fill("Is #482 ready to merge?");
    await box.press("Enter");
    await until(() => gateway.chatOf("a-reviewer").messages.at(-1), "Is #482 ready to merge?");
    await reviewer.getByText("Is #482 ready to merge?").waitFor();
    gateway.addMessage("a-reviewer", reply("v-yes", "Yes, once the coupon test passes."));
    await reviewer.getByText("Yes, once the coupon test passes.").waitFor();
    await page.close();
  }),
);

test(
  "an address naming an agent opens your conversation with it, empty with its box until begun; one naming an agent that isn't there shows the list",
  withGateway(async (gateway) => {
    let page = await open(gateway, "#/chat/a-triage");
    const triage = conversation(page, "Triage");
    await triage.getByRole("textbox", { name: "Message" }).waitFor();
    assert.equal(await triage.locator('[data-slot="message-scroller-item"]').count(), 0);
    // Not begun, it has no row to mark.
    await until(() => names(page), ["Research", "Reviewer"]);
    assert.equal(await rows(page).and(page.locator('[aria-current="true"]')).count(), 0);
    await page.close();

    page = await open(gateway, "#/chat/a-nobody", NARROW);
    await until(() => names(page), ["Research", "Reviewer"]);
    assert.equal(await anyConversation(page).count(), 0);
    await page.close();
  }),
);

for (const [where, width] of [
  ["narrower", NARROW],
  ["on a phone", PHONE],
] as const)
  test(
    `${where}, the chat page shows its list first, a row opens its conversation alone, and the way back returns to the list`,
    withGateway(async (gateway) => {
      const page = await open(gateway, "#/chat", width);
      await until(() => names(page), ["Research", "Reviewer"]);
      assert.equal(await anyConversation(page).count(), 0);
      await row(page, "Reviewer").click();
      await conversation(page, "Reviewer").getByText("Reviewed").waitFor();
      assert.equal(await list(page).count(), 0);
      await conversation(page, "Reviewer").getByRole("button", { name: "All chats" }).click();
      await page.waitForURL(/#\/chat$/);
      await row(page, "Reviewer").waitFor();
      assert.equal(await anyConversation(page).count(), 0);
      await page.close();
    }),
  );

test(
  "the floating chat isn't on the chat page, neither its button nor its panel, and is on another page as it was",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const pill = page.getByRole("group", { name: "Chats, collapsed" });
    const panel = page.getByRole("complementary", { name: "Chats" });
    await pill.getByRole("button", { name: /^Chats/ }).click();
    await panel.waitFor();
    await page.evaluate(() => {
      location.hash = "#/chat";
    });
    await conversation(page, "Research").waitFor();
    assert.equal(await panel.count(), 0);
    assert.equal(await pill.count(), 0);
    await page.evaluate(() => {
      location.hash = "#/a/a-reviewer";
    });
    await panel.waitFor();
    await page.close();
  }),
);

test(
  "on the chat page a conversation's face goes to its agent's page, and its computer button opens the agent's computer",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal");
    const page = await open(gateway);
    const research = conversation(page, "Research");
    await research.getByRole("button", { name: "Research's computer" }).click();
    const shown = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await shown.getByRole("button", { name: "Close Research's computer" }).click();
    await shown.waitFor({ state: "detached" });
    await research.getByRole("button", { name: "Research's page" }).click();
    await page.waitForURL(/#\/a\/a-research$/);
    // The face leaves the floating chat as it was: collapsed.
    assert.equal(await page.getByRole("complementary", { name: "Chats" }).count(), 0);
    await page.getByRole("group", { name: "Chats, collapsed" }).waitFor();
    await page.close();
  }),
);

test(
  "with nothing to list, the chat page says which nothing it is: no chats once every agent's are listed, no agents with the way to make one, or that they can't be read",
  withGateway(async (gateway) => {
    // Agents with no chats: once each agent's chats are listed, it says there are none.
    gateway.noChats();
    const holding = gateway.hold("chat.list");
    let page = await open(gateway);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: /Research/ })
      .waitFor();
    await page.waitForTimeout(400);
    // Let go whatever is found, so a failing check doesn't leave the call held.
    const before = await list(page).getByText("No chats").count();
    holding();
    assert.equal(before, 0, "nothing is said before the chats are listed");
    await list(page).getByText("No chats", { exact: true }).waitFor();
    assert.equal(await list(page).getByRole("button", { name: "Create" }).count(), 0);
    await page.close();

    // No agents: it says so, with Create beside it, which opens the creation window.
    gateway.agents.clear();
    page = await open(gateway);
    await list(page).getByText("No agents", { exact: true }).waitFor();
    await list(page).getByRole("button", { name: "Create" }).click();
    await page.getByRole("dialog", { name: "Create" }).waitFor();
    await page.close();
  }),
);

test(
  "agents that can't be read: the chat page says so where its list would be",
  withGateway(async (gateway) => {
    gateway.refuseEvery("agents.list", "unavailable", "The manager isn't answering.");
    const page = await open(gateway);
    await list(page).getByText("Can't be read right now", { exact: true }).waitFor();
    assert.equal(await list(page).getByRole("button", { name: "Create" }).count(), 0);
    await page.close();
  }),
);
