// Create's row of avatars as it is moved fast, and by the wheel: a place is given a new avatar only
// out of sight, and the ones just passed come back as they were. In a real browser over the
// stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { open, withBrowser, withGateway } from "./build-kit.ts";
import { create, moved, rested, ring, row } from "./create-card-kit.ts";
import { boxOf } from "./create-window-kit.ts";

withBrowser();

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
