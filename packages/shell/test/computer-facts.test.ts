// What an agent's computer is, in its own views, beside it on its page; and its frame when it is
// down. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import {
  heldComputer as computer,
  computer as live,
  sampleAgents,
  sampleLoad,
} from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const colourOf = (page: Page, value: string) =>
  page.evaluate((v) => {
    const probe = document.createElement("i");
    probe.style.color = v;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, value);

test(
  "beside the computer: which it is with its load under it, then what it acts as, where its work happens, what it reaches and its browser, each note quieter under its value",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    gateway.setHeld("a-research", [computer()]);
    const page = await open(gateway, "#/a/a-research");
    gateway.reading(sampleLoad(18));
    const about = page
      .getByRole("main")
      .getByRole("complementary", { name: "About this computer" });
    const where = about.getByRole("region", { name: "This computer" });
    await where.getByRole("meter", { name: "CPU" }).waitFor();
    assert.deepEqual(
      (await where.innerText())
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, 2),
      ["Computer", "This computer"],
    );
    await about.getByText("You, with all you can reach").waitFor();
    assert.deepEqual(
      await about
        .locator("dl > div")
        .evaluateAll((all) => all.map((one) => (one as HTMLElement).innerText.split("\n"))),
      [
        ["Acts as", "You, with all you can reach"],
        ["Its work happens in", "~/Agents/Research", "Said to it, not a wall"],
        ["Reaches", "Files and terminal, your screen"],
        ["Browser", "Your browser", "Signed in as you"],
      ],
    );
    // A path in mono, a caution in its colour.
    assert.match(
      await about.getByText("~/Agents/Research").evaluate((e) => getComputedStyle(e).fontFamily),
      /mono|Menlo|Courier/i,
    );
    assert.equal(
      await about
        .getByText("You, with all you can reach")
        .evaluate((e) => getComputedStyle(e).color),
      await colourOf(page, "var(--warn)"),
    );
    // A note is quieter than its value: smaller, in the muted colour.
    const note = about.getByText("Said to it, not a wall");
    assert.equal(await note.evaluate((e) => getComputedStyle(e).fontSize), "12px");
    assert.equal(
      await note.evaluate((e) => getComputedStyle(e).color),
      await colourOf(page, "var(--muted)"),
    );
    await page.close();
  }),
);

test(
  "a made computer's head says where it was made, in a note quieter than what it is",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const made = computer();
    made.views = [
      {
        id: "where",
        place: "column",
        kind: "facts",
        fixed: [{ label: "Computer", value: "A container", note: "Made for it on this machine" }],
      },
      ...(made.views ?? []).slice(1),
    ];
    gateway.setHeld("a-research", [made]);
    const page = await open(gateway, "#/a/a-research");
    gateway.reading(sampleLoad(18));
    const head = page
      .getByRole("main")
      .getByRole("complementary", { name: "About this computer" })
      .getByRole("region", { name: "A container" });
    await head.getByRole("meter", { name: "CPU" }).waitFor();
    assert.deepEqual(
      (await head.innerText())
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, 3),
      ["Computer", "A container", "Made for it on this machine"],
    );
    const note = head.getByText("Made for it on this machine");
    assert.equal(await note.evaluate((e) => getComputedStyle(e).fontSize), "12px");
    assert.equal(
      await note.evaluate((e) => getComputedStyle(e).color),
      await colourOf(page, "var(--muted)"),
    );
    await page.close();
  }),
);

test(
  "a computer that is down says why in its frame, with nothing to open and no dock, and its facts say what is fixed",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame.getByRole("navigation", { name: "Dock" }).waitFor();
    gateway.setHeld("a-research", [
      computer({
        state: "down",
        detail:
          "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.",
      }),
    ]);
    await frame.getByText(/^AgentComputer isn't installed on this computer\. Install it/).waitFor();
    assert.equal(await frame.getByRole("navigation", { name: "Dock" }).count(), 0);
    assert.equal(await frame.getByRole("group").count(), 0);
    const about = page
      .getByRole("main")
      .getByRole("complementary", { name: "About this computer" });
    await about.getByText("~/Agents/Research").waitFor();
    assert.equal(
      await about.getByText("You, with all you can reach").count(),
      0,
      "it can't be asked",
    );
    assert.equal(await about.getByRole("meter").count(), 0);
    // Back, its windows are.
    gateway.setHeld("a-research", [computer()]);
    await frame.getByRole("navigation", { name: "Dock" }).waitFor();
    await page.close();
  }),
);

test(
  "a computer that can't be reached offers its provider's ways forward; one taken opens its unit's form with the way's answers, and saved takes the old unit's place",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    // It holds the computer its computer unit built.
    gateway.setHeld("a-research", [computer({ from: "i-computer" })]);
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame.getByRole("navigation", { name: "Dock" }).waitFor();
    gateway.setHeld("a-research", [
      computer({
        state: "down",
        detail:
          "A computer with no isolation is no longer made. Its folder is kept at /work/research.",
        from: "i-computer",
        ways: [
          {
            title: "Attach this computer",
            description:
              "Its work happens in /work/research, as before. It reaches the whole machine.",
            unit: "computer",
            values: { where: "local", workspace: "/work/research", access: "terminal" },
          },
          {
            title: "Make a container",
            unit: "computer",
            values: { where: "container", access: "terminal" },
          },
        ],
      }),
    ]);
    await frame.getByText("Its computer isn't started").waitFor();
    // Its line says to choose one, not the whole of why: the frame says that.
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText("Its computer isn't started: choose a way forward", { exact: true })
      .waitFor();
    await frame.getByText(/^A computer with no isolation is no longer made/).waitFor();
    const attach = frame.getByRole("button", { name: "Attach this computer" });
    const container = frame.getByRole("button", { name: "Make a container" });
    // The first way is the one to take, first in the row.
    const xOf = async (button: typeof attach) => (await button.boundingBox())?.x ?? 0;
    assert.ok((await xOf(attach)) < (await xOf(container)));
    const changes = () => gateway.calls.filter((c) => /^(add|remove)Unit$/.test(c.method));
    // Looked at and left, nothing changes.
    await container.click();
    const window = page.getByRole("dialog", { name: "Research's computer" });
    await window.waitFor();
    assert.equal(
      (await window.getByRole("combobox", { name: "Where it resides" }).innerText()).trim(),
      "Its own container",
    );
    await window.getByRole("button", { name: "Cancel" }).click();
    await window.waitFor({ state: "detached" });
    assert.equal(changes().length, 0);
    // Taken: its form with the way's answers and what taking it does; saved, in the old one's place.
    await attach.click();
    await window.getByText(/^Its work happens in \/work\/research, as before/).waitFor();
    assert.equal(
      await window.getByLabel("Workspace directory", { exact: true }).inputValue(),
      "/work/research",
    );
    await window.getByRole("button", { name: "Save" }).click();
    for (let i = 0; i < 40 && changes().length < 2; i++) await page.waitForTimeout(100);
    const [out, put] = changes();
    assert.deepEqual(out?.input, { agent: "a-research", instance: "i-computer" });
    assert.equal(put?.method, "addUnit");
    const added = put?.input as { unit: { values: unknown }; at?: number } | undefined;
    assert.equal(added?.at, 0, "in the place of the unit it was built from");
    assert.deepEqual(added?.unit.values, {
      where: "local",
      workspace: "/work/research",
      access: "terminal",
    });
    await page.close();
  }),
);

/** Read until it reads as expected, a few seconds at most. */
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

/** The In use section's lines under its heading: each window and who, or that no one is. */
const inUse = (page: Page) =>
  page
    .getByRole("main")
    .getByRole("region", { name: "In use" })
    .evaluate((section) =>
      [...section.children].slice(1).map((line) => (line as HTMLElement).innerText.split("\n")),
    );

test(
  "In use says who acted on each window in the last few seconds, the agent first and you last, and no one when no one has",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research");
    await page.getByRole("main").getByRole("region", { name: "In use" }).waitFor();
    assert.deepEqual(await inUse(page), [["No one, in the last few seconds"]]);
    // As the service sends it, the most recent first: its terminals are one window, and the screen,
    // which this computer has no window for here, has no line.
    gateway.presence([
      { who: "person", capability: "files" },
      { who: "agent", name: "Inbox", capability: "browser" },
      { who: "agent", name: "Research", capability: "terminal", terminal: "t-2" },
      { who: "agent", name: "Research", capability: "browser" },
      { who: "agent", name: "Research", capability: "terminal", terminal: "t-1" },
      { who: "agent", name: "Research", capability: "screen" },
      { who: "person", capability: "browser" },
    ]);
    await until(
      () => inUse(page),
      [
        ["Browser", "Research, Inbox, You"],
        ["Terminal", "Research"],
        ["Files", "You"],
      ],
    );
    gateway.presence([]);
    await until(() => inUse(page), [["No one, in the last few seconds"]]);
    await page.close();
  }),
);

test(
  "In use isn't shown while the computer is down, nor where its service doesn't say who is acting",
  withGateway(async (gateway) => {
    sampleAgents(gateway);
    const page = await open(gateway, "#/a/a-research");
    const section = page.getByRole("main").getByRole("region", { name: "In use" });
    await section.waitFor();
    gateway.setHeld("a-research", [
      computer({ state: "down", detail: "its service here is gone" }),
    ]);
    await section.waitFor({ state: "detached" });
    // Back, on a service that lists no presence surface.
    live(gateway, [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
    ]);
    gateway.setHeld("a-research", [computer()]);
    await page.getByRole("main").getByRole("navigation", { name: "Dock" }).waitFor();
    await page.getByRole("main").getByText("Its work happens in").waitFor();
    assert.equal(await section.count(), 0);
    await page.close();
  }),
);
