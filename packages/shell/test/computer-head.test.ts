// The head of an agent's computer: while the computer says the person is acting in one of its
// windows, it says the agent is told so. In a real browser over the stand-in gateway, whose
// presence surface says who is acting.
import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "@playwright/test";
import { browser, type Gateway, SESSION, withBrowser, withGateway } from "./build-kit.ts";
import { computer, sampleAgents } from "./design/samples.ts";

withBrowser();

async function open(gateway: Gateway, hash: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser().newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
/** The head of an agent's computer, in the page or in the layer's window. */
const head = (page: Page | Locator, name = "Research") =>
  page.getByRole("region", { name: `${name}'s computer` }).locator("header");
/** What the head says beside the title, if anything. */
const told = (page: Page | Locator, name = "Research") =>
  head(page, name).evaluate((header) => {
    const line = header.lastElementChild?.querySelector("span");
    return line?.textContent ?? null;
  });
/** In use's lines under its heading: each window and who. */
const inUse = (page: Page) =>
  page
    .getByRole("main")
    .getByRole("region", { name: "In use" })
    .evaluate((section) =>
      [...section.children]
        .slice(1)
        .map((line) =>
          line.children.length > 0
            ? [...line.children].map((part) => part.textContent ?? "")
            : [line.textContent ?? ""],
        ),
    );
/** What `read` gives, once it is `expected`: the page answers a frame in its own time. */
async function until<T>(read: () => Promise<T>, expected: T) {
  for (let tries = 0; ; tries++) {
    const now = await read();
    try {
      assert.deepEqual(now, expected);
      return;
    } catch (error) {
      if (tries > 100) throw error;
      await new Promise((done) => setTimeout(done, 40));
    }
  }
}

test(
  "while the computer says you act in its browser, its head says the agent is told so, and the line goes when it drops you; In use reads the same, from one socket",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research");
    await page.getByRole("main").getByRole("region", { name: "In use" }).waitFor();
    assert.equal(await told(page), null);
    gateway.presence([
      { who: "agent", name: "Research", capability: "terminal" },
      { who: "person", capability: "browser" },
    ]);
    await until(() => told(page), "Research is told you acted in the browser");
    await until(
      () => inUse(page),
      [
        ["Browser", "You"],
        ["Terminal", "Research"],
      ],
    );
    assert.equal(
      gateway.live.opened.filter((one) => one.surface === "presence").length,
      1,
      "one reading for the computer",
    );
    gateway.presence([{ who: "agent", name: "Research", capability: "terminal" }]);
    await until(() => told(page), null);
    await page.close();
  }),
);

test(
  "an agent acting alone shows no line, and you acting in another agent's computer shows none here",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    computer(
      gateway,
      [
        { surface: "browser", protocol: "screencast@1", operate: true },
        { surface: "presence", protocol: "presence@1", operate: false },
      ],
      "a-reviewer",
    );
    const page = await open(gateway, "#/a/a-research");
    await page.getByRole("main").getByRole("region", { name: "In use" }).waitFor();
    gateway.presence(
      [
        { who: "agent", name: "Research", capability: "browser" },
        { who: "agent", name: "Inbox", capability: "browser" },
      ],
      "a-research",
    );
    await until(() => inUse(page), [["Browser", "Research, Inbox"]]);
    assert.equal(await told(page), null, "agents alone");
    gateway.presence([{ who: "person", capability: "browser" }], "a-reviewer");
    const other = await open(gateway, "#/a/a-reviewer");
    await until(() => told(other, "Reviewer"), "Reviewer is told you acted in the browser");
    assert.equal(await told(page), null, "not on Research's");
    assert.deepEqual(await inUse(page), [["Browser", "Research, Inbox"]]);
    await other.close();
    await page.close();
  }),
);

test(
  "each window is named as its dock button names it",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    computer(gateway, [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "screen", protocol: "screen@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
      { surface: "files", protocol: "files@1", operate: true },
      { surface: "presence", protocol: "presence@1", operate: false },
    ]);
    const page = await open(gateway, "#/a/a-research");
    const dock = page.getByRole("main").getByRole("navigation", { name: "Dock" });
    await dock.getByRole("button").first().waitFor();
    const names = await dock
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
    assert.deepEqual(names, ["Browser", "Screen", "Terminal", "Files"]);
    for (const [i, kind] of ["browser", "screen", "terminal", "files"].entries()) {
      gateway.presence([{ who: "person", capability: kind }]);
      await until(() => told(page), `Research is told you acted in the ${names[i]?.toLowerCase()}`);
    }
    await page.close();
  }),
);

test(
  "on a phone, in the layer's window, the title gives way to the line, as the design shares the head between them, and nothing scrolls sideways",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research", 390, 844);
    await page.getByRole("main").getByRole("button", { name: "Expand" }).click();
    const window = page.getByRole("group", { name: "Window" });
    await window.getByRole("navigation").waitFor();
    await window.evaluate((e) =>
      Promise.all(e.getAnimations({ subtree: true }).map((one) => one.finished)),
    );
    gateway.presence([{ who: "person", capability: "browser" }]);
    await until(() => told(window), "Research is told you acted in the browser");
    // Read at one moment: the width each has, and the width it needs.
    const seen = await head(window).evaluate((header) => {
      const title = header.querySelector("h3 span.truncate") as HTMLElement;
      const line = header.lastElementChild?.querySelector("span") as HTMLElement;
      return {
        titleHas: title.clientWidth,
        titleNeeds: title.scrollWidth,
        lineHas: line.clientWidth,
        headHas: header.clientWidth,
        headNeeds: header.scrollWidth,
        pageHas: innerWidth,
        pageNeeds: document.documentElement.scrollWidth,
      };
    });
    const said = JSON.stringify(seen);
    assert.ok(seen.titleNeeds > seen.titleHas, `the title is cut short: ${said}`);
    assert.ok(seen.lineHas > seen.titleHas, `the line has the larger part: ${said}`);
    assert.ok(
      seen.headNeeds <= seen.headHas && seen.pageNeeds <= seen.pageHas,
      `nothing goes beyond: ${said}`,
    );
    await page.close();
  }),
);
