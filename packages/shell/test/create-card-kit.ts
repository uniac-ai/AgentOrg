// What the tests of Create's card share: the window at rest, its row of avatars and the places in
// it, the name card and its bar, and the walk through the page's sizes.
import assert from "node:assert/strict";
import { toSvg } from "@agentorg/2dlivebot";
import type { Locator, Page } from "@playwright/test";
import { agentsRead, detail, edge, type Gateway, panel, plus } from "./build-kit.ts";
import { boxOf, opened, wide } from "./create-window-kit.ts";

/** Create from Team's own button, at rest once its stack is drawn and its row has an avatar alive. */
export async function create(page: Page) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page).getByRole("button", { name: "Create", exact: true }).waitFor();
  await places(page).and(page.locator('[aria-current="true"]')).locator("svg").waitFor();
  await opened(page);
  return panel(page);
}
export const row = (page: Page) => panel(page).getByRole("region", { name: "Avatar" });
/** The row's places, in the ring's order: each holds an avatar and is named by its name. */
export const places = (page: Page) => row(page).locator('[data-slot="carousel-item"]');
/** The row as it stands: each place's name, whether it is alive or a picture, and the choice. */
export const ring = (page: Page) =>
  places(page).evaluateAll((all) => ({
    names: all.map((one) => one.getAttribute("aria-label") ?? ""),
    alive: all.flatMap((one, at) => (one.querySelector("svg") ? [at] : [])),
    pictures: all.filter((one) => one.querySelector("img")).length,
    chosen: all.findIndex((one) => one.getAttribute("aria-current") === "true"),
  }));
/** The row has come to rest on another place than `was`. */
export const moved = async (page: Page, was: number) => {
  await page.waitForFunction((before) => {
    const all = [...document.querySelectorAll('[data-slot="carousel-item"]')];
    const now = all.findIndex((one) => one.getAttribute("aria-current") === "true");
    return now !== -1 && now !== before && !!all[now]?.querySelector("svg");
  }, was);
  return (await ring(page)).chosen;
};
export const sent = (gateway: Gateway) =>
  gateway.calls.findLast((c) => c.method === "create")?.input as
    | { name?: string; avatar?: string; purpose?: string }
    | undefined;
export const picture = (avatar: string) =>
  `data:image/svg+xml,${encodeURIComponent(toSvg(avatar))}`;
export const ground = (part: Locator) => part.evaluate((e) => getComputedStyle(e).backgroundColor);

/** The row has stopped: the one chosen is in the middle, whole. */
export const rested = (page: Page) =>
  page.waitForFunction(() => {
    const chosen = document.querySelector('[data-slot="carousel-item"][aria-current="true"] > div');
    return chosen && Math.abs(chosen.getBoundingClientRect().width - 104) < 0.5;
  });

/** The name card, and its Close, as they stand on the page. */
export const card = (page: Page) => panel(page).getByRole("form", { name: "Create" });
export const close = (page: Page) => card(page).getByRole("button", { name: "Close" });
/**
 * The bar: a tab under the name card that comes out at its right edge. Its first part is the
 * name card's shadow on it, its second what comes out, with the arrow.
 */
export const tab = (page: Page) => panel(page).locator("[data-edge-bar]");
/** The bar under the card, along the card's foot. */
export const footBar = (page: Page) => edge(page).locator("span").first();
/** The bar has stopped sliding. */
export const still = (page: Page) =>
  tab(page).evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
/** Which way the bar's arrow points. */
export const arrow = (page: Page) =>
  tab(page)
    .locator("svg")
    .evaluate((e) => (getComputedStyle(e).rotate === "180deg" ? "back" : "out"));
/** A colour the window's tokens name, as an element would be painted in it. */
export const token = (page: Page, name: string) =>
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
export const watch = (page: Page) =>
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
export const watched = (page: Page) =>
  page.evaluate(() => {
    const { card, widths } = (
      window as unknown as { seen: { card: Set<string>; widths: Set<number> } }
    ).seen;
    return { card: [...card], widths: [...widths] };
  });
/**
 * Listens for the window's width growing by its own transition; what it gives back says how, once
 * the window is at its width: "grew" if the transition ended or was cut after it had moved (the
 * page's own timer cuts a slow one short, which still grew), else why it was a jump. Events are
 * sent as a frame begins, so none heard by the second look, a frame later, means it never started.
 */
export const listen = async (page: Page) => {
  const heard = await panel(page).evaluateHandle((window_: HTMLElement) => {
    const heard: { how?: string } = {};
    for (const type of ["transitionrun", "transitionend", "transitioncancel"] as const)
      window_.addEventListener(type, (event) => {
        if (event.target !== window_ || event.propertyName !== "width") return;
        const moved = type === "transitionend" || event.elapsedTime > 0;
        heard.how = type === "transitionrun" ? "" : moved ? "grew" : "was cut before it moved";
      });
    return heard;
  });
  const look = (heard: { how?: string }) => {
    const how = heard.how;
    heard.how ??= "never started";
    return how;
  };
  return async () => (await page.waitForFunction(look, heard)).jsonValue();
};

/** The page's sizes the window is looked at in: its widths, then three of them on short pages. */
export const WIDTHS = [
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
export const SHORT = [
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
export async function looksRight(page: Page, width: number, height: number) {
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
