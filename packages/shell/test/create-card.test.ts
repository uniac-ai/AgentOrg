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
      const before = await ring(page);
      await next.click();
      const now = await moved(page, at);
      assert.equal(now, (at + 1) % 20, "the next place");
      at = now;
      const { names, alive, pictures } = await ring(page);
      // The one chosen and those beside it hold what they held.
      for (const beside of [-2, -1, 0, 1, 2]) {
        const place = (at + beside + 20) % 20;
        assert.equal(names[place], before.names[place], `${beside} from the middle`);
      }
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

    // Dragged most of a place's width to the left and let go at rest, the next one comes to the
    // middle.
    const y = rowBox.y + rowBox.height / 2;
    const x = rowBox.x + rowBox.width / 2;
    await rested(page);
    await page.mouse.move(x + 30, y);
    await page.mouse.down();
    await page.mouse.move(x - 40, y, { steps: 14 });
    await page.waitForTimeout(200);
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

/** The row has stopped: the one chosen is in the middle, whole. */
const rested = (page: Page) =>
  page.waitForFunction(() => {
    const chosen = document.querySelector('[data-slot="carousel-item"][aria-current="true"] > div');
    return chosen && Math.abs(chosen.getBoundingClientRect().width - 104) < 0.5;
  });

test(
  "a place is given a new avatar only out of sight, however fast the row is moved, and the ones just passed come back as they were: nine to the right and nine back meets the same names",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const next = window_.getByRole("button", { name: "Next avatar" });
    const previous = window_.getByRole("button", { name: "Previous avatar" });
    // From here on, every frame: a place in sight whose name changed is written down.
    await page.evaluate(() => {
      const row = document.querySelector('[data-slot="carousel"]') as Element;
      const view = row.querySelector('[data-slot="carousel-content"]') as Element;
      const swapped: number[] = [];
      (window as unknown as { swapped: number[] }).swapped = swapped;
      const last = new Map<number, string | null>();
      const look = () => {
        const { left, right } = view.getBoundingClientRect();
        row.querySelectorAll('[data-slot="carousel-item"]').forEach((one, place) => {
          const box = one.getBoundingClientRect();
          const name = one.getAttribute("aria-label");
          if (box.right <= left || box.left >= right) last.delete(place);
          else {
            if (last.has(place) && last.get(place) !== name) swapped.push(place);
            last.set(place, name);
          }
        });
        requestAnimationFrame(look);
      };
      look();
    });
    const swapped = () => page.evaluate(() => (window as unknown as { swapped: number[] }).swapped);

    const start = await ring(page);
    let at = start.chosen;
    const behind = (back: number) => (at - back + 20) % 20;
    for (let step = 1; step <= 9; step++) {
      await next.click();
      at = await moved(page, at);
    }
    // The nine passed are behind it as they were, and come back one by one.
    const there = await ring(page);
    for (let back = 1; back <= 9; back++)
      assert.equal(there.names[behind(back)], start.names[behind(back)], `${back} behind`);
    for (let back = 1; back <= 9; back++) {
      await previous.click();
      at = await moved(page, at);
      assert.equal((await ring(page)).names[at], start.names[at], `${back} back`);
    }
    assert.equal(at, start.chosen, "where it began");

    // Six presses at once, faster than the row glides: the nine behind where it stops are as
    // they were.
    const before = await ring(page);
    await next.evaluate((button: HTMLElement) => {
      for (let press = 0; press < 6; press++) button.click();
    });
    at = await moved(page, at);
    assert.equal(at, (before.chosen + 6) % 20);
    await rested(page);
    const after = await ring(page);
    for (let back = 1; back <= 9; back++)
      assert.equal(after.names[behind(back)], before.names[behind(back)], `${back} behind`);
    // Twelve at once: the choice runs more than half the ring ahead of what is drawn.
    await next.evaluate((button: HTMLElement) => {
      for (let press = 0; press < 12; press++) button.click();
    });
    at = await moved(page, at);
    await rested(page);
    const last = await ring(page);
    assert.equal(last.names.length, 20);
    assert.equal(new Set(last.names).size, 20, "no name twice");
    assert.deepEqual(last.alive, [at]);
    assert.deepEqual(await swapped(), [], "nothing in sight was given a new avatar");
    await page.close();
  }),
);

test(
  "a name in the row that an agent comes to have while the window is open gives way to another, on the same avatar",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const { names, chosen } = await ring(page);
    const beside = (chosen + 1) % 20;
    const picture = await places(page).nth(beside).locator("img").getAttribute("src");
    const [first, second] = [...gateway.agents.values()];
    assert.ok(first && second);
    first.name = (names[chosen] ?? "").toUpperCase();
    second.name = names[beside] ?? "";
    // The agents are read again.
    gateway.setAccount("signed_in");
    await page.waitForFunction(
      (was) => document.querySelector("#build-name")?.getAttribute("placeholder") !== was,
      names[chosen],
    );
    const now = await ring(page);
    assert.equal(new Set(now.names).size, 20, "no name twice");
    for (const taken of [names[chosen], names[beside]])
      assert.ok(!now.names.includes(taken ?? ""), `${taken} is an agent's now`);
    assert.equal(
      now.names.filter((name, place) => name === names[place]).length,
      18,
      "the others keep theirs",
    );
    assert.equal(now.chosen, chosen, "the same avatar is chosen");
    assert.equal(await places(page).nth(beside).locator("img").getAttribute("src"), picture);
    assert.equal(
      await window_.locator("#build-name").getAttribute("placeholder"),
      now.names[chosen],
    );
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
  "a wheel turned over the row moves it as its buttons do, one avatar a notch: down or right to the next, up or left to the one before, also from the ring's first place, and nothing behind the row scrolls",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await create(page);
    let at = (await ring(page)).chosen;
    assert.equal(at, 0, "the ring's first place");
    const over = await boxOf(row(page));
    await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2);
    // A turn of the wheel that nothing took for its own would scroll what is behind.
    await page.evaluate(() => {
      const turns = { loose: 0 };
      (window as unknown as { turns: typeof turns }).turns = turns;
      window.addEventListener("wheel", (turn) => {
        if (!turn.defaultPrevented) turns.loose++;
      });
    });
    for (const [across, down, step] of [
      [0, -100, -1],
      [0, -100, -1],
      [0, 100, 1],
      [0, 100, 1],
      [0, 100, 1],
      [100, 0, 1],
      [-100, 0, -1],
    ] as const) {
      await page.mouse.wheel(across, down);
      const now = await moved(page, at);
      assert.equal(now, (at + step + 20) % 20, `a turn of ${across}, ${down}`);
      at = now;
      await rested(page);
    }
    assert.deepEqual(
      await page.evaluate(() => [
        (window as unknown as { turns: { loose: number } }).turns.loose,
        scrollX,
        scrollY,
      ]),
      [0, 0, 0],
      "the wheel is the row's",
    );
    assert.equal((await ring(page)).names.length, 20);
    await page.close();
  }),
);

/** The card, and its Close, as they stand on the page. */
const card = (page: Page) => panel(page).getByRole("form", { name: "Create" });
const close = (page: Page) => card(page).getByRole("button", { name: "Close" });
/** The bar drawn at the window's right edge, and the one along the card's foot. */
const bar = (page: Page) => edge(page).locator("span").first();
const footBar = (page: Page) => edge(page).locator("span").last();
/**
 * Watches, frame by frame from now on, every box the card and its Close have, and every width
 * the window has; `watched` reads what was seen.
 */
const watch = (page: Page) =>
  page.evaluate(() => {
    const window_ = document.querySelector('[data-slot="dialog-content"]') as Element;
    const form = window_.querySelector('form[aria-label="Create"]') as Element;
    const button = form.querySelector('button[aria-label="Close"]') as Element;
    const seen = { card: new Set<string>(), close: new Set<string>(), widths: new Set<number>() };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const boxOf = (e: Element) => {
      const { x, y, width, height } = e.getBoundingClientRect();
      return [x, y, width, height].join(" ");
    };
    const look = () => {
      seen.card.add(boxOf(form));
      seen.close.add(boxOf(button));
      seen.widths.add(window_.getBoundingClientRect().width);
      requestAnimationFrame(look);
    };
    look();
  });
const watched = (page: Page) =>
  page.evaluate(() => {
    const { card, close, widths } = (
      window as unknown as {
        seen: { card: Set<string>; close: Set<string>; widths: Set<number> };
      }
    ).seen;
    return { card: [...card], close: [...close], widths: [...widths] };
  });
const settled = (page: Page) =>
  edge(page).evaluate((e) =>
    Promise.all(e.getAnimations({ subtree: true }).map((moving) => moving.finished)),
  );

test(
  "the window opens as the card alone and grows to the right: the card and its Close never move, what the agent can do opens at the card's right under the card's shadow, and the bar that closes it is at the window's far edge",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    assert.equal((await boxOf(window_)).width, 440);
    assert.equal(await detail(page).count(), 0, "what it can do is closed");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    const [whole, was, side] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(edge(page)),
    ];
    assert.ok(Math.abs(whole.x + whole.width / 2 - 720) < 1, "in the page's middle");
    assert.ok(Math.abs(side.x + side.width - (was.x + was.width)) < 1, "at the card's right edge");
    assert.equal(side.width, 24, "what is pressed");
    assert.ok(side.height > was.height / 2, "most of its height");
    // At rest nothing is drawn there; under the pointer a thin bar rises from the card's foot.
    assert.equal((await boxOf(bar(page))).height, 0);
    await edge(page).hover();
    await settled(page);
    const risen = await boxOf(bar(page));
    assert.deepEqual([risen.width, risen.height], [14, side.height], "thin, the edge's height");
    assert.ok(Math.abs(risen.x + risen.width - (was.x + was.width)) < 1);
    assert.equal(await ground(bar(page)), await ground(window_), "the window's other ground");
    assert.notEqual(await ground(bar(page)), await ground(card(page)));
    await page.mouse.move(8, 8);
    await settled(page);
    assert.equal((await boxOf(bar(page))).height, 0);

    // With the keyboard: the bar stands while the keyboard is on it, and Enter opens.
    await window_.getByRole("button", { name: "Create", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await edge(page).evaluate((e) => e === document.activeElement), true);
    await settled(page);
    assert.equal((await boxOf(bar(page))).height, side.height);
    await watch(page);
    await page.keyboard.press("Enter");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    await wide(page, 800);
    await page.waitForTimeout(100);
    // The window grew to the right, through every width between: the card and its Close are
    // where they were at every frame.
    const grown = await watched(page);
    assert.ok(
      grown.widths.some((width) => width > 440 && width < 800),
      "it grows, not jumps",
    );
    assert.equal(grown.card.length, 1, `the card moved: ${grown.card.join(" | ")}`);
    assert.equal(grown.close.length, 1, `Close moved: ${grown.close.join(" | ")}`);
    assert.deepEqual(await boxOf(card(page)), was);
    const open_ = await boxOf(window_);
    assert.deepEqual([open_.x, open_.y, open_.height], [whole.x, whole.y, whole.height]);

    // At the card's right, on the window's other ground: each unit, its line and what it gives.
    const shown = detail(page);
    assert.equal(await edge(page).getAttribute("aria-controls"), await shown.getAttribute("id"));
    const beside = await boxOf(shown);
    assert.ok(Math.abs(beside.x - (was.x + was.width)) < 1, "at the card's right");
    assert.equal(beside.width, 360);
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
    // The card lies over it: its shadow is on what it can do, at the card's edge, darkest
    // there and gone toward the right.
    const shade = await shown
      .locator("span[aria-hidden]")
      .first()
      .evaluate((e) => {
        const { x, width } = e.getBoundingClientRect();
        return { x, width, image: getComputedStyle(e).backgroundImage };
      });
    assert.ok(Math.abs(shade.x - beside.x) < 1 && shade.width < 40, "at the card's edge");
    assert.match(shade.image, /^linear-gradient\(to right/, shade.image);

    // The bar that closes it is at the window's far edge: out of the window at rest, and under
    // the pointer it slides in over what it can do, thin, in the card's colour.
    const far = await boxOf(edge(page));
    assert.ok(Math.abs(far.x + far.width - (open_.x + open_.width)) < 1, "the window's right");
    assert.equal(far.width, 24);
    await page.mouse.move(8, 8);
    await window_.locator("#build-name").focus();
    await settled(page);
    assert.ok((await boxOf(bar(page))).x >= open_.x + open_.width, "out of the window");
    await edge(page).hover();
    await settled(page);
    const slid = await boxOf(bar(page));
    assert.equal(slid.width, 14);
    assert.ok(Math.abs(slid.x + slid.width - (open_.x + open_.width)) < 1, "slid in");
    assert.ok(slid.x >= beside.x, "over what it can do");
    assert.equal(await ground(bar(page)), await ground(card(page)), "the card's colour");
    assert.deepEqual(await boxOf(window_), open_, "the window's size does not change");

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

    // The bar closes it back toward the card, which has not moved.
    await watch(page);
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    await wide(page, 440);
    await page.waitForTimeout(100);
    const back = await watched(page);
    assert.equal(back.card.length, 1, "the card moved");
    assert.equal(back.close.length, 1, "Close moved");
    assert.deepEqual(await boxOf(window_), whole);
    assert.equal(await detail(page).count(), 0);
    // Opened again, the window starts as the card alone.
    await edge(page).click();
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await create(page);
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    assert.deepEqual(await boxOf(window_), whole);
    await page.close();
  }),
);

test(
  "the window is always whole on the page and its card never moves: from 1064 wide what it can do is at the card's right, 296 to 360 wide; narrower it opens under the card, the window growing down",
  withGateway(async (gateway) => {
    const HEIGHT = 720;
    for (const [width, across] of [
      [1280, 800],
      [1100, 754],
      [1064, 736],
      [1024, 440],
      [800, 440],
      [700, 440],
    ] as const) {
      const beside = across > 440;
      const page = await browser().newPage({ viewport: { width, height: HEIGHT } });
      page.setDefaultTimeout(8000);
      await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
      await page.goto(`${gateway.url}/#/team`);
      const window_ = await create(page);
      /** The window's box, none of it off the page. */
      const whole = async (when: string) => {
        const box = await boxOf(window_);
        assert.ok(
          box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= HEIGHT,
          `${when}, at ${width}: ${JSON.stringify(box)}`,
        );
        return box;
      };
      const alone = await whole("the card alone");
      assert.equal(alone.width, 440);
      assert.ok(Math.abs(alone.x + 220 - width / 2) < 1, "in the page's middle");
      const [was, button] = [await boxOf(card(page)), await boxOf(close(page))];
      await edge(page).click();
      await wide(page, across);
      const open_ = await whole(`with what it can do, at ${width}`);
      assert.deepEqual(await boxOf(card(page)), was, `the card moved, at ${width}`);
      assert.deepEqual(await boxOf(close(page)), button, `Close moved, at ${width}`);
      const shown = await boxOf(detail(page));
      if (beside) {
        assert.ok(Math.abs(shown.x - (was.x + was.width)) < 1, "at the card's right");
        assert.equal(shown.width, across - 440);
        assert.ok(shown.width >= 296 && shown.width <= 360);
        assert.ok(open_.x + open_.width <= width - 16 + 0.5, "the page's margin");
        assert.ok(shown.y + shown.height <= open_.y + open_.height + 0.5);
        const far = await boxOf(edge(page));
        assert.ok(Math.abs(far.x + far.width - (open_.x + open_.width)) < 1);
      } else {
        assert.equal(open_.y, alone.y, "the window grows down");
        assert.ok(shown.y >= was.y + was.height - 1, "under the card");
        assert.equal(shown.width, was.width);
        // What does not fit under the card is reached by scrolling the window.
        const reached = await window_.evaluate((e) => {
          e.scrollTop = e.scrollHeight;
          const within = e.getBoundingClientRect().bottom;
          const end = (e.querySelector("#create-detail") as Element).getBoundingClientRect().bottom;
          e.scrollTop = 0;
          return end <= within + 0.5;
        });
        assert.equal(reached, true, `its end is reached, at ${width}`);
      }
      // None of its words run past it.
      assert.equal(
        await detail(page).evaluate((e) =>
          [...e.querySelectorAll("li, h3")].some(
            (one) => one.getBoundingClientRect().right > e.getBoundingClientRect().right + 0.5,
          ),
        ),
        false,
        `cut at ${width}`,
      );
      await edge(page).click();
      await wide(page, 440);
      assert.equal(await detail(page).count(), 0);
      assert.deepEqual(await whole("closed again"), alone);
      await page.close();
    }
  }),
);

test(
  "on a phone the bar is along the card's foot, thin and there without a pointer over it, and what the agent can do opens under it with the card and its Close where they were",
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
    const [was, button, under] = [
      await boxOf(card(page)),
      await boxOf(close(page)),
      await boxOf(edge(page)),
    ];
    assert.equal(under.width, was.width, "as wide as the card");
    assert.ok(Math.abs(under.y - (was.y + was.height)) < 1, "along its foot");
    assert.equal(under.height, 24, "what is pressed");
    const drawn = await boxOf(footBar(page));
    assert.equal(drawn.height, 14, "thin, and drawn at rest");
    assert.ok(Math.abs(drawn.y + drawn.height - (under.y + under.height)) < 1);
    assert.equal(await ground(footBar(page)), await ground(window_));
    assert.equal(await detail(page).count(), 0);
    await edge(page).tap();
    const shown = await boxOf(detail(page));
    assert.ok(shown.y >= under.y + under.height - 1, "under the bar");
    assert.equal(shown.width, was.width);
    assert.deepEqual(await boxOf(card(page)), was, "the card stays");
    assert.deepEqual(await boxOf(close(page)), button, "Close stays");
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) => text.split("\n")[0]),
      ["Computer", "Web"],
    );
    // The card's shadow falls down on it.
    assert.match(
      await detail(page)
        .locator("span[aria-hidden]")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundImage),
      /^linear-gradient\((?!to (right|left|top))/,
    );
    await edge(page).tap();
    assert.equal(await detail(page).count(), 0);
    assert.deepEqual(await boxOf(card(page)), was);
    await page.close();
  }),
);

test(
  "with reduced motion the window is at its width at once, the edge's bar is there at once, rising or sliding, and the row's buttons move it with no glide",
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
    assert.equal(await moves(bar(page)), false);
    await edge(page).click();
    assert.equal((await boxOf(window_)).width, 800, "at once");
    assert.equal(await moves(bar(page)), false, "the bar that closes it does not slide");
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

    // Without it, the window's width, the bar's rise and its slide take time.
    const plain = await open(gateway);
    await create(plain);
    assert.equal(await moves(panel(plain)), true);
    assert.equal(await moves(bar(plain)), true);
    await edge(plain).click();
    await wide(plain, 800);
    assert.equal(await moves(bar(plain)), true);
    await plain.close();
  }),
);
