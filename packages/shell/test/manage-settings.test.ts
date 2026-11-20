// Settings as a window, in a real browser over the stand-in gateway: its sections, its bar, its type,
// the account, and what a list with no rows says. Its old addresses open it on what they name.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { withBrowser, withGateway } from "./build-kit.ts";
import { choose, open, opened, row, settings } from "./manage-kit.ts";

withBrowser();

test(
  "Settings holds skills, MCP connections, providers and the account",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    const sections = settings(page).getByRole("navigation", { name: "Settings" });
    assert.deepEqual(await sections.getByRole("button").allInnerTexts(), [
      "Templates",
      "Skills",
      "MCP connections",
      "Providers",
      "Account",
    ]);
    await choose(page, "Skills");
    await row(page, "cite-sources").waitFor();
    await choose(page, "Providers");
    const agents = page.getByRole("region", { name: "Agent providers" });
    await agents.getByText("AgentOrg").waitFor();
    await agents.getByText("Assistant, Code reviewer").waitFor();
    const mcp = page.getByRole("region", { name: "MCP providers" });
    await mcp.getByText("Local", { exact: true }).waitFor();
    await mcp.getByRole("button", { name: "4 connections" }).waitFor();
    await choose(page, "Account");
    const chatgpt = page.getByRole("region", { name: "ChatGPT" });
    await chatgpt.getByText("sam@example.com").waitFor();
    await chatgpt.getByText("Plus").waitFor();
    await page.getByRole("combobox", { name: "Color" }).click();
    await page.getByRole("option", { name: "Light" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await chatgpt.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(100);
    assert.ok(gateway.calls.some((c) => c.slot === "login" && c.method === "logout"));
    await page.close();
  }),
);

test(
  "the bar doesn't move between places or when Settings opens over them, and no section overflows or shows a scrollbar",
  withGateway(async (gateway) => {
    for (const width of [1440, 390])
      for (const hash of ["#/skills", "#/mcps", "#/settings/providers", "#/settings/account"]) {
        const page = await open(gateway, hash, width);
        await settings(page).getByRole("region").locator("li, section").first().waitFor();
        await page.waitForTimeout(150);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
          for (const el of document.querySelectorAll<HTMLElement>(
            '[role="dialog"], [role="dialog"] *',
          ))
            if (
              /auto|scroll/.test(getComputedStyle(el).overflowY) &&
              el.offsetWidth - el.clientWidth > 0
            )
              out.push(el.className);
          return out;
        });
        assert.deepEqual(bad, [], `${width} ${hash}`);
        await page.close();
      }
    const page = await open(gateway, "#/");
    // By its markup: under the open window the bar is out of reach, but still there.
    const place = (name: string) =>
      page.locator(`nav[aria-label="Main"] button[aria-label^="${name}"]`);
    const first = place("Chat");
    await first.waitFor();
    const before = await first.boundingBox();
    for (const name of ["Team", "Chat"]) {
      await place(name).click();
      assert.deepEqual(await first.boundingBox(), before);
      // The bar marks where you are.
      await place(name).and(page.locator('[aria-current="page"]')).waitFor();
      assert.deepEqual(await first.boundingBox(), before);
    }
    // Settings opens over the place, which the bar still marks, and the bar stays.
    await place("Settings").click();
    await opened(settings(page));
    assert.deepEqual(await first.boundingBox(), before);
    assert.equal(await place("Settings").getAttribute("aria-current"), null);
    assert.equal(await place("Chat").getAttribute("aria-current"), "page");
    await page.close();
  }),
);

test(
  "Settings' sections are set in the window's type, and connections with none to list say so in the first row's place",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills");
    const title = row(page, "cite-sources").getByText("cite-sources", { exact: true });
    await title.waitFor();
    assert.deepEqual(
      await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]),
      ["14px", "500"],
    );
    await choose(page, "MCP connections");
    const name = row(page, "GitHub acme").getByText("GitHub acme", { exact: true });
    await name.waitFor();
    assert.equal(await name.evaluate((e) => getComputedStyle(e).fontSize), "14px");
    for (const [tab, words] of [
      ["Providers", "AgentOrg"],
      ["Account", "sam@example.com"],
    ] as const) {
      await choose(page, tab);
      const said = settings(page).getByText(words, { exact: true });
      await said.waitFor();
      assert.equal(await said.evaluate((e) => getComputedStyle(e).fontSize), "14px", tab);
    }
    // With none, as when the last is removed, the list says so in its first row's place.
    for (const agent of gateway.agents.values()) agent.mcp = [];
    for (const connection of [...gateway.connections.keys()])
      gateway.connections.delete(connection);
    const before = gateway.calls.length;
    await choose(page, "MCP connections");
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
    for (const end = Date.now() + 8000; ; ) {
      const read = gateway.calls
        .slice(before)
        .some((c) => c.slot === "connections" && c.method === "list");
      if (read) break;
      assert.ok(Date.now() < end, "the connections are read again");
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(100);
    const list = settings(page).getByRole("region", { name: "MCP connections" }).getByRole("list");
    await list.getByText("No connections", { exact: true }).waitFor();
    assert.equal(await list.getByRole("listitem").count(), 1);
    assert.equal((await list.innerText()).trim(), "No connections");
    await page.close();
  }),
);

test(
  "Account says who is signed in to ChatGPT with the way out; signed out, it says so with the way in the banner has",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/settings/account");
    const chatgpt = settings(page).getByRole("region", { name: "ChatGPT" });
    await chatgpt.getByText("sam@example.com").waitFor();
    assert.deepEqual(
      (await chatgpt.innerText()).split("\n").filter((word) => word.trim()),
      ["ChatGPT", "sam@example.com", "Plus", "Manage usage", "Sign out"],
    );
    for (const state of ["ineligible", "signed_in", "signed_out"] as const) {
      gateway.setAccount(state);
      if (state === "signed_in") {
        await chatgpt.getByText("sam@example.com").waitFor();
        continue;
      }
      await chatgpt.getByText("Signed out", { exact: true }).waitFor();
      assert.deepEqual(
        (await chatgpt.innerText()).split("\n").filter((word) => word.trim()),
        state === "signed_out"
          ? [
              "ChatGPT",
              "Signed out",
              "Agents can't work until you sign in with ChatGPT.",
              "Continue with ChatGPT",
            ]
          : [
              "ChatGPT",
              "Signed out",
              "This ChatGPT account isn't eligible to use its plan in this app.",
              "Use another account",
            ],
      );
      // The same way in as the banner's, under the words, as wide as they have room for: the
      // window's section is narrow.
      const way = await chatgpt.getByRole("button").boundingBox();
      const words = await chatgpt
        .getByText("Signed out", { exact: true })
        .locator("..")
        .boundingBox();
      assert.ok(way && words && Math.round(way.height) === 40);
      assert.equal(Math.round(way.width), Math.round(words.width));
      assert.ok(way.y >= words.y + words.height, "under the words");
    }
    // Pressed, it waits for ChatGPT's page as the banner's does, and takes this tab there.
    // ChatGPT's page is answered here: nothing leaves this computer.
    await page
      .context()
      .route("https://auth.example/**", (route) => route.fulfill({ status: 200, body: "ChatGPT" }));
    const holding = gateway.hold("login.start");
    await chatgpt.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await chatgpt.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
    holding();
    await page.waitForURL(/^https:\/\/auth\.example\/authorize/);
    await page.close();
  }),
);

test(
  "a section's contents move with the wheel from anywhere over them, under the window's top line, which stays",
  withGateway(async (gateway) => {
    // Too short for the list.
    const page = await open(gateway, "#/skills", 1440, 160);
    const window = settings(page);
    const first = row(page, "cite-sources");
    await first.waitFor();
    await opened(window);
    const top = async (of: ReturnType<Page["locator"]>) => (await of.boundingBox())?.y ?? 0;
    const head = window.getByRole("button", { name: "Add skill" });
    const area = await window.getByRole("region", { name: "Skills" }).boundingBox();
    assert.ok(area);
    const [rowWas, headWas] = [await top(first), await top(head)];
    for (const [side, x] of [
      ["left", area.x + 10],
      ["middle", area.x + area.width / 2],
      ["right", area.x + area.width - 10],
    ] as const) {
      await page.mouse.move(x, area.y + area.height - 10);
      await page.mouse.wheel(0, 20);
      await page.waitForFunction(
        ([was, name]) => {
          const rows = [...document.querySelectorAll('[role="dialog"] li')];
          const one = rows.find((li) => li.textContent?.includes(name as string));
          return !!one && one.getBoundingClientRect().y < (was as number);
        },
        [rowWas, "cite-sources"] as const,
      );
      assert.equal(await top(head), headWas, `the top line stays, the wheel at the ${side}`);
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(
        ([was, name]) => {
          const rows = [...document.querySelectorAll('[role="dialog"] li')];
          const one = rows.find((li) => li.textContent?.includes(name as string));
          return one?.getBoundingClientRect().y === was;
        },
        [rowWas, "cite-sources"] as const,
      );
    }
    await page.close();
  }),
);

test(
  "a list with no rows says which nothing it is, in the first row's place: none yet, or none that can be read",
  withGateway(async (gateway) => {
    const first = (page: Page) =>
      settings(page).getByRole("region").locator("ul").first().getByRole("listitem").first();
    const lists = [
      ["#/settings/templates", "No templates", "agents.templates"],
      ["#/skills", "No skills", "skills.list"],
      ["#/mcps", "No connections", "connections.list"],
    ] as const;
    gateway.emptyLists();
    for (const [hash, none] of lists) {
      const page = await open(gateway, hash);
      await first(page).getByText(none, { exact: true }).waitFor();
      assert.equal(await settings(page).getByText("Can't be read right now").count(), 0);
      await page.close();
    }
    for (const [hash, none, call] of lists) {
      gateway.refuseEvery(call, "unavailable", "Not answering.");
      const page = await open(gateway, hash);
      await first(page).getByText("Can't be read right now", { exact: true }).waitFor();
      assert.equal(await settings(page).getByText(none).count(), 0, "not that it has none");
      await page.close();
    }
  }),
);
