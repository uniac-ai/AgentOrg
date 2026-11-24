// The ways into Settings' window and out of it: each section's action, an old Settings address,
// Setup's way to connect an MCP, and the creation window opened over it.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import { openSetup } from "./design/samples.ts";
import {
  boxOf,
  choose,
  marked,
  open,
  opened,
  openSettings,
  place,
  settings,
  withGateway,
} from "./settings-window-kit.ts";

withBrowser();

test(
  "each section's action is on its top line with the close, centred on it, and does what it did",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    const [x, y, width] = await boxOf(settings(page));
    const close = settings(page).getByRole("button", { name: "Close" }).filter({ visible: true });
    for (const [section, action, opens] of [
      ["Templates", "New template", "New template"],
      ["Skills", "Add skill", "Add skill"],
      ["MCP connections", "Connect", "Connect an MCP"],
    ] as const) {
      await choose(page, section);
      const button = settings(page).getByRole("button", { name: action, exact: true });
      const [ax, ay, aw, ah] = await boxOf(button);
      const [cx, cy, cw, ch] = await boxOf(close);
      // One line 48 tall at the window's top, the action then the close at its right.
      assert.equal(ay + ah / 2, y + 24, `${action} on the line's middle`);
      assert.equal(cy + ch / 2, y + 24, "the close on the line's middle");
      assert.ok(ax + aw <= cx, `${action} left of the close`);
      assert.equal(cx + cw, x + width - 8, "the close at the line's end");
      assert.equal((await button.innerText()).trim(), action, "in words");
      // It does what it did: it opens its window over Settings.
      await button.click();
      const over = page.getByRole("dialog", { name: opens });
      await opened(over);
      await page.keyboard.press("Escape");
      await over.waitFor({ state: "detached" });
      await settings(page).waitFor();
    }
    for (const section of ["Providers", "Account"]) {
      await choose(page, section);
      await settings(page).getByRole("region", { name: section, exact: true }).waitFor();
      assert.equal(await close.count(), 1);
      assert.equal(
        await settings(page)
          .getByRole("button", { name: /^(New template|Add skill|Connect)$/ })
          .count(),
        0,
        `${section} offers nothing`,
      );
    }
    await page.close();
  }),
);

test(
  "an old Settings address opens the window on what it names, over the place behind it or Chat, and the address becomes that place's",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/skills/s/cite-sources");
    await opened(settings(page));
    assert.deepEqual(await marked(page), ["Skills"]);
    // What it names is marked in its section.
    const named = settings(page).getByRole("listitem").filter({ hasText: "cite-sources" });
    assert.equal(
      await named.evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgba(255, 255, 255, 0.08)",
    );
    assert.match(page.url(), /#\/chat$/);
    await page.locator('main section[aria-label="Chats"]').waitFor();
    // Its adding form opens over it.
    await page.goto(`${gateway.url}/#/mcps/add`);
    const form = page.getByRole("dialog", { name: "Connect an MCP" });
    await opened(form);
    assert.match(page.url(), /#\/chat$/);
    await page.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });
    assert.deepEqual(await marked(page), ["MCP connections"]);
    await page.keyboard.press("Escape");
    await settings(page).waitFor({ state: "detached" });
    // Over a place, the address goes back to the place's; going to another place closes it.
    await page.evaluate(() => {
      location.hash = "#/team/a-reviewer";
    });
    await page.getByRole("main").getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await page.evaluate(() => {
      location.hash = "#/settings/account";
    });
    await settings(page).getByRole("region", { name: "Account" }).waitFor();
    assert.match(page.url(), /#\/team\/a-reviewer$/);
    await page.evaluate(() => {
      location.hash = "#/chat";
    });
    await settings(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "Setup's way to connect a new MCP puts Setup away and opens the window straight on MCP connections",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team/a-reviewer");
    const sheet = await openSetup(page, "Reviewer");
    await sheet.getByRole("button", { name: "Add an MCP" }).click();
    await page.getByRole("menuitem", { name: "Connect a new MCP…" }).click();
    await opened(settings(page));
    assert.deepEqual(await marked(page), ["MCP connections"]);
    await settings(page).getByRole("region", { name: "MCP connections" }).waitFor();
    await sheet.waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "Use and New template open the creation window over Settings; a saved template comes back to Templates; a new agent closes both and is shown in Team",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const windows = page.locator('[data-slot="dialog-content"]');
    await openSettings(page);
    const templates = settings(page).getByRole("region", { name: "Templates" });
    await templates
      .getByRole("listitem")
      .filter({ hasText: "Assistant" })
      .getByRole("button", { name: "Use" })
      .click();
    const create = page.getByRole("dialog", { name: "Create" });
    await opened(create);
    assert.equal(await windows.count(), 2, "over Settings, which stays");
    // From nothing, to make one with the name it offers.
    await create.getByRole("button", { name: /^Template:/ }).click();
    await page.getByRole("menuitemradio", { name: /^Empty/ }).click();
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/#\/team\/a-6$/);
    await windows.first().waitFor({ state: "detached" });
    await page.getByRole("main").getByRole("heading", { level: 1 }).nth(1).waitFor();

    await openSettings(page);
    await settings(page).getByRole("button", { name: "New template", exact: true }).click();
    const making = page.getByRole("dialog", { name: "New template" });
    await opened(making);
    await making.getByLabel("Name").fill("Release helper");
    await making.getByRole("button", { name: "Save template" }).click();
    await making.waitFor({ state: "detached" });
    assert.deepEqual(await marked(page), ["Templates"]);
    await templates.getByText("Release helper", { exact: true }).waitFor();
    await page.close();
  }),
);
