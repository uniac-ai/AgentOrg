// The window, as the design draws it, in each of its states: in a real browser over the stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { card, line, open, until, withBrowser } from "./kit.ts";

withBrowser();

const title = (tab: Page) => tab.getByRole("heading", { level: 1 }).textContent();
const switched = (tab: Page) =>
  Promise.all(
    ["Terminal", "Files", "Screen", "Your browser"].map((name) =>
      tab.getByRole("switch", { name }).getAttribute("aria-checked"),
    ),
  );
/** The rows of a card's table: each name and how it stands, and its button where it has one. */
const rows = (tab: Page, label: string) =>
  tab
    .getByRole("table", { name: label })
    .getByRole("row")
    .evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.children].map((cell) => cell.textContent?.trim() ?? "").filter(Boolean),
      ),
    );
const circle = (tab: Page) =>
  tab.locator("[data-circle]").evaluate((el) => ({
    ring: el.classList.contains("ring-[var(--ok)]"),
    pulse: !!el.parentElement?.querySelector("[data-pulse]"),
  }));

test("the first open waits for AgentOrg, with every switch off and the pulse", async () => {
  const tab = await open("first-open");
  assert.equal(await title(tab), "Waiting for AgentOrg to connect");
  assert.equal(await tab.locator("h1 + p").count(), 0);
  assert.deepEqual(await switched(tab), ["false", "false", "false", "false"]);
  assert.deepEqual(await circle(tab), { ring: false, pulse: true });
  const pulse = await tab.locator("[data-pulse]").evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.animationName} ${style.animationDuration} ${style.animationIterationCount}`;
  });
  assert.equal(pulse, "ripple 3.6s infinite");
  assert.equal(await tab.getByRole("table").count(), 0);
  assert.deepEqual(await line(tab, "Your browser"), { words: "Signed in as you", warn: false });
});

test("with reduced motion, waiting doesn't pulse", async () => {
  const tab = await open("first-open", { reducedMotion: "reduce" });
  const still = await tab
    .locator("[data-pulse]")
    .evaluate((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).opacity}`);
  assert.equal(still, "none 0");
});

test("turning Screen on lists what it needs until macOS has granted it", async () => {
  const tab = await open("first-open");
  await tab.getByRole("switch", { name: "Screen" }).click();
  await until(
    () => rows(tab, "What Screen needs"),
    [
      ["Screen Recording", "Not granted", "Grant"],
      ["Accessibility", "Not granted", "Grant"],
    ],
  );
  assert.equal(await card(tab, "Screen").getByText("AgentOrg", { exact: true }).count(), 1);
  // Allowed, the app starts the driver again for a moment, and the card closes.
  await until(() => title(tab), "Starting again");
  assert.equal(await tab.getByRole("switch", { name: "Terminal" }).isDisabled(), true);
  assert.deepEqual(await circle(tab), { ring: false, pulse: false });
  await until(() => title(tab), "Waiting for AgentOrg to connect");
  assert.equal(await tab.getByRole("table").count(), 0);
  assert.deepEqual(await line(tab, "Screen"), { words: "Sees and controls it", warn: false });
});

test("Grant asks for that one need", async () => {
  const tab = await open("screen-needs-more");
  assert.deepEqual(await rows(tab, "What Screen needs"), [
    ["Screen Recording", "Not granted", "Grant"],
    ["Accessibility", "Granted"],
  ]);
  // Never granted before, it doesn't read as turned off.
  assert.deepEqual(await line(tab, "Screen"), { words: "Sees and controls it", warn: false });
  await tab.getByRole("button", { name: "Grant" }).click();
  await until(() => tab.getByRole("table", { name: "What Screen needs" }).count(), 0);
});

test("a grant turned off after it was granted says so", async () => {
  const tab = await open("permission-withdrawn");
  await until(() => line(tab, "Screen"), { words: "Screen Recording turned off", warn: true });
  assert.deepEqual(await rows(tab, "What Screen needs"), [
    ["Screen Recording", "Not granted", "Grant"],
    ["Accessibility", "Granted"],
  ]);
});

test("Your browser opens and closes, and Set up turns a browser on", async () => {
  const tab = await open("browser-needs-more");
  assert.deepEqual(await line(tab, "Your browser"), { words: "No browser set up", warn: true });
  assert.deepEqual(await rows(tab, "Browsers"), [
    ["Chrome", "Off", "Set up"],
    ["Edge", "Not installed"],
  ]);
  await tab.getByRole("button", { name: "Close Your browser" }).click();
  assert.equal(await tab.getByRole("table", { name: "Browsers" }).count(), 0);
  await tab.getByRole("button", { name: "Open Your browser" }).click();
  await tab.getByRole("button", { name: "Set up" }).click();
  await until(() => line(tab, "Your browser"), {
    words: "Chrome, signed in as you",
    warn: false,
  });
  assert.deepEqual(await rows(tab, "Browsers"), [
    ["Chrome", "On"],
    ["Edge", "Not installed"],
  ]);
});

test("with no browser installed, turning it on shows the service's words", async () => {
  const tab = await open("no-browser-installed");
  assert.deepEqual(await rows(tab, "Browsers"), [
    ["Chrome", "Not installed"],
    ["Edge", "Not installed"],
  ]);
  await tab.getByRole("switch", { name: "Your browser" }).click();
  await until(() => line(tab, "Your browser"), { words: "Signed in as you", warn: false });
  await tab.getByRole("switch", { name: "Your browser" }).click();
  await until(() => line(tab, "Your browser"), {
    words:
      "The browser is on, but asking for what it needs didn't start: Neither Chrome nor Edge is installed on this machine.",
    warn: true,
  });
  assert.equal(
    await tab.getByRole("switch", { name: "Your browser" }).getAttribute("aria-checked"),
    "true",
  );
});

test("connected holds still with a green ring, since when and who it is lent to", async () => {
  const tab = await open("connected");
  assert.equal(await title(tab), "Connected to AgentOrg");
  assert.equal(await tab.locator("h1 + p").textContent(), "Since 10:42 · Research, Inbox");
  assert.deepEqual(await circle(tab), { ring: true, pulse: false });
});

test("who is acting shows on each part while connected", async () => {
  const tab = await open("connected-acting");
  await card(tab, "Files").getByText("You, now").waitFor();
  await card(tab, "Your browser").getByText("Research, now").waitFor();
  assert.equal(await card(tab, "Terminal").getByText(", now").count(), 0);
  // An agent has a face, coloured by its id as the shell colours it; the person has none.
  const faces = (title: string) => card(tab, title).locator("[aria-hidden].rounded-full.size-4");
  assert.equal(await faces("Files").count(), 0);
  assert.equal(await faces("Your browser").textContent(), "R");
});

test("starting shows only the title bar, then says it is starting again", async () => {
  const starting = await open("starting");
  await starting.getByText("AgentOrg", { exact: true }).waitFor();
  assert.equal(await starting.getByRole("heading").count(), 0);
  assert.equal(await starting.getByRole("switch").count(), 0);
  // No reading after five seconds: the design's "Starting again", the cards greyed, nothing lent.
  await until(() => title(starting), "Starting again", 8000);
  assert.deepEqual(await switched(starting), ["false", "false", "false", "false"]);
  for (const name of ["Terminal", "Files", "Screen", "Your browser"])
    assert.equal(await starting.getByRole("switch", { name }).isDisabled(), true);
});

test("starting again greys the cards and keeps their last reading", async () => {
  const again = await open("starting-again");
  await until(() => title(again), "Starting again");
  assert.equal(await again.locator("h1 + p").count(), 0);
  assert.deepEqual(await circle(again), { ring: false, pulse: false });
  for (const name of ["Terminal", "Files", "Screen", "Your browser"])
    assert.equal(await again.getByRole("switch", { name }).isDisabled(), true);
  // The service reads the grants as unknown meanwhile; the card keeps them as they were.
  assert.deepEqual(await switched(again), ["true", "true", "true", "true"]);
  assert.equal(await again.getByRole("table").count(), 0);
});

test("the window fits the page, as its height changes", async () => {
  const tab = await open("browser-needs-more");
  const fit = () =>
    tab.evaluate(() => [
      document.documentElement.dataset.fit,
      String(
        Math.ceil(
          document.getElementById("root")?.firstElementChild?.getBoundingClientRect().height ?? 0,
        ),
      ),
    ]);
  await until(async () => {
    const [now, page] = await fit();
    return now === page && Number(now) > 400;
  }, true);
  const [told] = await fit();
  await tab.getByRole("button", { name: "Close Your browser" }).click();
  await until(async () => {
    const [now, page] = await fit();
    return now === page && now !== told;
  }, true);
});
