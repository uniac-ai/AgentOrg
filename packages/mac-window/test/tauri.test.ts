// Inside the app, the page calls the app's commands by their names, with the arguments the app
// takes: a fake of what Tauri gives the page keeps each call, in a real browser.
import assert from "node:assert/strict";
import test from "node:test";
import { open, until, withBrowser } from "./kit.ts";

withBrowser();

/** What Tauri gives the page in the app, answering as the service would and keeping each call. */
function inTheApp() {
  const setup = {
    capabilities: [
      { capability: "terminal", on: false, ready: true, needs: [] },
      { capability: "files", on: false, ready: true, needs: [] },
      {
        capability: "screen",
        on: true,
        ready: false,
        needs: [
          { need: "screen-recording", holder: "AgentOrg", state: "not-granted" },
          { need: "accessibility", holder: "AgentOrg", state: "granted" },
        ],
      },
      { capability: "browser", on: false, ready: false, needs: [] },
    ],
  };
  const answers: Record<string, unknown> = {
    setup,
    set_switch: setup,
    ask: setup,
    connection: { connected: false, clients: [] },
    computers: [],
    acting: [],
    app_state: "running",
  };
  const calls: unknown[] = [];
  Object.assign(window, {
    calls,
    __TAURI__: {
      core: {
        invoke: async (command: string, args?: unknown) => {
          calls.push(args === undefined ? [command] : [command, args]);
          return answers[command];
        },
      },
      event: { listen: async () => () => {} },
    },
  });
}

test("in the app, the page calls the app's commands with the arguments they take", async () => {
  const tab = await open("first-open", { init: inTheApp });
  const called = async (name: string) =>
    (await tab.evaluate(() => (window as unknown as { calls: unknown[][] }).calls)).filter(
      ([command]) => command === name,
    );
  await tab.getByRole("switch", { name: "Terminal" }).click();
  await tab
    .getByRole("table", { name: "What Screen needs" })
    .getByRole("button", { name: "Grant" })
    .click();
  await until(() => called("set_switch"), [["set_switch", { capability: "terminal", on: true }]]);
  await until(() => called("ask"), [["ask", { capability: "screen", need: "screen-recording" }]]);
  for (const read of ["setup", "connection", "computers", "acting", "app_state"])
    assert.deepEqual((await called(read))[0], [read], read);
  const [fit] = await called("fit");
  const height = (fit?.[1] as { height?: number } | undefined)?.height ?? 0;
  assert.ok(height > 0, JSON.stringify(fit));
  await tab.context().close();
});
