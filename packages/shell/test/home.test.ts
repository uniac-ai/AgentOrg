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
/** A chat of an agent's, with one thing said in it so long ago. */
const chat = (gateway: Gateway, agent: string, id: string, title: string, minutes: number) =>
  gateway.addChat(agent, { id, title, said: [said(`${id}-1`, "user", title, minutes)] });

test(
  "Home is the chats that need you, then the recent ones; a row opens its chat, and All the list",
  withGateway(async (gateway) => {
    chat(gateway, "a-reviewer", "c-review", "Review #482", 30);
    gateway.addChat("a-triage", {
      id: "c-route",
      title: "Route today's issues",
      said: [said("t1", "user", "Route today's new issues.", 60)],
      problem: { code: "failed", message: "linear is down, so its tools are left out" },
    });
    // An archived chat and a stopped agent's are in neither.
    gateway.addChat("a-research", {
      id: "c-kept",
      title: "An old question",
      said: [said("k1", "user", "An old question", 3000)],
      archived: true,
    });
    chat(gateway, "a-weekly", "c-weekly", "Numbers for last week", 500);
    const page = await open(gateway);
    // A chat needs you when its last message got no answer.
    await until(() => titles(page, "Needs you"), ["Route today's issues"]);
    await until(
      () => titles(page, "Recent"),
      [
        "Why are checkouts failing?",
        // The stand-in's Reviewer was never asked anything, so its own chat has no title.
        "Reviewer",
        "Review #482",
      ],
    );
    // The archived one and the stopped agent's have been read by now: they are in the list's
    // archived ones, and in neither section here.
    await page.getByRole("button", { name: /^Chats/ }).click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    await panel.getByRole("button", { name: /^Archived\s*2$/ }).waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    assert.deepEqual(await titles(page, "Needs you"), ["Route today's issues"]);
    assert.equal((await titles(page, "Recent")).length, 3);
    // Or when it said something you haven't read: it moves up from the recent ones.
    gateway.sayIn("a-reviewer", "c-review", {
      id: "v-a1",
      role: "assistant",
      text: "Three comments on #482.",
      at: new Date().toISOString(),
    });
    await section(page, "Needs you").getByRole("listitem").nth(1).waitFor();
    assert.deepEqual(await titles(page, "Needs you"), ["Review #482", "Route today's issues"]);
    assert.equal(
      await section(page, "Recent")
        .getByRole("listitem")
        .filter({ hasText: "Review #482" })
        .count(),
      0,
    );
    await section(page, "Needs you").getByRole("img", { name: "New" }).waitFor();

    // A row opens the chat it names; shown, it needs you no more.
    await section(page, "Needs you")
      .getByRole("button", { name: /Review #482/ })
      .click();
    await panel.getByRole("heading", { name: "Review #482" }).waitFor();
    await panel.getByText("Three comments on #482.").waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    await section(page, "Recent")
      .getByRole("listitem")
      .filter({ hasText: "Review #482" })
      .waitFor();
    assert.deepEqual(await titles(page, "Needs you"), ["Route today's issues"]);

    // All opens the list.
    await section(page, "Recent").getByRole("button", { name: "All", exact: true }).click();
    await panel.getByRole("heading", { name: "Chats", exact: true }).waitFor();
    await page.close();
  }),
);

test(
  "Home shows the six newest of the recent chats, and a section with nothing in it isn't there",
  withGateway(async (gateway) => {
    for (let n = 0; n < 8; n++) chat(gateway, "a-reviewer", `c-${n}`, `Chat ${n}`, 20 + n);
    const page = await open(gateway);
    await section(page, "Recent").getByRole("listitem").nth(5).waitFor();
    assert.equal(await section(page, "Needs you").count(), 0);
    assert.deepEqual(await titles(page, "Recent"), [
      "Why are checkouts failing?",
      "Reviewer",
      "Chat 0",
      "Chat 1",
      "Chat 2",
      "Chat 3",
    ]);
    await page.close();
  }),
);

test(
  "Home's column, a section's head and its rows are where the design puts them, wide and on a phone",
  withGateway(async (gateway) => {
    chat(gateway, "a-reviewer", "c-review", "Review #482", 30);
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
