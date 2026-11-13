// Home in a real browser: the chats that need you, then the recent ones.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/`);
  await noted(gateway);
  return page;
}
const section = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name, exact: true });
const titles = async (page: Page, name: string) =>
  (await section(page, name).getByRole("listitem").allInnerTexts()).map(
    (text) => text.split("\n").filter(Boolean)[1],
  );
const said = (id: string, role: "user" | "assistant", text: string, minutes: number) => ({
  id,
  role,
  text,
  at: new Date(Date.now() - minutes * 60_000).toISOString(),
});
/** Waits for what the page will come to, which arrives a call at a time. */
async function until<T>(read: () => Promise<T>, expected: T) {
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
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Your conversation with an agent, with one thing said in it so long ago. */
const chat = (gateway: Gateway, agent: string, text: string, minutes: number) =>
  gateway.converse(agent, [said(`${agent}-1`, "user", text, minutes)]);

test(
  "Home is your conversations that need you, then the recent ones; a row opens its conversation, and All the list",
  withGateway(async (gateway) => {
    chat(gateway, "a-reviewer", "Review #482", 30);
    gateway.converse("a-triage", [said("t1", "user", "Route today's new issues.", 60)], {
      code: "failed",
      message: "linear is down, so its tools are left out",
    });
    // A stopped agent's is among the recent ones, to be read.
    chat(gateway, "a-weekly", "Numbers for last week", 500);
    const page = await open(gateway);
    // One needs you when its last message got no answer.
    await until(() => titles(page, "Needs you"), ["Triage"]);
    await until(() => titles(page, "Recent"), ["Research", "Reviewer", "Weekly report"]);
    // Or when it said something you haven't read: it moves up from the recent ones.
    gateway.addMessage("a-reviewer", {
      id: "v-a1",
      role: "assistant",
      text: "Three comments on #482.",
      at: new Date().toISOString(),
    });
    await section(page, "Needs you").getByRole("listitem").nth(1).waitFor();
    assert.deepEqual(await titles(page, "Needs you"), ["Reviewer", "Triage"]);
    assert.equal(
      await section(page, "Recent").getByRole("listitem").filter({ hasText: "Reviewer" }).count(),
      0,
    );
    await section(page, "Needs you").getByRole("img", { name: "New" }).waitFor();

    // A row opens its conversation; shown, it needs you no more.
    const panel = page.getByRole("complementary", { name: "Chats" });
    await section(page, "Needs you")
      .getByRole("button", { name: /Reviewer/ })
      .click();
    await panel.getByRole("heading", { name: "Reviewer" }).waitFor();
    await panel.getByText("Three comments on #482.").waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    await section(page, "Recent").getByRole("listitem").filter({ hasText: "Reviewer" }).waitFor();
    assert.deepEqual(await titles(page, "Needs you"), ["Triage"]);

    // All opens the list.
    await section(page, "Recent").getByRole("button", { name: "All", exact: true }).click();
    await panel.getByRole("heading", { name: "Chats", exact: true }).waitFor();
    await page.close();
  }),
);

test(
  "Home shows the six newest of the recent conversations, and a section with nothing in it isn't there",
  withGateway(async (gateway) => {
    const like = gateway.agents.get("a-triage");
    assert.ok(like);
    for (let n = 0; n < 8; n++) {
      const agent = `a-more-${n}`;
      gateway.agents.set(agent, {
        ...like,
        agent,
        name: `Agent ${n}`,
        chat: {
          status: { state: "idle" },
          messages: [said(`${agent}-1`, "user", "Hello", 20 + n)],
        },
      });
    }
    const page = await open(gateway);
    await section(page, "Recent").getByRole("listitem").nth(5).waitFor();
    assert.equal(await section(page, "Needs you").count(), 0);
    assert.deepEqual(await titles(page, "Recent"), [
      "Research",
      "Reviewer",
      "Agent 0",
      "Agent 1",
      "Agent 2",
      "Agent 3",
    ]);
    await page.close();
  }),
);

test(
  "Home's column, a section's head and its rows are where the design puts them, wide and on a phone",
  withGateway(async (gateway) => {
    chat(gateway, "a-triage", "Route today's issues", 30);
    const box = async (page: Page, part: ReturnType<Page["locator"]>) => {
      const at = await part.boundingBox();
      assert.ok(at, `${part} is on the page`);
      return [at.x, at.y, at.width, at.height].map((n) => Math.round(n * 100) / 100);
    };
    const wide = await open(gateway);
    const recent = section(wide, "Recent");
    await recent.getByRole("listitem").nth(2).waitFor();
    // A column 720 wide in the middle of the page, 24 from its top; a head of 36, rows of 68.
    assert.deepEqual(await box(wide, recent), [494, 24, 688, 240]);
    // The head's words start 10 in; how wide they are is the font's.
    const [x, y, , height] = await box(wide, recent.getByRole("heading"));
    assert.deepEqual([x, y, height], [504, 32.25, 19.5]);
    assert.deepEqual(await box(wide, recent.getByRole("listitem").first()), [494, 60, 688, 68]);
    await wide.close();
    const phone = await open(gateway, 390);
    const narrow = section(phone, "Recent");
    await narrow.getByRole("listitem").nth(2).waitFor();
    assert.deepEqual(await box(phone, narrow.getByRole("listitem").first()), [16, 108, 358, 68]);
    await phone.close();
  }),
);

test(
  "with nothing to list, Recent says which nothing it is: no chats once every agent's are listed, or no agents with the way to make one",
  withGateway(async (gateway) => {
    const recent = (page: Page) => section(page, "Recent");
    const bar = (page: Page) => page.getByRole("navigation", { name: "Main" });

    // Agents with no chats: once each agent's chats are listed, Home says there are none.
    gateway.noChats();
    const holding = gateway.hold("chat.list");
    let page = await open(gateway);
    await bar(page)
      .getByRole("button", { name: /Research/ })
      .waitFor();
    await page.waitForTimeout(400);
    // Let go whatever is found, so a failing check doesn't leave the call held.
    const before = await recent(page).count();
    holding();
    assert.equal(before, 0, "nothing is said before the chats are listed");
    await recent(page).getByText("No chats", { exact: true }).waitFor();
    assert.equal(await recent(page).getByRole("button", { name: "Create" }).count(), 0);
    await page.close();

    // No agents: it says so, with Create beside it, which opens the Create window.
    gateway.agents.clear();
    page = await open(gateway);
    await recent(page).getByText("No agents", { exact: true }).waitFor();
    await recent(page).getByRole("button", { name: "Create" }).click();
    await page.getByRole("dialog", { name: "Create" }).waitFor();
    await page.close();
  }),
);

test(
  "agents that can't be read: Home and the left bar say so where they would be, and stop saying it once they are read",
  withGateway(async (gateway) => {
    gateway.refuseEvery("agents.list", "unavailable", "The manager isn't answering.");
    const page = await open(gateway);
    const recent = section(page, "Recent");
    const bar = page.getByRole("navigation", { name: "Main" });
    await recent.getByText("Can't be read right now", { exact: true }).waitFor();
    await bar.getByText("Can't be read right now", { exact: true }).waitFor();
    assert.equal(await bar.getByRole("list", { name: "Agents" }).getByRole("listitem").count(), 0);
    assert.equal(await recent.getByRole("button", { name: "Create" }).count(), 0);
    // Answered again, the agents are back, and their chats.
    gateway.answerAgain("agents.list");
    await bar.getByRole("button", { name: /Research/ }).waitFor({ timeout: 15_000 });
    await bar.getByText("Can't be read right now").waitFor({ state: "detached" });
    await until(async () => (await titles(page, "Recent")).length > 0, true);
    assert.equal(await recent.getByText("Can't be read right now").count(), 0);
    await page.close();
  }),
);
