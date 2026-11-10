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
  "an agent with no live surfaces keeps the frames of its record",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("region", { name: "Computer" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Terminal" }).count(), 0);
    await page.close();
  }),
);
