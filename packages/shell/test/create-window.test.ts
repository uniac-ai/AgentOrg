// The Create window itself: how it opens, what it offers, and what it shows first. An agent's is
// small: where it starts from, its name and what it's for.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  agentsRead,
  browser,
  open,
  panel,
  plus,
  SESSION,
  settingsWindow,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { boxOf, chosen, named, opened } from "./create-window-kit.ts";

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

test(
  "Create is one small window, open on Empty: where it starts from, the face, its name and what it's for, and what that gives, clean each time",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    const name = window_.locator("#build-name");
    await name.waitFor();
    assert.equal(await chosen(page, "Empty"), "true", "nothing is chosen for the person");
    assert.equal(await name.inputValue(), "");
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const box = await boxOf(window_);
    assert.equal(box.width, 480);
    // Top to bottom: where it starts from, the name, and nothing it can do with nothing chosen.
    const from = await boxOf(window_.getByRole("list", { name: "Start from" }));
    assert.ok((await boxOf(name)).y > from.y + from.height, "the name under where it starts from");
    const can = window_.getByRole("list", { name: "What it can do" });
    assert.equal(await can.count(), 0, "nothing in its place");
    assert.equal(await window_.locator("section").count(), 0, "no options");

    await name.fill("Foreman");
    await window_.getByLabel("What it's for").fill("Keeps things current");
    await named(page, /^Assistant/).click();
    assert.deepEqual(await can.getByRole("listitem").allInnerTexts(), ["Computer", "Web"]);
    assert.equal(await chosen(page, /^Assistant/), "true");
    assert.equal(await chosen(page, "Empty"), null);
    assert.equal((await boxOf(window_)).width, 480, "the same window");
    assert.equal(await name.inputValue(), "Foreman", "choosing again keeps what was typed");
    assert.equal(await window_.getByLabel("What it's for").inputValue(), "Keeps things current");
    await named(page, "Empty").click();
    await can.waitFor({ state: "detached" });
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
      assert.equal(await chosen(page, "Empty"), "true");
      assert.equal(await can.count(), 0);
      await named(page, /^Assistant/).click();
      await name.fill("Again");
    }
    // Opened from a template on its page, it is as clean.
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await settingsWindow(page).getByRole("button", { name: "Use" }).first().click();
    await can.getByText("Computer", { exact: true }).waitFor();
    assert.equal(await name.inputValue(), "", "what was typed went with the window");
    await page.close();
  }),
);

test(
  "an agent is offered a name no agent has, used when none is typed; a template has to be named; what it's for is optional",
  withGateway(async (gateway) => {
    // An agent already has the first name, in another case: the next is offered.
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.name = "scout";
    // Until the agents are read, none is offered and nothing can be made unnamed.
    const release = gateway.hold("agents.list");
    const page = await open(gateway);
    await plus(page).click();
    const name = panel(page).locator("#build-name");
    await name.waitFor();
    // Not a name: what the field is, greyed.
    assert.equal(await name.getAttribute("placeholder"), "Name");
    assert.equal(await named(page, "Create").isDisabled(), true);
    release();
    await agentsRead(page);
    await page.waitForFunction(
      () => document.querySelector("#build-name")?.getAttribute("placeholder") === "Wren",
    );
    // A read that fails lists none: the name offered is still one no agent has.
    gateway.refuseNext("agents.list", "unavailable", "Not now.");
    gateway.setAccount("signed_in");
    await page.locator('ul[aria-label="Agents"] li').first().waitFor({ state: "detached" });
    assert.equal(await name.getAttribute("placeholder"), "Wren", "greyed, the name it is offered");
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
    await named(page, "Create").click();
    await page.waitForURL(/#\/team\/a-7$/);
    assert.equal(
      (gateway.calls.findLast((c) => c.method === "create")?.input as { name?: string } | undefined)
        ?.name,
      "Wren",
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
    await panel(page)
      .getByRole("button", { name: /^Assistant/ })
      .click();
    // No stack until its units are read, so none is drawn from what was read before.
    await page.waitForTimeout(300);
    const can = panel(page).getByRole("list", { name: "What it can do" });
    assert.equal(await can.count(), 0);
    release();
    await can.getByText("Computer", { exact: true }).waitFor();
    await can.getByText("Web", { exact: true }).waitFor();
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
    await named(page, /^Assistant/).click();
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
  "Create has no menu: a template is made in New template, which has none either and waits for a name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await agentsRead(page);
    await plus(page).click();
    const window_ = panel(page);
    await named(page, /^Assistant/).click();
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
  "the window is Create New Agent, its title and close on one line; it is rgb(38, 38, 38), or white in the light theme, what it can do a little lighter",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    const line = await middle(window_.getByRole("heading", { name: "Create New Agent" }));
    assert.equal(
      await middle(window_.getByRole("button", { name: "Close" }).filter({ visible: true })),
      line,
    );
    await named(page, /^Assistant/).click();
    const colours = async () => [
      await window_.evaluate((e) => getComputedStyle(e).backgroundColor),
      await window_
        .getByRole("list", { name: "What it can do" })
        .getByRole("listitem")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    ];
    assert.deepEqual(await colours(), ["rgb(38, 38, 38)", "rgb(46, 46, 46)"]);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    // Once the window's own change of colour has run.
    await window_.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.deepEqual(await colours(), ["rgb(255, 255, 255)", "rgb(246, 246, 246)"]);
    await page.close();
  }),
);

test(
  "Create shows the face, the name offered and what the base or the template is; what is typed is its name, the face's letters and its line; the keyboard starts in the name",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await openCreate(page);
    const name = window_.locator("#build-name");
    const line = window_.getByLabel("What it's for");
    assert.equal(await name.evaluate((e) => e === document.activeElement), true, "the keyboard");
    assert.equal(await name.getAttribute("placeholder"), "Scout");
    // The face, with its letters.
    const disc = window_
      .locator('span[aria-hidden="true"][style*="linear-gradient(140deg"]')
      .first();
    assert.equal(await disc.innerText(), "S");
    assert.equal((await boxOf(disc)).width, 80);
    assert.equal(await line.getAttribute("placeholder"), "Chats and uses what you connect");
    await named(page, /^Assistant/).click();
    await window_.getByRole("list", { name: "What it can do" }).waitFor();
    assert.equal(await line.getAttribute("placeholder"), "Does what you ask on a computer");
    const colour = () => disc.evaluate((e) => getComputedStyle(e).backgroundImage);
    const was = await colour();
    await name.fill("Foreman");
    assert.equal(await disc.innerText(), "F");
    assert.equal(await colour(), was, "its colour stays");
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
