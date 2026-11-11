// The frames an agent's live surfaces sit in, chosen by protocol, over the stand-in's `/live`.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
type Surface = { surface: string; protocol: string; operate: boolean; unavailable?: string };
const TERMINAL: Surface = { surface: "terminal", protocol: "terminal@1", operate: true };

const LOAD: Surface = { surface: "load", protocol: "metrics@1", operate: false };

/** Research's computer, with these surfaces. */
function withSurfaces(gateway: Gateway, surfaces: Surface[]) {
  const research = gateway.agents.get("a-research") as Agent;
  research.units = [
    {
      instance: "i-computer",
      provider: "units",
      unit: "computer",
      title: "Computer",
      values: {},
      needs: {},
      status: { state: "connected", surfaces },
    },
  ];
}
async function open(gateway: Gateway, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  return page;
}
/** Wait for something the stand-in comes to hold. */
async function until(held: () => boolean, what: string, within = 4000) {
  for (const end = Date.now() + within; !held() && Date.now() < end; )
    await new Promise((done) => setTimeout(done, 25));
  assert.ok(held(), what);
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};

test(
  "a surface that can't be opened here says why, and one the page has no viewer for isn't drawn",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [
      { ...TERMINAL, unavailable: "The computer has no terminal." },
      { surface: "radio", protocol: "radio@9", operate: false },
    ]);
    const page = await open(gateway);
    await page
      .getByRole("region", { name: "Terminal" })
      .getByText("The computer has no terminal.")
      .waitFor();
    // The frame holds the one pane that says why, and nothing for a protocol it has no viewer for.
    assert.equal(
      await page.getByRole("region", { name: "Terminal" }).getByRole("group").count(),
      1,
    );
    assert.equal(await page.getByText("radio").count(), 0);
    assert.equal(
      gateway.live.opened.some((o) => o.surface === "terminal"),
      false,
      "not opened",
    );
    await page.close();
  }),
);

test(
  "an agent with no window to show has no Computer tab: its page is its chats",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [{ surface: "radio", protocol: "radio@9", operate: false }]);
    const page = await open(gateway);
    const main = page.getByRole("main");
    await main.getByRole("list", { name: "Chats with Research" }).waitFor();
    assert.equal(await main.getByRole("tablist").count(), 0);
    assert.equal(await main.getByRole("region").count(), 0);
    await page.close();
  }),
);

test(
  "an agent with a computer opens on it, and its chats are a tab away, in the address too",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [TERMINAL]);
    const page = await open(gateway);
    const main = page.getByRole("main");
    const tabs = main.getByRole("tablist", { name: "Research" });
    const selected = () => tabs.getByRole("tab", { selected: true }).innerText();
    await main
      .getByRole("tabpanel", { name: "Computer" })
      .getByRole("region", { name: "Terminal" })
      .waitFor();
    assert.deepEqual(await tabs.getByRole("tab").allInnerTexts(), ["Computer", "Chats"]);
    assert.equal(await selected(), "Computer");
    await tabs.getByRole("tab", { name: "Chats" }).click();
    await page.waitForURL(/#\/a\/a-research\/chats$/);
    await main
      .getByRole("tabpanel", { name: "Chats" })
      .getByRole("list", { name: "Chats with Research" })
      .waitFor();
    assert.equal(await main.getByRole("region", { name: "Terminal" }).count(), 0);
    // The address alone opens the same tab, and Back returns to the first.
    await page.reload();
    await main.getByRole("list", { name: "Chats with Research" }).waitFor();
    assert.equal(await selected(), "Chats");
    await page.goBack();
    await main.getByRole("region", { name: "Terminal" }).waitFor();
    assert.equal(await selected(), "Computer");
    await page.close();
  }),
);

const GB = 2 ** 30;
const meter = (page: Page, name: string) =>
  page
    .getByRole("main")
    .getByRole("complementary", { name: "About this computer" })
    .getByRole("meter", { name });
/** What the three meters say: how full each is drawn, and its words. */
const shown = async (page: Page) => {
  const column = page.getByRole("main").getByRole("complementary", { name: "About this computer" });
  const full = await Promise.all(
    ["CPU", "Memory", "Disk"].map((name) => meter(page, name).getAttribute("aria-valuenow")),
  );
  return [full.join(" "), ...(await column.innerText()).split("\n").filter((line) => line.trim())];
};

test(
  "a computer's load is watched while its page shows it: CPU, memory and disk, each reading as it comes",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [TERMINAL, LOAD]);
    const page = await open(gateway);
    await page.getByRole("main").getByRole("region", { name: "Terminal" }).waitFor();
    await until(() => gateway.live.load.sockets.size === 1, "its load is opened");
    assert.deepEqual(
      gateway.live.opened.filter((o) => o.surface === "load").map((o) => o.mode),
      ["watch"],
    );
    // Until the first reading nothing is shown.
    assert.equal(await page.getByRole("complementary", { name: "About this computer" }).count(), 0);
    const disk = { diskUsed: 212e9, diskTotal: 494e9 };
    gateway.reading({
      cpuUsedPct: 37.2,
      memUsed: Math.round(9.22 * GB),
      memTotal: 16 * GB,
      ...disk,
    });
    await meter(page, "CPU").waitFor();
    assert.deepEqual(await shown(page), [
      "37 58 43",
      "CPU",
      "37%",
      "Memory",
      "9.2 of 16 GB",
      "Disk",
      "212 of 494 GB",
    ]);
    // A frame that isn't a whole reading changes nothing; the next reading does.
    for (const ws of gateway.live.load.sockets)
      ws.send(JSON.stringify({ type: "reading", cpuUsedPct: 99 }));
    await page.waitForTimeout(200);
    assert.equal(await meter(page, "CPU").getAttribute("aria-valuenow"), "37");
    gateway.reading({ cpuUsedPct: 6, memUsed: Math.round(8.3 * GB), memTotal: 16 * GB, ...disk });
    await page.getByRole("main").getByText("8.3 of 16 GB").waitFor();
    assert.equal((await shown(page))[0], "6 52 43");
    // Nothing is read while nobody watches: off its tab, the socket is closed.
    await page.getByRole("main").getByRole("tab", { name: "Chats" }).click();
    await until(() => gateway.live.load.sockets.size === 0, "its load is closed");
    await page.close();
  }),
);

test(
  "a computer that can't say how busy it is shows no meters, and one whose socket closes is asked again",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [TERMINAL, { ...LOAD, unavailable: "It can't be read here." }]);
    const quiet = await open(gateway);
    await quiet.getByRole("main").getByRole("region", { name: "Terminal" }).waitFor();
    await quiet.waitForTimeout(300);
    assert.equal(await quiet.getByRole("meter").count(), 0);
    assert.equal(gateway.live.opened.filter((o) => o.surface === "load").length, 0, "not opened");
    await quiet.close();

    withSurfaces(gateway, [TERMINAL, LOAD]);
    const page = await open(gateway);
    gateway.reading({
      cpuUsedPct: 12,
      memUsed: 4 * GB,
      memTotal: 16 * GB,
      diskUsed: 1e11,
      diskTotal: 5e11,
    });
    await meter(page, "CPU").waitFor();
    const [first] = gateway.live.load.sockets;
    // The numbers go with the socket, and come back with the next one's first reading.
    gateway.live.load.reading = undefined;
    first?.close(1001);
    await meter(page, "CPU").waitFor({ state: "detached" });
    await until(() => gateway.live.load.sockets.size === 1, "opened again", 9000);
    await page.waitForTimeout(200);
    assert.equal(await meter(page, "CPU").count(), 0, "a new socket starts with no numbers");
    gateway.reading({
      cpuUsedPct: 15,
      memUsed: 4 * GB,
      memTotal: 16 * GB,
      diskUsed: 1e11,
      diskTotal: 5e11,
    });
    await page.getByRole("main").getByText("15%").waitFor();
    await page.close();
  }),
);

test(
  "a read of what the agent is made of that fails keeps its page as it was: the tab and its sockets stay",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [TERMINAL]);
    const page = await open(gateway);
    const terminal = page.getByRole("main").getByRole("region", { name: "Terminal" });
    await terminal.waitFor();
    await until(() => gateway.live.terminal.sockets.size === 1, "its terminals are open");
    const opened = gateway.live.opened.length;
    const reads = () =>
      gateway.calls.filter((c) => c.method === "get" && c.input.agent === "a-research").length;
    const [before, from] = [reads(), gateway.calls.length];
    gateway.refuseNext("agents.get", "failed", "Not now.");
    await until(() => reads() >= before + 2, "read again, twice", 12000);
    const refused = gateway.calls.slice(from).find((c) => c.method === "get");
    assert.equal(refused?.input.agent, "a-research", "the read that failed was its own");
    assert.equal(await terminal.count(), 1);
    assert.equal(gateway.live.opened.length, opened, "nothing was opened again");
    await page.close();
  }),
);
