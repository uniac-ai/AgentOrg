// Inside the app, the page calls the app's commands by their names, with the arguments the app
// takes: a fake of what Tauri gives the page keeps each call, in a real browser.
import assert from "node:assert/strict";
import test from "node:test";
import { line, open, until, withBrowser } from "./kit.ts";

withBrowser();

/** What Tauri gives the page in the app, answering as the service would and keeping each call;
 * opened at the state not allowed in the background, the app is turned off. */
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
    app_state:
      new URLSearchParams(location.search).get("state") === "not-allowed-in-the-background"
        ? "turned off"
        : "running",
    open_login_items: null,
  };
  // The service refuses a grant's Set up, with its words.
  const refused = { code: 409, message: "Screen Recording couldn't be set up." };
  const calls: unknown[] = [];
  Object.assign(window, {
    calls,
    __TAURI__: {
      core: {
        invoke: async (command: string, args?: unknown) => {
          calls.push(args === undefined ? [command] : [command, args]);
          if (command === "ask") throw refused;
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
  await until(() => called("set_switch"), [["set_switch", { capability: "terminal", on: true }]]);
  // A grant is set up only on the person's click, through the service's ask.
  assert.deepEqual(await called("ask"), []);
  await tab
    .getByRole("table", { name: "What Screen needs" })
    .getByRole("button", { name: "Set up" })
    .click();
  await until(() => called("ask"), [["ask", { capability: "screen", need: "screen-recording" }]]);
  await until(() => line(tab, "Screen"), {
    words: "Screen Recording couldn't be set up.",
    warn: true,
  });
  assert.deepEqual(await called("open_settings"), []);
  for (const read of ["setup", "connection", "computers", "acting", "app_state"])
    assert.deepEqual((await called(read))[0], [read], read);
  const [fit] = await called("fit");
  const height = (fit?.[1] as { height?: number } | undefined)?.height ?? 0;
  assert.ok(height > 0, JSON.stringify(fit));
  await tab.context().close();
});

test("turned off, the page asks the app to open Login Items", async () => {
  const tab = await open("not-allowed-in-the-background", { init: inTheApp });
  await tab.getByRole("button", { name: "Open Login Items" }).click();
  await until(
    async () =>
      (await tab.evaluate(() => (window as unknown as { calls: unknown[][] }).calls)).filter(
        ([command]) => command === "open_login_items",
      ),
    [["open_login_items"]],
  );
  await tab.context().close();
});
