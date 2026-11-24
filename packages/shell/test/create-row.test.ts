// Create's row of avatars: twenty of them, each with a name no agent has, the one in the middle
// alive; it goes round with no end, and a name an agent comes to have gives way. In a real browser
// over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { NAMES } from "../src/fixed/names.ts";
import { open, withBrowser, withGateway } from "./build-kit.ts";
import { create, moved, places, rested, ring, row } from "./create-card-kit.ts";
import { boxOf } from "./create-window-kit.ts";

withBrowser();

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
