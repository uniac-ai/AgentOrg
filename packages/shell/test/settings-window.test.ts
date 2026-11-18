// Settings in a real browser, over the stand-in gateway: a window over the place being looked at,
// its sections down the left and the chosen one's contents at the right.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { openSetup } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(
  gateway: Gateway,
  hash = "#/",
  viewport = WIDE,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
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
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const sections = (page: Page) => settings(page).getByRole("navigation", { name: "Settings" });
const choose = (page: Page, name: string) =>
  sections(page).getByRole("button", { name, exact: true }).click();
/** The rows marked as the section chosen. */
const marked = (page: Page) => sections(page).locator('[aria-current="true"]').allInnerTexts();
/**
 * A place of the bar, by its markup: under the open window the bar is out of the reach of what a
 * screen reader is told, but still there.
 */
const place = (page: Page, name: string) =>
  page.locator(`nav[aria-label="Main"] button[aria-label^="${name}"]`);
/** A window has finished opening: nothing in it is measured before. */
const opened = (window: Locator) =>
  window.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
const openSettings = async (page: Page) => {
  await place(page, "Settings").click();
  await opened(settings(page));
};
/** A part's box as [x, y, width, height]. */
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height] as [number, number, number, number];
};

test(
  "the Settings icon opens a window over the place, which stays behind it as it was, at its address; the icon is never the current place",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/team/a-reviewer");
    await page.getByRole("main").getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await openSettings(page);
    // About 860 by 600, in the middle of the screen.
    assert.deepEqual(await boxOf(settings(page)), [290, 150, 860, 600]);
    // The place is behind it as it was, and the address is still the place's.
    assert.equal(await page.locator("main h1").first().innerText(), "Team");
    assert.equal(await page.locator("main h1").nth(1).innerText(), "Reviewer");
    assert.match(page.url(), /#\/team\/a-reviewer$/);
    assert.equal(await place(page, "Team").getAttribute("aria-current"), "page");
    assert.equal(await place(page, "Settings").getAttribute("aria-current"), null);
    assert.equal(await place(page, "Settings").getAttribute("aria-expanded"), "true");
    // Its left is 220 wide, on the canvas colour with a hairline at its right, under "Settings".
    const left = sections(page);
    assert.deepEqual((await boxOf(left)).slice(0, 3), [290, 150, 220]);
    assert.deepEqual(
      await left.evaluate((e) => {
        const style = getComputedStyle(e);
        return [style.backgroundColor, style.borderRightWidth];
      }),
      ["rgb(25, 25, 25)", "1px"],
    );
    assert.deepEqual(
      await left
        .getByRole("heading", { name: "Settings" })
        .evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]),
      ["17px", "600"],
    );
    await page.close();
  }),
);

/**
 * The Settings window on the frame after a change: its box, its background, and what of it and of
 * what is behind it is still moving, read at one moment.
 */
const nextFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ box: number[]; background: string; moving: string[] }>((done) =>
        requestAnimationFrame(() => {
          const window = document.querySelector('[role="dialog"]') as HTMLElement;
          const behind = document.querySelector('[data-slot="dialog-overlay"]');
          const box = window.getBoundingClientRect();
          done({
            box: [box.x, box.y, box.width, box.height],
            background: getComputedStyle(window).backgroundColor,
            moving: [...window.getAnimations(), ...(behind?.getAnimations() ?? [])].map((one) =>
              one instanceof CSSTransition ? one.transitionProperty : "animation",
            ),
          });
        }),
      ),
  );

test(
  "the window keeps its shape as the screen changes, with nothing gliding: a phone's at once, and wide again at once; a new theme's colours at once",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    await page.setViewportSize(PHONE);
    assert.deepEqual(await nextFrame(page), {
      box: [0, 0, PHONE.width, PHONE.height],
      background: "rgb(35, 35, 35)",
      moving: [],
    });
    await page.setViewportSize(WIDE);
    assert.deepEqual(await nextFrame(page), {
      box: [290, 150, 860, 600],
      background: "rgb(35, 35, 35)",
      moving: [],
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    assert.deepEqual(await nextFrame(page), {
      box: [290, 150, 860, 600],
      background: "rgb(255, 255, 255)",
      moving: [],
    });
    await page.close();
  }),
);

test(
  "the five sections are listed down the left; choosing one shows its contents at the right and marks its row",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    assert.deepEqual(await sections(page).getByRole("button").allInnerTexts(), [
      "Templates",
      "Skills",
      "MCP connections",
      "Providers",
      "Account",
    ]);
    assert.deepEqual(await marked(page), ["Templates"]);
    const shown = (name: string) => settings(page).getByRole("region", { name, exact: true });
    await shown("Templates").getByText("Assistant", { exact: true }).waitFor();
    // The right part is what the left leaves of the window.
    assert.deepEqual((await boxOf(shown("Templates"))).slice(0, 3), [510, 150, 640]);
    let was = "Templates";
    for (const [name, says] of [
      ["Skills", "cite-sources"],
      ["MCP connections", "GitHub acme"],
      ["Providers", "Agent providers"],
      ["Account", "ChatGPT"],
    ] as const) {
      await choose(page, name);
      await shown(name).getByText(says, { exact: true }).first().waitFor();
      assert.deepEqual(await marked(page), [name]);
      assert.equal(await shown(was).count(), 0, `${name} in ${was}'s place`);
      was = name;
    }
    await page.close();
  }),
);

test(
  "it opens on Templates the first time, and then on the section last looked at",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await openSettings(page);
    assert.deepEqual(await marked(page), ["Templates"]);
    await choose(page, "Providers");
    await page.keyboard.press("Escape");
    await settings(page).waitFor({ state: "detached" });
    await openSettings(page);
    assert.deepEqual(await marked(page), ["Providers"]);
    await settings(page).getByRole("region", { name: "Providers", exact: true }).waitFor();
    await page.close();
  }),
);

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
  "Escape closes it, and so does a click outside it; the keyboard goes back to where it was",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await openSettings(page);
    await page.keyboard.press("Escape");
    await settings(page).waitFor({ state: "detached" });
    assert.equal(await focused(), "Settings");
    await openSettings(page);
    await page.mouse.click(1300, 450);
    await settings(page).waitFor({ state: "detached" });
    assert.equal(await focused(), "Settings");
    await page.close();
  }),
);

test(
  "it opens and closes in the page's window times, fading and growing a little; with reduced motion it only fades",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await place(page, "Settings").waitFor();
    const times = await page.evaluate(() =>
      ["--window-open", "--window-close"].map((name) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      ),
    );
    assert.deepEqual(times, ["220ms", "160ms"]);
    const motion = (part: Locator, phase: "enter" | "exit") =>
      part.evaluate((e, which) => {
        const style = getComputedStyle(e);
        // The scale it grows from, or shrinks to, as a number.
        const scale = style.getPropertyValue(`--tw-${which}-scale`).replace(/\s/g, "");
        const percent = /^calc\((\d+)\*1%\)$/.exec(scale)?.[1];
        return [
          style.animationName,
          style.animationDuration,
          percent ? Number(percent) / 100 : Number(scale),
        ];
      }, phase);
    const overlay = page.locator('[data-slot="dialog-overlay"]');
    await place(page, "Settings").click();
    assert.deepEqual(await motion(settings(page), "enter"), ["enter", "0.22s", 0.96]);
    assert.equal((await motion(overlay, "enter"))[1], "0.22s", "what is behind it fades as long");
    await opened(settings(page));
    await page.keyboard.press("Escape");
    const closing = page.locator('[data-slot="dialog-content"][data-state="closed"]');
    assert.deepEqual(await motion(closing, "exit"), ["exit", "0.16s", 0.96]);
    await settings(page).waitFor({ state: "detached" });
    await page.close();

    const reduced = await open(gateway, "#/", WIDE, "reduce");
    await place(reduced, "Settings").click();
    assert.deepEqual(await motion(settings(reduced), "enter"), ["enter", "0.22s", 1]);
    await reduced.close();
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
    await create.getByRole("button", { name: "Empty" }).click();
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

test(
  "on a phone it takes the screen: the sections first, with a close; then a section, with Settings to go back and a close",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/", PHONE);
    await openSettings(page);
    assert.deepEqual(await boxOf(settings(page)), [0, 0, PHONE.width, PHONE.height]);
    const close = settings(page).getByRole("button", { name: "Close" }).filter({ visible: true });
    assert.equal(await close.count(), 1);
    assert.equal(await settings(page).getByRole("region").isVisible(), false, "no section yet");
    // On its own the list marks none of its rows.
    assert.equal(
      await sections(page)
        .getByRole("button", { name: "Templates" })
        .evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await choose(page, "Skills");
    const skills = settings(page).getByRole("region", { name: "Skills" });
    await skills.getByText("cite-sources", { exact: true }).waitFor();
    assert.equal(await sections(page).isVisible(), false, "the section alone");
    assert.equal(await close.count(), 1);
    await skills.getByRole("button", { name: "Add skill" }).waitFor();
    await skills.getByRole("button", { name: "Settings" }).click();
    await sections(page).waitFor();
    assert.equal(await skills.isVisible(), false);
    await page.close();
  }),
);
