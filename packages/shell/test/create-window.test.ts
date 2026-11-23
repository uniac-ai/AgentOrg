// The Create window itself: how it opens, what it offers, and what it shows first. An agent's is
// one card: the template it starts from, its avatar, its name and what it's for.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { NAMES } from "../src/fixed/names.ts";
import {
  agentsRead,
  badge,
  browser,
  detail,
  edge,
  open,
  panel,
  plus,
  SESSION,
  settingsWindow,
  startFrom,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { boxOf, named, opened, wide } from "./create-window-kit.ts";

withBrowser();

/** Opens Create from Team, at rest once it has opened. */
async function openCreate(page: Page) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  await opened(page);
  return panel(page);
}

/** A part's middle, from the top. */
const middle = async (part: Locator) => {
  const box = await boxOf(part);
  return Math.round((box.y + box.height / 2) * 10) / 10;
};

/** The name offered: the one that comes with the avatar in the middle of the row. */
const offered = async (page: Page) => {
  await page.waitForFunction(
    () => document.querySelector("#build-name")?.getAttribute("placeholder") !== "Name",
  );
  return (await panel(page).locator("#build-name").getAttribute("placeholder")) ?? "";
};

test(
  "Create is one card, open on the Assistant: its template's badge, the row of avatars, its name and what it's for, and Create, clean each time",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    const name = window_.locator("#build-name");
    await name.waitFor();
    assert.equal(await badge(page).textContent(), "Assistant");
    assert.equal(await name.inputValue(), "");
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.equal(box.width, 440);
    // Top to bottom: the badge, the avatars, the name, what it's for, and Create.
    const parts = [
      badge(page),
      window_.getByRole("region", { name: "Avatar" }),
      name,
      window_.getByLabel("What it's for"),
      window_.getByRole("button", { name: "Create", exact: true }),
    ];
    const tops = await Promise.all(parts.map(async (part) => (await boxOf(part)).y));
    assert.deepEqual(
      tops,
      [...tops].sort((a, b) => a - b),
    );
    // No row of templates, no options, and what it can do is closed.
    assert.equal(await window_.getByRole("list", { name: "Start from" }).count(), 0);
    assert.equal(await window_.locator('form[aria-label="Build"]').count(), 0);
    assert.equal(await detail(page).count(), 0);

    await name.fill("Foreman");
    await window_.getByLabel("What it's for").fill("Keeps things current");
    await startFrom(page, "Empty");
    assert.equal(await badge(page).textContent(), "Empty");
    assert.equal((await boxOf(window_)).width, 440, "the same window");
    assert.equal(await name.inputValue(), "Foreman", "choosing again keeps what was typed");
    assert.equal(await window_.getByLabel("What it's for").inputValue(), "Keeps things current");
    await startFrom(page, "Assistant");
    assert.equal(await name.inputValue(), "Foreman");

    for (const close of [
      () => page.mouse.click(8, 8),
      () => window_.getByRole("button", { name: "Close" }).click(),
    ]) {
      await close();
      await window_.waitFor({ state: "detached" });
      await plus(page).click();
      await name.waitFor();
      assert.equal(await name.inputValue(), "", "the plus starts clean");
      assert.equal(await badge(page).textContent(), "Assistant");
      assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
      await startFrom(page, "Empty");
      await name.fill("Again");
      await edge(page).click();
    }
    // Opened from a template on its page, it is as clean, and on that template.
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "Use" }).nth(1).click();
    await name.waitFor();
    assert.equal(await badge(page).textContent(), "From elsewhere");
    assert.equal(await name.inputValue(), "", "what was typed went with the window");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    await page.close();
  }),
);

test(
  "an agent is offered the name that comes with its avatar, one no agent has, used when none is typed; a template has to be named; what it's for is optional",
  withGateway(async (gateway) => {
    // An agent already has a name of the list, in another case: it isn't offered.
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.name = "scout";
    // Until the agents are read, none is offered and nothing can be made unnamed.
    const release = gateway.hold("agents.list");
    const page = await open(gateway);
    await plus(page).click();
    const name = panel(page).locator("#build-name");
    await name.waitFor();
    // Not a name: what the field is, greyed. And no avatars yet, in the room kept for them.
    assert.equal(await name.getAttribute("placeholder"), "Name");
    assert.equal(await named(page, "Create").isDisabled(), true);
    assert.equal(await panel(page).getByRole("region", { name: "Avatar" }).count(), 0);
    await opened(page);
    const before = (await boxOf(name)).y;
    release();
    await agentsRead(page);
    const first = await offered(page);
    assert.ok(NAMES.includes(first) && first !== "Scout", first);
    assert.equal((await boxOf(name)).y, before, "the row comes into room kept for it");
    // A read that fails lists none: the name offered is still one no agent has.
    gateway.refuseNext("agents.list", "unavailable", "Not now.");
    gateway.setAccount("signed_in");
    await page.locator('ul[aria-label="Agents"] li').first().waitFor({ state: "detached" });
    assert.equal(await name.getAttribute("placeholder"), first, "the name it is offered");
    assert.equal(await name.evaluate((e) => e === document.activeElement), true, "the keyboard");
    const create = named(page, "Create");
    assert.equal(await create.isDisabled(), false, "it can be made at once");
    await name.fill("  ");
    assert.equal(await create.isDisabled(), false, "blanks are no name: the offered one is used");
    await name.fill(" Solo ");
    assert.equal(await create.isDisabled(), false);
    await create.click();
    await page.waitForURL(/#\/team\/a-6$/);
    const sent = gateway.calls.find((c) => c.method === "create")?.input as {
      name: string;
      purpose?: string;
    };
    assert.equal(sent.name, "Solo");
    assert.equal(sent.purpose, undefined);
    // Nothing typed, the offered name is the agent's.
    await panel(page).waitFor({ state: "detached" });
    await plus(page).click();
    await name.waitFor();
    const second = await offered(page);
    await named(page, "Create").click();
    await page.waitForURL(/#\/team\/a-7$/);
    assert.equal(
      (gateway.calls.findLast((c) => c.method === "create")?.input as { name?: string } | undefined)
        ?.name,
      second,
    );
    // A template is offered none, and waits for one.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
    await name.waitFor();
    assert.equal(await name.getAttribute("placeholder"), "Name", "what the field is, greyed");
    assert.equal(await named(page, "Save template").isDisabled(), true);
    await page.close();
  }),
);

test(
  "a template chosen while Create's units are still being read is the one its stack is drawn from",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    const release = gateway.hold("agents.units");
    await plus(page).click();
    await edge(page).click();
    await startFrom(page, "From elsewhere");
    // No stack until its units are read, so none is drawn from what was read before.
    await page.waitForTimeout(300);
    const can = detail(page).getByRole("listitem");
    assert.equal(await can.count(), 0);
    assert.equal(await badge(page).textContent(), "From elsewhere");
    release();
    await can.getByText("mystery", { exact: true }).waitFor();
    assert.equal(await can.count(), 1);
    await page.close();
  }),
);

test(
  "the foot says an agent can't work yet while signed out, a refusal is said above Create, and a template's foot says nothing of it",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    gateway.changeForm("computer", (field) => {
      delete field.required;
    });
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const foot = panel(page).locator("footer");
    const sentence = "Agents can't work until you sign in with ChatGPT.";
    await foot.getByText(sentence).waitFor();
    gateway.refuseNext("agents.create", "failed", "The provider isn't connected.");
    await panel(page).getByLabel("Name").fill("Solo");
    await named(page, "Create").click();
    const said = panel(page).getByRole("alert");
    await said.getByText("The provider isn't connected.").waitFor();
    assert.ok((await boxOf(said)).y + (await boxOf(said)).height <= (await boxOf(foot)).y);
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
    await panel(page).locator("#build-name").waitFor();
    assert.equal(await panel(page).locator("footer").getByText(sentence).count(), 0);
    await page.close();
  }),
);

test(
  "Create builds nothing: a template is made in New template, which has no menu and waits for a name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    await window_.getByRole("button", { name: "Create", exact: true }).waitFor();
    assert.equal(await window_.getByRole("button", { name: "Build options" }).count(), 0);
    assert.equal(await window_.getByRole("button", { name: /Save as template/ }).count(), 0);
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "New template", exact: true }).click();
    const fresh = page.getByRole("dialog", { name: "New template" });
    await fresh.locator("#build-name").waitFor();
    assert.equal(await fresh.getByRole("button", { name: "Build options" }).count(), 0);
    assert.equal(
      await fresh.getByRole("button", { name: "Empty" }).getAttribute("aria-current"),
      "true",
    );
    const save = fresh.getByRole("button", { name: "Save template" });
    assert.equal(await save.isDisabled(), true, "a template has to be named");
    await fresh.getByRole("button", { name: /^Assistant/ }).click();
    assert.equal(await fresh.locator("#build-name").inputValue(), "Assistant copy");
    assert.equal(await save.isDisabled(), false);
    await page.close();
  }),
);

test(
  "the window is Create New Agent; its name card is rgb(46, 46, 46) and what it can do, the card under it, rgb(38, 38, 38), darker; in the light theme rgb(246, 246, 246) over white; the badge and the close are on one line",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    await window_.getByRole("heading", { name: "Create New Agent" }).waitFor({ state: "attached" });
    assert.equal(
      await middle(window_.getByRole("button", { name: "Close" }).filter({ visible: true })),
      await middle(badge(page)),
    );
    await edge(page).click();
    await wide(page, 800);
    const colours = async () => [
      await window_.getByRole("form").evaluate((e) => getComputedStyle(e).backgroundColor),
      await detail(page).evaluate((e) => getComputedStyle(e).backgroundColor),
    ];
    assert.deepEqual(await colours(), ["rgb(46, 46, 46)", "rgb(38, 38, 38)"]);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    // Once the window's own change of colour has run.
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.deepEqual(await colours(), ["rgb(246, 246, 246)", "rgb(255, 255, 255)"]);
    await page.close();
  }),
);

test(
  "Create shows the name offered and what the template or the base is; what is typed is its name and its line, typed in place; the keyboard starts in the name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    const name = window_.locator("#build-name");
    const line = window_.getByLabel("What it's for");
    assert.equal(await name.evaluate((e) => e === document.activeElement), true, "the keyboard");
    assert.ok(NAMES.includes(await offered(page)));
    assert.equal(await line.getAttribute("placeholder"), "Does what you ask on a computer");
    await startFrom(page, "Empty");
    assert.equal(await line.getAttribute("placeholder"), "Chats and uses what you connect");
    await name.fill("Foreman");
    assert.equal(await name.inputValue(), "Foreman");
    await line.fill("Keeps dependencies current");
    assert.equal(await line.inputValue(), "Keeps dependencies current");
    // Typed in place: no box around either.
    for (const field of [name, line])
      assert.deepEqual(
        await field.evaluate((e) => [
          getComputedStyle(e).borderTopWidth,
          getComputedStyle(e).backgroundColor,
        ]),
        ["0px", "rgba(0, 0, 0, 0)"],
      );
    await page.close();
  }),
);

test(
  "it opens and closes in the page's window times, growing a little; with reduced motion it only fades",
  withGateway(async (gateway) => {
    const motion = (part: Locator, phase: "enter" | "exit") =>
      part.evaluate((e, which) => {
        const style = getComputedStyle(e);
        const scale = style.getPropertyValue(`--tw-${which}-scale`).replace(/\s/g, "");
        const percent = /^calc\((\d+)\*1%\)$/.exec(scale)?.[1];
        return [
          style.animationName,
          style.animationDuration,
          percent ? Number(percent) / 100 : Number(scale),
        ];
      }, phase);
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    assert.deepEqual(await motion(panel(page), "enter"), ["enter", "0.22s", 0.96]);
    await opened(page);
    await page.keyboard.press("Escape");
    const closing = page.locator('[data-slot="dialog-content"][data-state="closed"]');
    assert.deepEqual(await motion(closing, "exit"), ["exit", "0.16s", 0.96]);
    await page.close();

    const reduced = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await reduced.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await reduced.goto(`${gateway.url}/#/team`);
    await agentsRead(reduced);
    await plus(reduced).click();
    assert.deepEqual(await motion(panel(reduced), "enter"), ["enter", "0.22s", 1]);
    await reduced.close();
  }),
);
