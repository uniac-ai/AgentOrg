// The lists of rows, in a real browser over the stand-in gateway: a little apart, so two highlights
// never touch, and a little shorter, so a row's pitch is what it was. Every list of conversations,
// wherever it is, has rows 64 tall and 4 apart; Team's are 56 and 4 apart.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";

withBrowser();

async function open(gateway: Gateway, hash: string): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** Each row of a list, all read in one frame: its top, its height, whether it is the one open, and its fill. */
const rowsOf = (list: Locator) =>
  list.evaluate((root) =>
    [...root.querySelectorAll(":scope > li > button")].map((row) => {
      const box = row.getBoundingClientRect();
      return {
        top: box.top,
        height: box.height,
        current: row.getAttribute("aria-current") === "true",
        filled: getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)",
      };
    }),
  );
/** That a list's rows are each `height` tall and 4 apart. */
async function apart(list: Locator, height: number, where: string) {
  await list.locator(":scope > li > button").nth(1).waitFor();
  const rows = await rowsOf(list);
  assert.deepEqual(new Set(rows.map((row) => row.height)), new Set([height]), `${where}: tall`);
  const gaps = rows.slice(1).map((row, i) => row.top - ((rows[i]?.top ?? 0) + height));
  assert.deepEqual(new Set(gaps), new Set([4]), `${where}: apart`);
}
const said = (text: string) => ({
  id: `m-${text.length}`,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "Chat's conversations and the floating chat's are rows 64 tall and 4 apart, Team's 56 and 4 apart",
  withGateway(async (gateway) => {
    let page = await open(gateway, "#/chat");
    await apart(page.locator('main ul[aria-label="Chats"]'), 64, "Chat");
    await page.close();
    page = await open(gateway, "#/team");
    await apart(page.locator('main ul[aria-label="Agents"]'), 56, "Team");
    await page.getByRole("button", { name: /^Chats/ }).click();
    await apart(
      page.getByRole("complementary", { name: "Chats" }).locator('ul[aria-label="Chats"]'),
      64,
      "the floating chat",
    );
    await page.close();
  }),
);

test(
  "on an agent's page, its conversations with other agents are rows 64 tall and 4 apart, and the way to message one is a row 64 tall",
  withGateway(async (gateway) => {
    gateway.sayWith("a-research", "a-reviewer", said("Can you look at #482?"));
    gateway.sayWith("a-research", "a-triage", said("Which team takes this?"));
    let page = await open(gateway, "#/a/a-research");
    await apart(
      page.locator(`main ul[aria-label="Research's chats with other agents"]`),
      64,
      "with other agents",
    );
    await page.close();
    page = await open(gateway, "#/a/a-triage");
    const begin = page
      .getByRole("list", { name: "Chats with Triage" })
      .getByRole("button", { name: "Message Triage" });
    await begin.waitFor();
    assert.equal((await begin.boundingBox())?.height, 64);
    await page.close();
  }),
);

for (const [where, hash, list] of [
  ["Chat's", "#/chat", 'main ul[aria-label="Chats"]'],
  ["Team's", "#/team", 'main ul[aria-label="Agents"]'],
] as const)
  test(
    `on ${where} list, a row pointed at beside the selected one: two highlights, 4 apart`,
    withGateway(async (gateway) => {
      const page = await open(gateway, hash);
      await page.locator(`${list} > li > button[aria-current="true"]`).waitFor();
      await page.locator(`${list} > li:has(> button[aria-current="true"]) + li > button`).hover();
      const rows = await rowsOf(page.locator(list));
      const at = rows.findIndex((row) => row.current);
      const [selected, pointed] = [rows[at], rows[at + 1]];
      assert.ok(selected && pointed, "the selected row and the one under it");
      assert.deepEqual([selected.filled, pointed.filled], [true, true], "both highlighted");
      assert.equal(pointed.top - (selected.top + selected.height), 4);
      await page.close();
    }),
  );

for (const [where, hash, list] of [
  ["Chat's", "#/chat", 'main ul[aria-label="Chats"]'],
  ["Team's", "#/team", 'main ul[aria-label="Agents"]'],
] as const)
  test(
    `${where} first row is right under its list's label, 92 from the list's top: the strip's 52 and the label's 40`,
    withGateway(async (gateway) => {
      const page = await open(gateway, hash);
      const first = page.locator(`${list} > li > button`).first();
      await first.waitFor();
      assert.deepEqual(
        await first.evaluate((row) => {
          const panel = row.closest("section") as Element;
          const head = (panel.querySelector("header") as Element).getBoundingClientRect();
          const top = row.getBoundingClientRect().top;
          return [top - head.bottom, top - panel.getBoundingClientRect().top];
        }),
        [0, 92],
      );
      await page.close();
    }),
  );
