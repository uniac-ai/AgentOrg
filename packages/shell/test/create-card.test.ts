// Create's card: the avatar and name Create sends, the badge of the template it starts from with
// the card that opens over it, and a long name. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { badge, open, startFrom, withBrowser, withGateway } from "./build-kit.ts";
import { card, create, ground, moved, picture, places, ring, sent } from "./create-card-kit.ts";
import { boxOf } from "./create-window-kit.ts";

withBrowser();

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
