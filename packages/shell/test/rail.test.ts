// The rail beside the creation window's options, in a real browser over the stand-in gateway: one
// logo for each section, joined by a line that lights as the options scroll.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import {
  agentsRead,
  browser,
  type Gateway,
  open,
  panel,
  plus,
  SESSION,
  withBrowser,
  withGateway,
} from "./build-kit.ts";

withBrowser();

const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within;
const rail = (page: Page) => panel(page).getByRole("navigation", { name: "Sections" });
const logo = (page: Page, name: string) => rail(page).getByRole("button", { name, exact: true });

/** The window has finished opening: its own animations, as it grows to its size, are over. */
const opened = (page: Page) =>
  panel(page).evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).then(() => undefined),
  );

/** Create, from the Assistant template: Base, Computer, Web and Add, once the window is open. */
async function assistant(page: Page) {
  await agentsRead(page);
  await plus(page).click();
  await panel(page)
    .getByRole("button", { name: /^Assistant/ })
    .click();
  await panel(page).getByRole("region", { name: "Base", exact: true }).waitFor();
  await opened(page);
  // The pointer away from the rail.
  await page.mouse.move(700, 880);
}

/**
 * What the rail shows and where each heading's stop is, read at one moment. With `settle`, read
 * two frames on, once a scroll has been answered: its event comes before the first frame's
 * callbacks, and what it changes is drawn by the second.
 */
const read = (page: Page, settle = true) =>
  panel(page).evaluate(async (window, settle) => {
    if (settle)
      for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done));
    const nav = window.querySelector('nav[aria-label="Sections"]') as HTMLElement;
    const box = nav.previousElementSibling as HTMLElement;
    const top =
      box.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(box).paddingTop);
    const headings = [...box.querySelectorAll("[data-heading]")];
    const logos = [...nav.querySelectorAll("button")];
    const lines = [...nav.querySelectorAll("[data-line]")];
    // As 0 to 255 each, whether it reads rgb() or, mixed, color(srgb) from 0 to 1.
    const rgb = (e: Element) => {
      const color = getComputedStyle(e).color;
      const parts = (color.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3);
      return color.startsWith("color(") ? parts.map((n) => n * 255) : parts;
    };
    return {
      scroll: box.scrollTop,
      end: box.scrollHeight - box.clientHeight,
      stops: headings.map((h) => h.getBoundingClientRect().top - top + box.scrollTop),
      headingTops: headings.map((h) => h.getBoundingClientRect().top - top),
      labels: logos.map((b) => b.getAttribute("aria-label")),
      current: logos.findIndex((b) => b.getAttribute("aria-current") === "true"),
      scale: logos.map((b) => new DOMMatrix(getComputedStyle(b).transform).a),
      color: logos.map(rgb),
      lit: lines.map(
        (l) =>
          (l.querySelector("[data-lit]") as HTMLElement).getBoundingClientRect().height /
          l.getBoundingClientRect().height,
      ),
      opacity: Number(getComputedStyle(nav).opacity),
      labelOpacity: Number(getComputedStyle(logos[0]?.querySelector("span") as Element).opacity),
      scrolling: nav.hasAttribute("data-scrolling"),
    };
  }, settle);
type Read = Awaited<ReturnType<typeof read>>;
/** Halfway between a heading's stop and the next one's. */
const between = (at: Read, i: number) => ((at.stops[i] ?? 0) + (at.stops[i + 1] ?? 0)) / 2;

/** The options scrolled to a place, as a wheel would leave them. */
const scrollTo = (page: Page, y: number) =>
  panel(page).evaluate((window, to) => {
    const box = window.querySelector('nav[aria-label="Sections"]')?.previousElementSibling;
    if (box) box.scrollTop = to;
  }, y);
/** The rail's own fades are over. */
const faded = (page: Page) =>
  rail(page).evaluate((nav) =>
    Promise.all(nav.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined),
  );
/** Two colours, much the same. */
const alike = (a: number[], b: number[]) => a.every((n, i) => near(n, b[i] ?? -1, 4));
const fixed = (list: number[]) => list.map((n) => n.toFixed(3)).join(" ");

test(
  "one logo for each section of the options, in their order, at half opacity at rest",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    const at = await read(page);
    assert.deepEqual(at.labels, ["Base", "Computer", "Web", "Add"]);
    assert.equal(at.current, 0, "the first is current");
    assert.ok(near(at.opacity, 0.5, 0.01), `half opacity (${at.opacity})`);
    assert.ok(near(at.labelOpacity, 0, 0.01), "no labels");
    // What to start from is above the scroll and has no logo; the options scroll with no bar.
    assert.equal(
      await panel(page).evaluate((window) => {
        const box = window.querySelector('nav[aria-label="Sections"]')?.previousElementSibling;
        return box && getComputedStyle(box).scrollbarWidth;
      }),
      "none",
    );
    await page.close();
  }),
);

test(
  "halfway between two headings, half of their connector is lit and the two logos share the brightness and the growth; at a heading, its logo alone",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    const at = await read(page);
    await scrollTo(page, between(at, 0));
    const mid = await read(page);
    assert.ok(near(mid.lit[0] ?? 0, 0.5, 0.05), `about half lit: ${fixed(mid.lit)}`);
    assert.ok(
      mid.lit.slice(1).every((n) => n < 0.01),
      `those below dark: ${fixed(mid.lit)}`,
    );
    assert.ok(
      near(mid.scale[0] ?? 0, 1.03, 0.006) &&
        near(mid.scale[1] ?? 0, 1.03, 0.006) &&
        mid.scale.slice(2).every((s) => near(s, 1, 0.001)),
      `the two share the growth, about 3% each: ${fixed(mid.scale)}`,
    );
    assert.ok(
      alike(mid.color[0] ?? [], mid.color[1] ?? []) &&
        !alike(mid.color[1] ?? [], mid.color[2] ?? []),
      `the two share the brightness: ${JSON.stringify(mid.color)}`,
    );

    // Scrolled on to the next heading: its logo is grown 6% and current, the connector above lit.
    await scrollTo(page, at.stops[1] ?? 0);
    const onIt = await read(page);
    assert.ok(near(onIt.scale[1] ?? 0, 1.06, 0.002), `grown 6%: ${fixed(onIt.scale)}`);
    assert.ok(
      onIt.scale.every((s, i) => i === 1 || near(s, 1, 0.001)),
      `the others not: ${fixed(onIt.scale)}`,
    );
    assert.equal(onIt.labels[onIt.current], "Computer");
    assert.ok(
      (onIt.lit[0] ?? 0) > 0.99 && onIt.lit.slice(1).every((n) => n < 0.01),
      `the connector above it lit whole: ${fixed(onIt.lit)}`,
    );

    // Further on, the lines passed stay lit.
    await scrollTo(page, between(at, 2));
    const further = await read(page);
    assert.ok(
      (further.lit[0] ?? 0) > 0.99 && (further.lit[1] ?? 0) > 0.99,
      `those passed lit: ${fixed(further.lit)}`,
    );
    assert.ok(near(further.lit[2] ?? 0, 0.5, 0.05), `the current half: ${fixed(further.lit)}`);
    await page.close();
  }),
);

/** Create on a page whose clock the test moves. */
async function openOnClock(gateway: Gateway): Promise<Page> {
  const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.clock.install();
  await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
  await page.goto(`${gateway.url}/#/team`);
  return page;
}
/** The page has answered what is queued: two tasks on, past anything rendering has scheduled. */
const answered = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 2; i++)
      await new Promise<void>((done) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => done();
        channel.port2.postMessage(0);
      });
  });

test(
  "scrolling brings the rail to full opacity, until a second after the scrolling stops",
  withGateway(async (gateway) => {
    const page = await openOnClock(gateway);
    await assistant(page);
    const at = await read(page);
    // From here time moves only when the test moves it.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await scrollTo(page, between(at, 0));
    await rail(page).and(page.locator("[data-scrolling]")).waitFor();
    await faded(page);
    const during = await read(page, false);
    assert.ok(near(during.opacity, 1, 0.01), `full during a scroll (${during.opacity})`);

    await page.clock.runFor(600);
    await answered(page);
    await faded(page);
    const after = await read(page, false);
    assert.ok(
      after.scrolling && near(after.opacity, 1, 0.01),
      `still full 0.6 s after (${after.opacity})`,
    );

    await page.clock.runFor(500);
    await rail(page).and(page.locator(":not([data-scrolling])")).waitFor();
    await faded(page);
    const back = await read(page, false);
    assert.ok(near(back.opacity, 0.5, 0.01), `back at half 1.1 s after (${back.opacity})`);
    await page.close();
  }),
);

test(
  "pressing a logo brings its heading to the top and marks it current",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    // Once the scroll it starts has ended.
    await panel(page).evaluate((window) => {
      const box = window.querySelector('nav[aria-label="Sections"]')?.previousElementSibling;
      (globalThis as { ended?: Promise<unknown> }).ended = new Promise((done) =>
        box?.addEventListener("scrollend", done, { once: true }),
      );
    });
    await logo(page, "Web").click();
    await page.evaluate(() => (globalThis as { ended?: Promise<unknown> }).ended);
    const jumped = await read(page);
    assert.ok(
      near(jumped.headingTops[2] ?? -1, 0, 2),
      `Web's heading at the top: ${jumped.headingTops[2]}`,
    );
    assert.equal(jumped.labels[jumped.current], "Web", "and marked current");
    assert.equal(await logo(page, "Web").getAttribute("aria-current"), "true");
    await page.close();
  }),
);

test(
  "dragging to the middle of a connector scrolls halfway between its two headings, and further on scrolls further",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    const at = await read(page);
    const line = rail(page).locator("[data-line]").nth(1);
    const box = await line.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2, { steps: 6 });
    const dragged = await read(page);
    await page.mouse.move(x, box.y + box.height + 40, { steps: 6 });
    const further = await read(page);
    await page.mouse.up();
    const half = between(at, 1);
    assert.ok(
      near(dragged.scroll, half, 6) && near(dragged.lit[1] ?? 0, 0.5, 0.05),
      `halfway between Computer and Web: scroll ${dragged.scroll} for ${half}, lit ${fixed(dragged.lit)}`,
    );
    assert.ok(further.scroll > dragged.scroll, `${dragged.scroll} → ${further.scroll}`);
    await page.close();
  }),
);

test(
  "Tab from the options reaches the first logo; with the keyboard in the rail it is at full opacity and the labels show, at the logos' left",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    // The keyboard on the last of the options, which stay where they are, so the rail is at rest.
    await panel(page)
      .getByRole("button", { name: "Add a unit" })
      .evaluate((add: HTMLElement) => add.focus({ preventScroll: true }));
    await faded(page);
    const before = await read(page, false);
    assert.ok(
      !before.scrolling && near(before.opacity, 0.5, 0.01),
      `at rest before (${before.opacity})`,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Base",
    );
    await faded(page);
    const keyed = await read(page, false);
    assert.ok(near(keyed.opacity, 1, 0.01), `full opacity (${keyed.opacity})`);
    assert.ok(near(keyed.labelOpacity, 1, 0.01), `the labels show (${keyed.labelOpacity})`);
    const [label, button] = await logo(page, "Base").evaluate((b) =>
      [b.querySelector("span") as Element, b].map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    assert.ok(label && button && label.right <= button.left, "its label at its left");
    assert.ok(label.top < button.bottom && label.bottom > button.top, "on its line");
    await page.close();
  }),
);

test(
  "with reduced motion a current logo doesn't grow and a jump is immediate",
  withGateway(async (gateway) => {
    const page = await browser().newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/team`);
    await assistant(page);
    const at = await read(page);
    await scrollTo(page, at.stops[1] ?? 0);
    const onIt = await read(page);
    assert.equal(onIt.labels[onIt.current], "Computer");
    assert.ok(
      onIt.scale.every((s) => near(s, 1, 0.001)),
      `none grows: ${fixed(onIt.scale)}`,
    );
    await scrollTo(page, 0);
    await read(page);
    await logo(page, "Web").click();
    const jumped = await read(page, false);
    assert.ok(
      near(jumped.headingTops[2] ?? -1, 0, 2),
      `Web's heading at the top at once: ${jumped.headingTops[2]}`,
    );
    await page.close();
  }),
);

/** Where the rail stands, from the stops it reads: how far the scroll has come, in headings. */
function whereFrom(at: Read) {
  const stops = at.stops.map((s) => Math.min(at.end, Math.max(0, s)));
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i] as number;
    const to = stops[i + 1] as number;
    if (at.scroll < to) return to > from ? i + Math.max(0, at.scroll - from) / (to - from) : i + 1;
  }
  return stops.length - 1;
}
/** What the rail draws for that place: the lit part of each connector. */
const litFor = (at: Read) => {
  const where = whereFrom(at);
  return at.lit.map((_, i) =>
    i < Math.floor(where) ? 1 : i === Math.floor(where) ? where % 1 : 0,
  );
};

test(
  "adding, removing and folding a unit changes the rail's logos and where its headings are",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await assistant(page);
    await panel(page).getByRole("button", { name: "Remove Web" }).click();
    assert.deepEqual((await read(page)).labels, ["Base", "Computer", "Add"]);
    await panel(page).getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menuitem", { name: /^Web/ }).click();
    assert.deepEqual((await read(page)).labels, ["Base", "Computer", "Web", "Add"]);

    // Between Computer and Web, Computer folds: Web's heading comes up, and the rail follows.
    const at = await read(page);
    await scrollTo(page, between(at, 1));
    const before = await read(page);
    await panel(page)
      .getByRole("button", { name: "Fold Computer" })
      .evaluate((b: HTMLElement) => b.click());
    const folded = await read(page);
    assert.ok((folded.stops[2] ?? 0) < (before.stops[2] ?? 0), "Web's heading moved up");
    const drawn = litFor(folded);
    assert.ok(
      folded.lit.every((n, i) => near(n, drawn[i] ?? -1, 0.03)),
      `the lit lines follow: ${fixed(folded.lit)} for ${fixed(drawn)}`,
    );
    assert.notDeepEqual(fixed(folded.lit), fixed(before.lit), "and they changed");
    await page.close();
  }),
);
