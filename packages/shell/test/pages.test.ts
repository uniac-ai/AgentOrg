// The fixed pages in a real browser, over the stand-in gateway: an agent's page, how it stands and
// what it holds, and what holds on every page.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { withBrowser } from "./build-kit.ts";
import { openSetup, stopElsewhere } from "./design/samples.ts";
import { inTeam, open, state, withGateway } from "./pages-kit.ts";

withBrowser();

test(
  "an agent's page says how it stands and no more: working or idle, or what is wrong",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    await state(page).getByText("Working", { exact: true }).waitFor();
    // What it is doing is read in its chats, not on its line.
    assert.equal((await state(page).innerText()).trim(), "Working");
    for (const [name, says] of [
      ["Research", "Working"],
      ["Reviewer", "Idle"],
      ["Weekly report", "Stopped"],
    ] as const)
      await inTeam(page, name, says).waitFor();
    // Something wrong is marked on the face.
    for (const name of ["Triage", "Broken"])
      await inTeam(page, name).getByRole("img", { name: "Has a problem" }).waitFor();
    await inTeam(page, "Reviewer").click();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    await inTeam(page, "Triage").click();
    await state(page).getByText("linear is down, so its tools are left out").waitFor();
    await inTeam(page, "Broken").click();
    await state(page).getByText("Its program exited.").waitFor();
    await page.close();
  }),
);

test(
  "an agent's state follows its events, and a conversation's problem is that conversation's to say",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-research");
    const row = (on: Page) =>
      on.getByRole("main").getByRole("list", { name: "Chats with Research" }).getByRole("button");
    await state(page).getByText("Working", { exact: true }).waitFor();
    // An agent at work says so in the team page's list, whichever agent is open beside it.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await inTeam(page, "Reviewer", "Working").waitFor();
    // What it was answering failed. The agent is idle, with nothing wrong of its own: the
    // conversation's row says the problem, and the conversation holds what can be done.
    gateway.failChat("a-research", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await row(page).getByText("You've reached your plan's limit.").waitFor();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    assert.equal(await state(page).getByRole("button").count(), 0);
    await inTeam(page, "Research", "Idle").waitFor();
    gateway.failChat("a-research", { code: "failed", message: "The model refused it." });
    await row(page).getByText("The model refused it.").waitFor();
    assert.equal((await state(page).innerText()).trim(), "Idle");
    // A page opened late reads the same.
    const late = await open(gateway, "#/a/a-research");
    await row(late).getByText("The model refused it.").waitFor();
    await state(late).getByText("Idle", { exact: true }).waitFor();
    await late.close();
    // Its next reply ends the problem.
    gateway.addMessage("a-research", {
      id: "m9",
      role: "assistant",
      text: "Three causes explain it.",
      at: new Date().toISOString(),
    });
    await row(page).getByText("The model refused it.").waitFor({ state: "detached" });
    await row(page).getByText("Three causes explain it.").waitFor();
    await page.close();
  }),
);

test(
  "an agent stopped elsewhere is started from its page, and deleted from it after asking; its page has no Stop",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const message = page.getByRole("main").getByRole("button", { name: "Message", exact: true });
    await message.waitFor();
    // Its head has no "…": nothing on its page stops it.
    assert.equal(await page.getByRole("button", { name: "More for Reviewer" }).count(), 0);
    assert.equal(
      await page.getByRole("main").getByRole("button", { name: "Stop", exact: true }).count(),
      0,
    );
    // Stopped elsewhere, it is started where it says so, and there is nothing to message.
    stopElsewhere(gateway, "a-reviewer");
    await state(page).getByText("Stopped", { exact: true }).waitFor();
    assert.equal(await message.isDisabled(), true);
    await state(page).getByRole("button", { name: "Start" }).click();
    await state(page).getByText("Idle", { exact: true }).waitFor();
    assert.equal(await state(page).getByRole("button").count(), 0);
    assert.equal(await message.isDisabled(), false);
    // A start that is refused says why, on its line.
    stopElsewhere(gateway, "a-reviewer");
    await state(page).getByText("Stopped", { exact: true }).waitFor();
    gateway.refuseNext("agents.start", "failed", "It wouldn't start.");
    await state(page).getByRole("button", { name: "Start" }).click();
    await state(page).getByText("It wouldn't start.").waitFor();
    // Deleting it is in its setup, after asking.
    const sheet = await openSetup(page, "Reviewer");
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Reviewer?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(gateway.agents.has("a-reviewer"));
    // A delete that is refused says why where it was asked, and is asked anew the next time.
    gateway.refuseNext("agents.remove", "failed", "It wouldn't go.");
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await dialog.getByRole("alert").getByText("It wouldn't go.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await sheet.getByRole("button", { name: "Delete Reviewer…" }).click();
    await dialog.getByRole("button", { name: "Delete" }).waitFor();
    assert.equal(await dialog.getByRole("alert").count(), 0);
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/#\/team$/);
    // It is gone from the team page's list too.
    await inTeam(page, "Reviewer").waitFor({ state: "detached" });
    await inTeam(page, "Research", "Working").waitFor();
    assert.equal(gateway.agents.has("a-reviewer"), false);
    await page.close();
  }),
);

test(
  "an agent's page is who it is, how it stands, and your conversation with it; what it's made of is one press away",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await main.getByText("Chats and uses what you connect").waitFor();
    // With no computer it opens on its chats; its Overview is the tab after.
    const tabs = main.getByRole("tablist", { name: "Reviewer" });
    await tabs.getByRole("tab", { name: "Chats", selected: true }).waitFor();
    assert.deepEqual(await tabs.getByRole("tab").allInnerTexts(), ["Chats", "Overview"]);
    // Its tab is your conversation with it, which opens in the chat at the right.
    const chats = main.getByRole("list", { name: "Chats with Reviewer" });
    await chats.getByRole("button").first().waitFor();
    assert.equal(await chats.getByRole("button").count(), 1);
    await chats.getByRole("button").first().click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    await panel.getByText("Reviewed #482 with 3 comments").first().waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    // Message opens the same conversation.
    assert.equal(await main.getByRole("button", { name: "New chat" }).count(), 0);
    await main.getByRole("button", { name: "Message", exact: true }).click();
    await panel.getByText("Reviewed #482 with 3 comments").first().waitFor();
    await panel.getByPlaceholder("Message Reviewer").waitFor();
    await panel.getByRole("button", { name: "Close chats" }).click();
    // An agent you have never messaged has the way to begin, in its conversation's place.
    await page.goto(`${gateway.url}/#/a/a-triage`);
    const begin = main
      .getByRole("list", { name: "Chats with Triage" })
      .getByRole("button", { name: "Message Triage" });
    await begin.click();
    await panel.getByRole("heading", { name: "Triage" }).waitFor();
    await panel.getByPlaceholder("Message Triage").waitFor();
    assert.equal(await panel.locator('[data-slot="message-scroller-item"]').count(), 0);
    await panel.getByRole("button", { name: "Close chats" }).click();
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    // What it's made of is a sheet over its page, closed again with Escape.
    const sheet = await openSetup(page, "Reviewer");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.match(page.url(), /#\/a\/a-reviewer$/);
    // An agent that isn't there says so, and nothing else.
    await page.goto(`${gateway.url}/#/a/a-nobody`);
    await inTeam(page, "Reviewer", "Idle").waitFor();
    const missing = main.getByText("This agent isn't here").locator("xpath=../..");
    await missing.waitFor();
    assert.equal((await missing.innerText()).trim(), "This agent isn't here\nTeam");
    await page.close();
  }),
);

test(
  "every portaled surface takes the theme",
  withGateway(async (gateway) => {
    const luma = (locator: Locator) =>
      locator.evaluate((node) => {
        const canvas = document
          .createElement("canvas")
          .getContext("2d") as CanvasRenderingContext2D;
        canvas.fillStyle = getComputedStyle(node).backgroundColor;
        canvas.fillRect(0, 0, 1, 1);
        const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data as unknown as number[];
        return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
      });
    for (const theme of ["dark", "light"]) {
      const page = await open(gateway, theme === "light" ? "#/?light" : "#/a/a-reviewer");
      if (theme === "light") {
        await page.evaluate(() => localStorage.setItem("agentorg.theme", "light"));
        await page.goto(`${gateway.url}/#/a/a-reviewer`);
        await page.reload();
      }
      const sheet = await openSetup(page, "Reviewer");
      await sheet.getByRole("button", { name: "Add an MCP" }).click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      await menu.waitFor();
      const value = await luma(menu);
      assert.ok(theme === "light" ? value > 180 : value < 110, `${theme}: ${value}`);
      await page.close();
    }
  }),
);

test(
  "no page shows a scrollbar or overflows sideways, wide or phone, nor an agent's setup over its page",
  withGateway(async (gateway) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ])
      for (const [hash, sheet] of [["#/"], ["#/a/a-research"], ["#/a/a-triage", "Triage"]]) {
        const page = await open(gateway, hash, viewport);
        await page.getByRole("main").getByText(/./).first().waitFor();
        if (sheet) {
          const box = await (await openSetup(page, sheet)).boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, "inside the window");
        }
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
          for (const el of document.querySelectorAll<HTMLElement>(
            'main, main *, [role="dialog"], [role="dialog"] *',
          ))
            if (
              /auto|scroll/.test(getComputedStyle(el).overflowY) &&
              el.offsetWidth - el.clientWidth > 0
            )
              out.push(el.className);
          return out;
        });
        assert.deepEqual(bad, [], `${viewport.width} ${hash}`);
        await page.close();
      }
  }),
);
