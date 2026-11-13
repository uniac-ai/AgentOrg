// What an agent's computer is, in its own views, beside it on its page; and its frame when it is
// down. In a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { heldComputer as computer, sampleAgents, sampleLoad } from "./design/samples.ts";
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
  "beside the computer: where it is with its load under it, then its folder, what it reaches and how it is isolated",
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
      ["Where", "This computer"],
    );
    await about.getByText("None: it acts as you").waitFor();
    assert.deepEqual(
      await about
        .locator("dl > div")
        .evaluateAll((all) => all.map((one) => (one as HTMLElement).innerText.split("\n"))),
      [
        ["Folder", "~/Agents/Research"],
        ["Reaches", "Files and terminal, Browser"],
        ["Isolation", "None: it acts as you"],
      ],
    );
    // A path in mono, a caution in its colour.
    assert.match(
      await about.getByText("~/Agents/Research").evaluate((e) => getComputedStyle(e).fontFamily),
      /mono|Menlo|Courier/i,
    );
    assert.equal(
      await about.getByText("None: it acts as you").evaluate((e) => getComputedStyle(e).color),
      await colourOf(page, "var(--warn)"),
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
          "no AgentComputer is running on this computer. Install it with npm install -g @agentorg/computer, start it with agentcomputer serve, and try again.",
      }),
    ]);
    await frame.getByText(/^No AgentComputer is running on this computer\. Install it/).waitFor();
    assert.equal(await frame.getByRole("navigation", { name: "Dock" }).count(), 0);
    assert.equal(await frame.getByRole("group").count(), 0);
    const about = page
      .getByRole("main")
      .getByRole("complementary", { name: "About this computer" });
    await about.getByText("~/Agents/Research").waitFor();
    assert.equal(await about.getByText("None: it acts as you").count(), 0, "it can't be asked");
    assert.equal(await about.getByRole("meter").count(), 0);
    // Back, its windows are.
    gateway.setHeld("a-research", [computer()]);
    await frame.getByRole("navigation", { name: "Dock" }).waitFor();
    await page.close();
  }),
);
