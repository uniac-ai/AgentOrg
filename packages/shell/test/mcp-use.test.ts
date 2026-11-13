// An agent's page on a phone, and its State line, in a real browser over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computerWith } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
async function open(
  gateway: Gateway,
  hash: string,
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
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

test(
  "at phone width the agent's page keeps inside its width, and its head wraps",
  withGateway(async (gateway) => {
    computerWith(gateway, "terminal", false);
    const page = await open(gateway, "#/a/a-research", { width: 390, height: 844 });
    const main = page.getByRole("main");
    const terminal = main.getByRole("group", { name: "Terminal" });
    await terminal.waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    const within = async (name: string, box: { x: number; width: number } | null) =>
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name}: ${JSON.stringify(box)}`);
    const message = await main.getByRole("button", { name: "Message", exact: true }).boundingBox();
    const name = await main.getByRole("heading", { name: "Research", level: 1 }).boundingBox();
    await within("Message", message);
    assert.ok(
      message && name && message.y >= name.y + name.height,
      "the buttons go under the name",
    );
    await within("terminal", await terminal.boundingBox());
    await page.close();
  }),
);

test(
  "the State line says what stopped an agent, and starts it there",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-broken");
    const state = page.getByRole("status", { name: "State" });
    await state.getByText("Its program exited.").waitFor();
    await state.getByRole("button", { name: "Start" }).click();
    await page.waitForTimeout(300);
    assert.ok(gateway.calls.some((c) => c.method === "start" && c.input.agent === "a-broken"));
    await page.close();
  }),
);
