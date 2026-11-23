// Create's card: the row of avatars an agent is chosen from, each with a name; the badge of the
// template it starts from, and the card that opens over it; and the card's right edge, which opens
// what the agent can do beside it. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { toSvg } from "@agentorg/2dlivebot";
import type { Locator, Page } from "@playwright/test";
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

/** The name card, and its Close, as they stand on the page. */
const card = (page: Page) => panel(page).getByRole("form", { name: "Create" });
const close = (page: Page) => card(page).getByRole("button", { name: "Close" });
/**
 * The bar: a tab under the name card that comes out at its right edge. Its first part is the
 * name card's shadow on it, its second what comes out, with the arrow.
 */
const tab = (page: Page) => panel(page).locator("[data-edge-bar]");
/** The bar under the card, along the card's foot. */
const footBar = (page: Page) => edge(page).locator("span").first();
/** The bar has stopped sliding. */
const still = (page: Page) =>
  tab(page).evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
/** Which way the bar's arrow points. */
const arrow = (page: Page) =>
  tab(page)
    .locator("svg")
    .evaluate((e) => (getComputedStyle(e).rotate === "180deg" ? "back" : "out"));
/** A colour the window's tokens name, as an element would be painted in it. */
const token = (page: Page, name: string) =>
  page.evaluate((variable) => {
    const probe = document.createElement("i");
    probe.style.backgroundColor = `var(${variable})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);
/**
 * Watches, frame by frame from now on, every box the name card has and every width the window
 * has; `watched` reads what was seen.
 */
const watch = (page: Page) =>
  page.evaluate(() => {
    const window_ = document.querySelector('[data-slot="dialog-content"]') as Element;
    const form = window_.querySelector('form[aria-label="Create"]') as Element;
    const seen = { card: new Set<string>(), widths: new Set<number>() };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const look = () => {
      const { x, y, width, height } = form.getBoundingClientRect();
      seen.card.add([x, y, width, height].join(" "));
      seen.widths.add(window_.getBoundingClientRect().width);
      requestAnimationFrame(look);
    };
    look();
  });
const watched = (page: Page) =>
  page.evaluate(() => {
    const { card, widths } = (
      window as unknown as { seen: { card: Set<string>; widths: Set<number> } }
    ).seen;
    return { card: [...card], widths: [...widths] };
  });

test(
  "the bar that opens what the agent can do is a second card's edge under the name card: with the pointer or the keyboard on the card's right edge it slides out to the right with the card's light shadow on it, and the name card keeps its box and its outline",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    assert.equal(await detail(page).count(), 0, "what it can do is closed");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    const [whole, was, side] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(edge(page)),
    ];
    const right = was.x + was.width;
    assert.deepEqual(whole, was, "the window is the name card");
    assert.equal(was.width, 440);
    assert.ok(Math.abs(was.x + 220 - 720) < 1, "in the page's middle");
    // What is pressed: the card's last 24 below its head row.
    assert.deepEqual([side.x, side.width], [right - 24, 24]);
    assert.ok(side.y >= was.y + 56 && side.height > was.height / 2);

    // The bar is its own surface under the name card: not part of it, and painted beneath it.
    const beneath = await tab(page).evaluate((e) => {
      const form = document.querySelector('form[aria-label="Create"]') as Element;
      return {
        apart: !form.contains(e) && e.parentElement === form.parentElement,
        under: Number(getComputedStyle(e).zIndex) < Number(getComputedStyle(form).zIndex),
        corners: getComputedStyle(e).borderTopRightRadius,
        outline: getComputedStyle(form).borderRadius,
      };
    });
    assert.deepEqual(beneath, { apart: true, under: true, corners: "24px", outline: "24px" });
    assert.equal(await ground(tab(page)), await token(page, "--create"), "the other ground");
    assert.notEqual(await ground(tab(page)), await ground(card(page)));
    // At rest all of it, with the card's shadow on it, is behind the card.
    const shade = tab(page).locator("span").first();
    const hidden = await boxOf(tab(page));
    assert.ok(hidden.x >= was.x && hidden.x + hidden.width <= right + 0.5, "behind the card");
    assert.ok((await boxOf(shade)).x + 14 <= right + 0.5, "its shadow too");

    // With the pointer on the edge it slides out to the right, 14 of it, as the card's own
    // height and with the card's corners: the name card's box and outline are as they were,
    // and the window is no wider.
    await watch(page);
    await edge(page).hover();
    await still(page);
    await page.waitForTimeout(50);
    const out = await boxOf(tab(page));
    assert.ok(Math.abs(out.x + out.width - (right + 14)) < 0.5, "14 beyond the card's edge");
    assert.deepEqual([out.y, out.height], [was.y, was.height], "the card's height");
    const seen = await watched(page);
    assert.equal(seen.card.length, 1, `the card moved or grew: ${seen.card.join(" | ")}`);
    assert.deepEqual(seen.widths, [440], "the window is no wider");
    assert.equal(
      await card(page).evaluate((e) => getComputedStyle(e).borderRadius),
      "24px",
      "the card's outline",
    );
    // Its arrow points out, in the part that is out; the card's shadow lies on that part,
    // from the card's edge.
    const part = await boxOf(tab(page).locator("span").nth(1));
    assert.ok(Math.abs(part.x - right) < 0.5 && part.width === 14);
    assert.equal(await arrow(page), "out");
    const lit = await shade.evaluate((e) => {
      const { x, width } = e.getBoundingClientRect();
      return { x, width, image: getComputedStyle(e).backgroundImage };
    });
    assert.ok(Math.abs(lit.x - right) < 0.5 && lit.width === 14, "on the part that is out");
    assert.match(lit.image, /^linear-gradient\(to right/);
    assert.match(lit.image, /0\.14\)/, "very light");
    // What is pressed keeps its left edge and reaches the bar's end.
    const pressed = await boxOf(edge(page));
    assert.deepEqual([pressed.x, pressed.width], [side.x, 38]);
    await page.mouse.move(8, 8);
    await still(page);
    assert.ok((await boxOf(tab(page))).x + hidden.width <= right + 0.5, "back under the card");

    // With the keyboard on it, the same.
    await window_.getByRole("button", { name: "Create", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await edge(page).evaluate((e) => e === document.activeElement), true);
    await still(page);
    assert.ok(Math.abs((await boxOf(tab(page))).x + hidden.width - (right + 14)) < 0.5);
    await page.close();
  }),
);

test(
  "pressed, the window opens as two cards in the page's middle: the name card, moved left with its Close, lying over what the agent can do, on which its light shadow falls; the bar that closes it is at the same place, the name card's right edge, with its arrow pointing back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const [was, button, side] = [
      await boxOf(card(page)),
      await boxOf(close(page)),
      await boxOf(edge(page)),
    ];
    await watch(page);
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    await wide(page, 800);
    await page.waitForTimeout(100);
    assert.ok(
      (await watched(page)).widths.some((width) => width > 440 && width < 800),
      "it grows, not jumps",
    );
    // Both together in the page's middle: the name card has moved left by half of what opened.
    const [whole, now, shown] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(detail(page)),
    ];
    assert.ok(Math.abs(whole.x + whole.width / 2 - 720) < 1, "in the page's middle");
    assert.deepEqual(
      [now.x, now.y, now.width, now.height],
      [was.x - 180, was.y, 440, was.height],
      "the name card, moved left",
    );
    const moved_ = await boxOf(close(page));
    assert.deepEqual(
      [moved_.x - now.x, moved_.y - now.y],
      [button.x - was.x, button.y - was.y],
      "Close is where it was on the card",
    );
    // What it can do is a card of its own under the name card: it starts under the card's edge
    // and ends at the window's, with its own corners, on the window's other ground.
    const right = now.x + now.width;
    assert.ok(shown.x < right && shown.x >= right - 40, "tucked under the card's edge");
    assert.ok(Math.abs(shown.x + shown.width - (whole.x + whole.width)) < 0.5);
    assert.equal(shown.x + shown.width - right, 360, "360 of it at the card's right");
    assert.deepEqual(
      await detail(page).evaluate((e) => {
        const form = document.querySelector('form[aria-label="Create"]') as Element;
        return [
          getComputedStyle(e).borderRadius,
          Number(getComputedStyle(e).zIndex) < Number(getComputedStyle(form).zIndex),
        ];
      }),
      ["24px", true],
    );
    assert.equal(await ground(detail(page)), await token(page, "--create"));
    assert.equal(await edge(page).getAttribute("aria-controls"), "create-detail");
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) =>
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
    assert.equal(await detail(page).getByRole("listitem").first().locator("svg").count(), 3);
    assert.equal(
      await detail(page)
        .locator("input, textarea, select, button, [role=combobox], [role=switch]")
        .count(),
      0,
      "shown, not asked",
    );
    // The name card's shadow on it: from the card's edge, 20 wide, very light.
    const shade = detail(page).locator("span[aria-hidden]").first();
    const lit = await shade.evaluate((e) => {
      const { x, width } = e.getBoundingClientRect();
      return { x, width, image: getComputedStyle(e).backgroundImage };
    });
    assert.ok(Math.abs(lit.x - right) < 0.5 && lit.width === 20, "at the card's edge");
    assert.match(lit.image, /^linear-gradient\(to right/);
    assert.match(lit.image, /0\.14\)/, "black at 14 in a hundred, in the dark theme");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    assert.match(
      await shade.evaluate((e) => getComputedStyle(e).backgroundImage),
      /0\.04\)/,
      "and at 4 in the light one",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });

    // The bar that closes it: what is pressed is where it was on the name card, and nothing is
    // at the window's far edge. At rest it is behind the card.
    await page.mouse.move(8, 8);
    await window_.locator("#build-name").focus();
    await still(page);
    const again = await boxOf(edge(page));
    assert.deepEqual(
      [again.x - now.x, again.y - now.y, again.width, again.height],
      [side.x - was.x, side.y - was.y, 24, side.height],
      "at the same place on the name card",
    );
    assert.equal(await window_.locator("[data-edge]").count(), 1, "the one control");
    assert.ok(again.x + again.width < whole.x + whole.width - 300, "none at the far edge");
    assert.ok((await boxOf(tab(page))).x + 56 <= right + 0.5, "behind the card at rest");
    // Under the pointer it slides out the same way, over the start of what it can do, and its
    // arrow points back; nothing of the list is under it, and nothing moves or changes size.
    await edge(page).hover();
    await still(page);
    const out = await boxOf(tab(page));
    assert.ok(Math.abs(out.x + out.width - (right + 14)) < 0.5, "14 beyond the card's edge");
    assert.equal(await arrow(page), "back");
    assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    const first = await boxOf(detail(page).getByRole("listitem").first());
    assert.ok(first.x >= right + 14, "the list is clear of it");
    assert.ok((await boxOf(detail(page).getByRole("heading"))).x >= right + 14);
    assert.deepEqual(await boxOf(window_), whole, "the window as it was");
    assert.deepEqual(await boxOf(card(page)), now, "the name card as it was");

    // A unit nobody offers here is named by its id, and holds Create back.
    await startFrom(page, "From elsewhere");
    assert.deepEqual(
      (await detail(page).getByRole("listitem").allInnerTexts()).map((text) =>
        text.split("\n").filter(Boolean),
      ),
      [["mystery", "Not available here."]],
    );
    assert.equal(
      await window_.getByRole("button", { name: "Create", exact: true }).isDisabled(),
      true,
    );
    await startFrom(page, "Empty");
    assert.equal(await detail(page).getByRole("listitem").count(), 0);
    await detail(page).getByText("Nothing yet.").waitFor();

    // Pressed again it closes: the name card alone, back in the page's middle, no shadow left.
    await edge(page).click();
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    await wide(page, 440);
    await page.waitForTimeout(500);
    assert.deepEqual(await boxOf(card(page)), was);
    assert.equal(await detail(page).count(), 0);
    assert.equal(await window_.locator("#create-detail > span[aria-hidden]").count(), 0);
    assert.equal(
      await window_.locator("#create-detail").evaluate((e) => getComputedStyle(e).visibility),
      "hidden",
      "not drawn behind the card",
    );
    // Opened again, the window starts as the card alone.
    await edge(page).click();
    await page.keyboard.press("Escape");
    await window_.waitFor({ state: "detached" });
    await create(page);
    assert.equal(await edge(page).getAttribute("aria-expanded"), "false");
    assert.deepEqual(await boxOf(window_), was);
    await page.close();
  }),
);

/** The page's sizes the window is looked at in: its widths, then three of them on short pages. */
const WIDTHS = [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
  [1100, 800],
  [1024, 768],
  [900, 800],
  [800, 800],
  [700, 800],
  [560, 800],
  [430, 900],
  [390, 844],
] as const;
const SHORT = [
  [1280, 720],
  [1280, 600],
  [1280, 480],
  [800, 720],
  [800, 600],
  [800, 480],
  [390, 720],
  [390, 600],
  [390, 480],
] as const;

/**
 * The window at one size of the page, closed and open: whole on the page with its margins and in
 * its middle, nothing in the card's head row or its row of avatars over another, Create in view,
 * and what it can do where the page's width says: beside the card from 768, as wide as the page
 * leaves it up to 360, and under the card below that.
 */
async function looksRight(page: Page, width: number, height: number) {
  const at = `at ${width} by ${height}`;
  await page.setViewportSize({ width, height });
  const window_ = await create(page);
  const inside = async (when: string) => {
    const box = await boxOf(window_);
    assert.ok(
      box.x >= 16 - 0.5 &&
        box.y >= 16 - 0.5 &&
        box.x + box.width <= width - 16 + 0.5 &&
        box.y + box.height <= height - 16 + 0.5,
      `${when}, ${at}: ${JSON.stringify(box)}`,
    );
    assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 1, `in the middle across, ${at}`);
    assert.ok(Math.abs(box.y + box.height / 2 - height / 2) < 1, `in the middle down, ${at}`);
    return box;
  };
  /** Nothing of the head row or the row of avatars is over another, and Create is in view. */
  const tidy = async (when: string) => {
    const said = await window_.evaluate((e) => {
      const over = (a: DOMRect, b: DOMRect) =>
        a.left < b.right - 0.5 &&
        b.left < a.right - 0.5 &&
        a.top < b.bottom - 0.5 &&
        b.top < a.bottom - 0.5;
      const boxOf = (part: Element | null) => (part as Element).getBoundingClientRect();
      const form = e.querySelector('form[aria-label="Create"]') as Element;
      const badge = boxOf(form.querySelector('[aria-label^="Template:"]'));
      const shut = boxOf(form.querySelector('button[aria-label="Close"]'));
      const places = [...form.querySelectorAll('[data-slot="carousel-item"]')];
      const chosen = places.findIndex((one) => one.getAttribute("aria-current") === "true");
      const faces = [-1, 0, 1].map((step) =>
        boxOf(
          (places[(chosen + step + places.length) % places.length] as Element).firstElementChild,
        ),
      );
      const turns = [
        boxOf(form.querySelector('[data-slot="carousel-previous"]')),
        boxOf(form.querySelector('[data-slot="carousel-next"]')),
      ];
      const make = boxOf(
        [...form.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Create") ??
          null,
      );
      const name = form.querySelector("#build-name") as HTMLElement;
      const card = boxOf(form);
      return {
        head: over(badge, shut),
        row: turns.some((turn) => faces.some((face) => over(turn, face))),
        faces:
          over(faces[0] as DOMRect, faces[1] as DOMRect) ||
          over(faces[1] as DOMRect, faces[2] as DOMRect),
        largest: (faces[1] as DOMRect).width > (faces[0] as DOMRect).width,
        whole: faces.every((face) => face.left >= card.left && face.right <= card.right),
        create: make.top >= 0 && make.bottom <= innerHeight && make.bottom <= card.bottom + 0.5,
        name: name.tagName === "INPUT" && name.offsetHeight <= 34,
      };
    });
    assert.deepEqual(
      said,
      {
        head: false,
        row: false,
        faces: false,
        largest: true,
        whole: true,
        create: true,
        name: true,
      },
      `${when}, ${at}`,
    );
  };
  const alone = await inside("the card alone");
  assert.equal(alone.width, Math.min(440, width - 32), `the card's width, ${at}`);
  await tidy("closed");
  const [was, button] = [await boxOf(card(page)), await boxOf(close(page))];
  // The avatars: 104 across, or 88 on a card narrower than 440.
  assert.equal(
    (await boxOf(panel(page).locator('[data-slot="carousel-item"][aria-current="true"] > div')))
      .width,
    width < 480 ? 88 : 104,
    `the chosen avatar, ${at}`,
  );

  await edge(page).click();
  const beside = width >= 768;
  const across = beside ? Math.min(360, width - 472) : 0;
  await wide(page, alone.width + across);
  await page.waitForTimeout(450);
  const open_ = await inside("with what it can do");
  await tidy("open");
  const [now, moved_, shown] = [
    await boxOf(card(page)),
    await boxOf(close(page)),
    await boxOf(detail(page)),
  ];
  assert.deepEqual(
    [moved_.x - now.x, moved_.y - now.y],
    [button.x - was.x, button.y - was.y],
    `Close is where it was on the card, ${at}`,
  );
  assert.equal(now.width, was.width, `the card's width, ${at}`);
  if (beside) {
    assert.ok(across >= 296, `room for what it can do, ${at}`);
    assert.equal(shown.x + shown.width - (now.x + now.width), across, `its width, ${at}`);
    assert.ok(Math.abs(shown.x + shown.width - (open_.x + open_.width)) < 0.5);
    assert.deepEqual([shown.y, shown.height], [now.y, now.height], `as tall as the card, ${at}`);
  } else {
    assert.ok(shown.y >= now.y + now.height - 0.5, `under the card, ${at}`);
    assert.equal(shown.width, now.width, `as wide as the card, ${at}`);
    // What does not fit under the card is reached by scrolling the window.
    const reached = await window_.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      const within = e.getBoundingClientRect().bottom;
      const end = (e.querySelector("#create-detail") as Element).getBoundingClientRect().bottom;
      e.scrollTop = 0;
      return end <= within + 0.5;
    });
    assert.equal(reached, true, `its end is reached, ${at}`);
  }
  // None of its words run past it, and the page does not scroll sideways.
  assert.deepEqual(
    await detail(page).evaluate((e) => [
      [...e.querySelectorAll("li, h3")].some(
        (one) => one.getBoundingClientRect().right > e.getBoundingClientRect().right + 0.5,
      ),
      document.documentElement.scrollWidth > innerWidth,
    ]),
    [false, false],
    `cut, or the page scrolls sideways, ${at}`,
  );
  // The control that closes it is in view, on the page.
  const control = await boxOf(edge(page));
  assert.ok(
    control.x >= 0 &&
      control.x + control.width <= width &&
      control.y >= 0 &&
      control.y + control.height <= height,
    `the control, ${at}`,
  );
  await page.keyboard.press("Escape");
  await window_.waitFor({ state: "detached" });
}

test(
  "the window is laid out by the page's width, whole and in the page's middle at each: 1920, 1440, 1280, 1100, 1024, 900 and 800 with what it can do beside the card, 700, 560, 430 and 390 with it under the card",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of WIDTHS) await looksRight(page, width, height);
    await page.close();
  }),
);

test(
  "on short pages the window is still whole, with Create in view: 1280, 800 and 390 wide at 720, 600 and 480 tall",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of SHORT) await looksRight(page, width, height);
    await page.close();
  }),
);

test(
  "a page resized with what the agent can do open changes the window's layout at once, with no width in between: beside the card at 900, under it at 700, and back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.setViewportSize({ width: 900, height: 800 });
    const window_ = await create(page);
    await edge(page).click();
    await wide(page, 800);
    // Once it has opened, its width no longer takes time.
    await page.waitForTimeout(500);
    const frame = () =>
      page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
    for (const [width, across, beside] of [
      [700, 440, false],
      [900, 800, true],
      [780, 748, true],
      [760, 440, false],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await frame();
      const [whole, name, shown] = [
        await boxOf(window_),
        await boxOf(card(page)),
        await boxOf(detail(page)),
      ];
      assert.equal(whole.width, across, `at once, at ${width}`);
      assert.ok(Math.abs(whole.x + whole.width / 2 - width / 2) < 1, `in the middle, at ${width}`);
      assert.ok(whole.x >= 16 - 0.5 && whole.x + whole.width <= width - 16 + 0.5);
      if (beside) assert.equal(shown.x + shown.width - (name.x + name.width), across - 440);
      else assert.ok(shown.y >= name.y + name.height - 0.5, `under the card, at ${width}`);
      assert.equal(await edge(page).getAttribute("aria-expanded"), "true");
    }
    await page.close();
  }),
);

test(
  "a long name stays on one line, cut short with an ellipsis until it is typed in again, and what it's for is at most two lines",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const window_ = await create(page);
    const name = window_.locator("#build-name");
    const line = window_.getByLabel("What it's for");
    const [high, tall] = [(await boxOf(name)).height, (await boxOf(card(page))).height];
    await name.fill("Bartholomew the agent whose name is far longer than a card is wide");
    await line.fill(
      "Keeps every dependency of every repository current, opens the pull requests, answers the reviews and reports each morning on what moved and what did not",
    );
    await line.blur();
    assert.equal((await boxOf(name)).height, high, "one line");
    assert.deepEqual(
      await name.evaluate((e: HTMLInputElement) => [
        getComputedStyle(e).textOverflow,
        e.scrollWidth > e.clientWidth,
      ]),
      ["ellipsis", true],
    );
    assert.ok((await boxOf(line)).height <= 40, "two lines at most");
    assert.ok((await boxOf(card(page))).height <= tall + 20, "the card barely taller");
    assert.ok(
      (await boxOf(name)).x >= (await boxOf(card(page))).x &&
        (await boxOf(name)).x + (await boxOf(name)).width <=
          (await boxOf(card(page))).x + (await boxOf(card(page))).width,
    );
    await page.close();
  }),
);

test(
  "where nothing hovers the bar stands out at the name card's right, closed and open, and the window is no wider for it",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    const window_ = await create(page);
    const [whole, was, out] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(tab(page)),
    ];
    assert.deepEqual(whole, was, "the window is the name card");
    assert.ok(Math.abs(was.x + 220 - 640) < 1, "in the page's middle");
    assert.ok(Math.abs(out.x + out.width - (was.x + was.width + 14)) < 0.5, "out at rest");
    assert.equal(await arrow(page), "out");
    assert.equal((await boxOf(edge(page))).width, 38, "pressed to the bar's end");
    await edge(page).tap();
    await wide(page, 800);
    await page.waitForTimeout(100);
    const now = await boxOf(card(page));
    assert.ok(
      Math.abs((await boxOf(tab(page))).x + out.width - (now.x + now.width + 14)) < 0.5,
      "still out, at the name card's right",
    );
    assert.equal(await arrow(page), "back");
    await page.close();
  }),
);

test(
  "on a phone the bar is along the card's foot, thin and there without a pointer over it, and what the agent can do opens under it, the taller window in the page's middle",
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
    assert.equal(await tab(page).isVisible(), false, "no bar at the card's side");
    assert.equal(under.width, was.width, "as wide as the card");
    assert.ok(Math.abs(under.y - (was.y + was.height)) < 1, "along its foot");
    assert.equal(under.height, 24, "what is pressed");
    const drawn = await boxOf(footBar(page));
    assert.equal(drawn.height, 14, "thin, and drawn at rest");
    assert.ok(Math.abs(drawn.y + drawn.height - (under.y + under.height)) < 1);
    assert.equal(await ground(footBar(page)), await token(page, "--create"));
    // The name is its own size, larger than the line under it.
    assert.deepEqual(
      await window_.evaluate((e) => [
        getComputedStyle(e.querySelector("#build-name") as Element).fontSize,
        getComputedStyle(e.querySelector("textarea") as Element).fontSize,
      ]),
      ["22px", "16px"],
    );
    assert.equal(await detail(page).count(), 0);
    await edge(page).tap();
    const [whole, now, shown] = [
      await boxOf(window_),
      await boxOf(card(page)),
      await boxOf(detail(page)),
    ];
    assert.ok(Math.abs(whole.y + whole.height / 2 - 390) < 1, "in the page's middle");
    assert.ok(shown.y >= now.y + now.height + 24 - 1, "under the bar");
    assert.equal(shown.width, was.width);
    const moved_ = await boxOf(close(page));
    assert.deepEqual([moved_.x - now.x, moved_.y - now.y], [button.x - was.x, button.y - was.y]);
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
  "with reduced motion the bar is out at once and the window is at its width at once, and the row's buttons move it with no glide",
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
    const right = async () => {
      const box = await boxOf(card(page));
      return box.x + box.width;
    };
    assert.equal(await moves(tab(page)), false, "the bar does not slide");
    await edge(page).hover();
    assert.ok(Math.abs((await boxOf(tab(page))).x + 56 - ((await right()) + 14)) < 0.5, "at once");
    await edge(page).click();
    assert.equal(await moves(window_), false, "the window's width takes no time");
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

    // Without it, the bar's slide takes time, and so does the window's width as it opens.
    const plain = await open(gateway);
    await create(plain);
    assert.equal(await moves(tab(plain)), true);
    assert.equal(await moves(panel(plain)), false, "not at rest");
    await edge(plain).click();
    assert.equal(await moves(panel(plain)), true, "while it opens");
    await plain.close();
  }),
);
