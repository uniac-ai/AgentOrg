// Create's card: the row of avatars an agent is chosen from, each with a name; the badge of the
// template it starts from, and the card that opens over it; and the card's right edge, which opens
// what the agent can do beside it. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { toSvg } from "2dlivebot";
import { NAMES } from "../src/fixed/names.ts";
import {
  agentsRead,
  badge,
  browser,
  detail,
  edge,
  type Gateway,
  open,
  panel,
  plus,
  SESSION,
  startFrom,
  withBrowser,
  withGateway,
} from "./build-kit.ts";
import { boxOf, opened, wide } from "./create-window-kit.ts";

withBrowser();

/** Create from Team's own button, at rest once its stack is drawn and its row has an avatar alive. */
async function create(page: Page) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  await places(page).and(page.locator('[aria-current="true"]')).locator("svg").waitFor();
  await opened(page);
  return panel(page);
}
const row = (page: Page) => panel(page).getByRole("region", { name: "Avatar" });
/** The row's places, in the ring's order: each holds an avatar and is named by its name. */
const places = (page: Page) => row(page).locator('[data-slot="carousel-item"]');
/** The row as it stands: each place's name, whether it is alive or a picture, and the choice. */
const ring = (page: Page) =>
  places(page).evaluateAll((all) => ({
    names: all.map((one) => one.getAttribute("aria-label") ?? ""),
    alive: all.flatMap((one, at) => (one.querySelector("svg") ? [at] : [])),
    pictures: all.filter((one) => one.querySelector("img")).length,
    chosen: all.findIndex((one) => one.getAttribute("aria-current") === "true"),
  }));
/** The row has come to rest on another place than `was`. */
const moved = async (page: Page, was: number) => {
  await page.waitForFunction((before) => {
    const all = [...document.querySelectorAll('[data-slot="carousel-item"]')];
    const now = all.findIndex((one) => one.getAttribute("aria-current") === "true");
    return now !== -1 && now !== before && !!all[now]?.querySelector("svg");
  }, was);
  return (await ring(page)).chosen;
};
const sent = (gateway: Gateway) =>
  gateway.calls.findLast((c) => c.method === "create")?.input as
    | { name?: string; avatar?: string; purpose?: string }
    | undefined;
const picture = (avatar: string) => `data:image/svg+xml,${encodeURIComponent(toSvg(avatar))}`;
const ground = (part: Locator) => part.evaluate((e) => getComputedStyle(e).backgroundColor);

test(
  "the row holds twenty avatars, each with a name of its own that no agent has; the one in the middle is alive and offers its name, the others are still pictures",
  withGateway(async (gateway) => {
    // Agents hold the list's first names, in any case: none of them is offered.
    const held = ["scout", "WREN", "Juniper", "Cedar", "Maple"];
    [...gateway.agents.values()].forEach((agent, i) => {
      agent.name = held[i] ?? agent.name;
    });
    const page = await open(gateway);
    const window_ = await create(page);
    const { names, alive, pictures, chosen } = await ring(page);
    assert.equal(names.length, 20);
    assert.equal(new Set(names).size, 20, "no name twice");
    const taken = new Set([...gateway.agents.values()].map((agent) => agent.name.toLowerCase()));
    for (const name of names) {
      assert.ok(NAMES.includes(name), name);
      assert.ok(!taken.has(name.toLowerCase()), `${name} is an agent's`);
    }
    assert.deepEqual(alive, [chosen], "the one in the middle alone is alive");
    assert.equal(pictures, 19);
    // Its name is the one offered, and it is in the row's middle, the largest and plain to see.
    assert.equal(await window_.locator("#build-name").getAttribute("placeholder"), names[chosen]);
    const middle = await boxOf(places(page).nth(chosen).locator("div").first());
    const whole = await boxOf(row(page));
    assert.ok(Math.abs(middle.x + middle.width / 2 - (whole.x + whole.width / 2)) < 1);
    assert.equal(middle.width, 104);
    // Toward the sides they are smaller and fainter, and none is turned.
    const beside = places(page)
      .nth((chosen + 1) % 20)
      .locator("div")
      .first();
    assert.ok((await boxOf(beside)).width < middle.width);
    const drawn = await beside.evaluate((e) => {
      const { transform, opacity } = getComputedStyle(e);
      const matrix = new DOMMatrix(transform);
      return { flat: matrix.is2D && matrix.b === 0 && matrix.c === 0, opacity: Number(opacity) };
    });
    assert.equal(drawn.flat, true);
    assert.ok(drawn.opacity > 0 && drawn.opacity < 1);
    await page.close();
  }),
);

test(
  "the row has no end either way: its buttons, the arrow keys and a drag move it, the one that comes to the middle becomes alive, and there are never more than twenty, with new ones where the old were",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const first = await ring(page);
    let at = first.chosen;
    const next = window_.getByRole("button", { name: "Next avatar" });
    // The buttons lie over the row's sides and take no room: the row is as wide with them.
    const [rowBox, nextBox] = [await boxOf(row(page)), await boxOf(next)];
    assert.ok(nextBox.x >= rowBox.x && nextBox.x + nextBox.width <= rowBox.x + rowBox.width + 0.5);
    // Twenty-five to the right: once round, and on.
    for (let step = 1; step <= 25; step++) {
      await next.click();
      const now = await moved(page, at);
      assert.equal(now, (at + 1) % 20, "the next place");
      at = now;
      const { names, alive, pictures } = await ring(page);
      assert.equal(names.length, 20, "never more than twenty");
      assert.equal(new Set(names).size, 20, "no name twice");
      assert.deepEqual(alive, [at]);
      assert.equal(pictures, 19);
      assert.equal(await window_.locator("#build-name").getAttribute("placeholder"), names[at]);
    }
    // Every place has come round, and holds a new avatar with a new name.
    const after = await ring(page);
    const kept = after.names.filter((name, place) => name === first.names[place]).length;
    assert.ok(kept <= 2, `${kept} places still hold the name they began with`);

    // To the left, by its other button, then by the arrow keys with the keyboard on the row.
    await window_.getByRole("button", { name: "Previous avatar" }).click();
    assert.equal(await moved(page, at), (at + 19) % 20);
    at = (at + 19) % 20;
    await row(page).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await moved(page, at), (at + 19) % 20);
    at = (at + 19) % 20;
    await page.keyboard.press("ArrowRight");
    assert.equal(await moved(page, at), (at + 1) % 20);
    at = (at + 1) % 20;

    // Dragged a place's width to the left, the next one comes to the middle.
    const y = rowBox.y + rowBox.height / 2;
    const x = rowBox.x + rowBox.width / 2;
    await page.mouse.move(x + 30, y);
    await page.mouse.down();
    await page.mouse.move(x - 80, y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await moved(page, at), (at + 1) % 20);
    // A press on one at the side brings it to the middle.
    at = (at + 1) % 20;
    await places(page)
      .nth((at + 19) % 20)
      .click();
    assert.equal(await moved(page, at), (at + 19) % 20);
    assert.equal((await ring(page)).names.length, 20);
    await page.close();
  }),
);

test(
  "Create sends the avatar in the middle with its name; a name typed stays as the row moves, and is sent with the avatar then in the middle",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const name = window_.locator("#build-name");
    const { names, chosen } = await ring(page);
    // The one at its right, as its still picture shows it, comes to the middle and is sent.
    const beside = (chosen + 1) % 20;
    const shown = await places(page).nth(beside).locator("img").getAttribute("src");
    await window_.getByRole("button", { name: "Next avatar" }).click();
    assert.equal(await moved(page, chosen), beside);
    assert.equal(await name.getAttribute("placeholder"), names[beside]);
    assert.equal(await name.inputValue(), "", "offered, not typed");
    await window_.getByRole("button", { name: "Create", exact: true }).click();
    await window_.waitFor({ state: "detached" });
    const first = sent(gateway);
    assert.equal(first?.name, names[beside]);
    assert.match(first?.avatar ?? "", /^v1(\.[a-z0-9]+(-[0-9a-f]{6})*)*$/);
    assert.ok((first?.avatar ?? "").length <= 512);
    assert.equal(picture(first?.avatar ?? ""), shown, "the avatar that was shown");

    // A name typed is kept while the row moves; its avatar is the one then in the middle.
    await create(page);
    await name.fill("Foreman");
    const again = await ring(page);
    assert.ok(!again.names.includes(first?.name ?? ""), "the name just given is an agent's now");
    const before = (again.chosen + 19) % 20;
    const picked = await places(page).nth(before).locator("img").getAttribute("src");
    await window_.getByRole("button", { name: "Previous avatar" }).click();
    assert.equal(await moved(page, again.chosen), before);
    assert.equal(await name.inputValue(), "Foreman");
    await window_.getByRole("button", { name: "Create", exact: true }).click();
    await window_.waitFor({ state: "detached" });
    assert.equal(sent(gateway)?.name, "Foreman");
    assert.equal(picture(sent(gateway)?.avatar ?? ""), picked);
    await page.close();
  }),
);

test(
  "the template is a badge at the card's top left, on the Assistant; a card opens over it with Empty and the templates, each with what it is, and choosing one starts from it and keeps what was typed",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const [card, at] = [await boxOf(window_), await boxOf(badge(page))];
    assert.equal(await badge(page).textContent(), "Assistant");
    assert.ok(at.x - card.x <= 16 && at.y - card.y <= 16, "at the top left");
    assert.ok(at.height <= 28 && at.width < 140, "small");
    assert.equal(await badge(page).locator("svg").count(), 1, "with its sign");
    // Under the pointer its ground changes, a little.
    const rest = await ground(badge(page));
    await badge(page).hover();
    await page.waitForFunction((was) => {
      const one = document.querySelector('[aria-label^="Template:"]');
      return one && getComputedStyle(one).backgroundColor !== was;
    }, rest);

    // Its card opens in place, its heading where the badge is: opening it chooses nothing.
    await badge(page).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    await menu.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    const over = await boxOf(menu);
    assert.ok(Math.abs(over.x - at.x) <= 1 && Math.abs(over.y - at.y) <= 1, "over the badge");
    const offered = menu.getByRole("menuitemradio");
    assert.deepEqual(
      (await offered.allInnerTexts()).map((text) => text.split("\n")),
      [
        ["Empty", "Nothing to start with"],
        ["Assistant", "Does what you ask on a computer"],
        ["From elsewhere", "Made on another home"],
      ],
    );
    assert.deepEqual(
      await offered.evaluateAll((all) => all.map((one) => one.getAttribute("aria-checked"))),
      ["false", "true", "false"],
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await badge(page).textContent(), "Assistant");
    await window_.waitFor();

    // Chosen, the agent starts from it; what was typed and the avatar chosen stay.
    await window_.locator("#build-name").fill("Foreman");
    await window_.getByLabel("What it's for").fill("Keeps things current");
    const { names, chosen } = await ring(page);
    await startFrom(page, "Empty");
    assert.equal(await badge(page).textContent(), "Empty");
    assert.equal(await badge(page).getAttribute("aria-label"), "Template: Empty");
    assert.equal(await window_.locator("#build-name").inputValue(), "Foreman");
    assert.equal(await window_.getByLabel("What it's for").inputValue(), "Keeps things current");
    assert.deepEqual(await ring(page).then((now) => [now.names, now.chosen]), [names, chosen]);
    await window_.getByRole("button", { name: "Create", exact: true }).click();
    await window_.waitFor({ state: "detached" });
    assert.deepEqual((sent(gateway) as { stack?: unknown } | undefined)?.stack, {
      base: { provider: "bundled", creatable: "assistant" },
      units: [],
    });
    await page.close();
  }),
);

test(
  "with no Assistant among the templates the card opens on Empty",
  withGateway(async (gateway) => {
    gateway.emptyLists();
    const page = await open(gateway);
    await create(page);
    assert.equal(await badge(page).textContent(), "Empty");
    await badge(page).click();
    assert.deepEqual(await page.getByRole("menu").getByRole("menuitemradio").allInnerTexts(), [
      "Empty\nNothing to start with",
    ]);
    await page.close();
  }),
);

test(
  "the window opens as the card alone; its right edge, under the pointer or the keyboard, shows a strip of the window's other ground rising from the foot, and pressed it opens what the agent can do beside the card, and closes it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    assert.equal((await boxOf(window_)).width, 440);
    assert.equal(await detail(page).count(), 0, "what it can do is closed");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    const card = await boxOf(window_.getByRole("form", { name: "Create" }));
    const side = await boxOf(edge(page));
    assert.ok(Math.abs(side.x + side.width - (card.x + card.width)) < 1, "at the right edge");
    assert.ok(side.height > card.height / 2, "most of its height");
    // At rest nothing is drawn there; under the pointer the strip is as tall as the edge.
    const strip = edge(page).locator("span");
    const settled = () =>
      edge(page).evaluate((e) =>
        Promise.all(e.getAnimations({ subtree: true }).map((moving) => moving.finished)),
      );
    assert.equal((await boxOf(strip)).height, 0);
    await edge(page).hover();
    await settled();
    assert.equal((await boxOf(strip)).height, side.height);
    assert.equal(await ground(strip), await ground(window_), "the window's other ground");
    assert.notEqual(await ground(strip), await ground(window_.getByRole("form")));
    await page.mouse.move(8, 8);
    await settled();
    assert.equal((await boxOf(strip)).height, 0);

    // With the keyboard: the strip stands while the keyboard is on it, and Enter opens.
    await window_.getByRole("button", { name: "Create", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await edge(page).evaluate((e) => e === document.activeElement), true);
    await settled();
    assert.equal((await boxOf(strip)).height, side.height);
    await page.keyboard.press("Enter");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    await wide(page, 800);
    // Beside the card, on the window's other ground: each unit, its line and what it gives.
    const shown = detail(page);
    assert.equal(await edge(page).getAttribute("aria-controls"), await shown.getAttribute("id"));
    const beside = await boxOf(shown);
    assert.ok(Math.abs(beside.x - (card.x + card.width - 180)) < 1, "at the card's right");
    assert.deepEqual(
      (await shown.getByRole("listitem").allInnerTexts()).map((text) =>
        text.split("\n").filter(Boolean),
      ),
      [
        [
          "Computer",
          "Terminal, files and a browser",
          "computer, browser",
          "terminal, files, computer, browser",
        ],
        ["Web", "Search and fetch", "web", "web-research"],
      ],
    );
    assert.equal(await shown.getByRole("listitem").first().locator("svg").count(), 3);
    assert.equal(
      await shown
        .locator("input, textarea, select, button, [role=combobox], [role=switch]")
        .count(),
      0,
      "shown, not asked",
    );
    // A unit nobody offers here is named by its id, and holds Create back.
    await startFrom(page, "From elsewhere");
    assert.deepEqual(
      (await shown.getByRole("listitem").allInnerTexts()).map((text) =>
        text.split("\n").filter(Boolean),
      ),
      [["mystery", "Not available here."]],
    );
    assert.equal(
      await window_.getByRole("button", { name: "Create", exact: true }).isDisabled(),
      true,
    );
    await startFrom(page, "Empty");
    assert.equal(await shown.getByRole("listitem").count(), 0);
    await shown.getByText("Nothing yet.").waitFor();

    // The same edge closes it.
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    await wide(page, 440);
    assert.equal(await detail(page).count(), 0);
    // Opened again, the window starts as the card alone.
    await edge(page).click();
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await create(page);
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    assert.equal((await boxOf(window_)).width, 440);
    await page.close();
  }),
);

test(
  "on a phone the edge is a bar along the card's foot, there without a pointer over it, and what the agent can do opens under the card",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const card = await boxOf(window_.getByRole("form", { name: "Create" }));
    const bar = await boxOf(edge(page));
    assert.equal(bar.width, card.width, "as wide as the card");
    assert.ok(Math.abs(bar.y + bar.height - (card.y + card.height)) < 1, "along its foot");
    assert.ok(bar.y >= (await boxOf(window_.getByRole("button", { name: "Create" }))).y + 40);
    assert.equal((await boxOf(edge(page).locator("span"))).height, bar.height, "drawn at rest");
    assert.equal(await detail(page).count(), 0);
    await edge(page).tap();
    // The window is taller now, and the card higher in it.
    const [under, above] = [
      await boxOf(detail(page)),
      await boxOf(window_.getByRole("form", { name: "Create" })),
    ];
    assert.ok(under.y >= above.y + above.height - 1, "under the card");
    assert.equal(under.width, above.width);
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) => text.split("\n")[0]),
      ["Computer", "Web"],
    );
    await edge(page).tap();
    assert.equal(await detail(page).count(), 0);
    await page.close();
  }),
);

test(
  "with reduced motion the window widens at once, the edge's strip is there at once, and the row's buttons move it with no glide",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const moves = (part: Locator) =>
      part.evaluate((e) => {
        const { transitionProperty, transitionDuration } = getComputedStyle(e);
        return transitionProperty !== "none" && transitionDuration !== "0s";
      });
    assert.equal(await moves(window_), false);
    assert.equal(await moves(edge(page).locator("span")), false);
    await edge(page).click();
    assert.equal((await boxOf(window_)).width, 800, "at once");
    // The row is on its next place in the very frame after the press.
    const { chosen } = await ring(page);
    const beside = places(page)
      .nth((chosen + 1) % 20)
      .locator("div")
      .first();
    await window_.getByRole("button", { name: "Next avatar" }).click();
    await moved(page, chosen);
    assert.equal((await boxOf(beside)).width, 104, "whole, in the middle");
    await page.close();

    // Without it, the window's width and the strip's height take time.
    const plain = await open(gateway);
    await create(plain);
    assert.equal(await moves(panel(plain)), true);
    assert.equal(await moves(edge(plain).locator("span")), true);
    await plain.close();
  }),
);
