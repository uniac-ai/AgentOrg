import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "../../harness.ts";
import { command, freePort } from "../../process.ts";
import { online, core as startCore } from "./harness.ts";

const agentorg = (args: string[], env: Record<string, string>) => command("web", args, env);

test("agentorg-web serves as the root of the core, and agentorg-web open prints its sign-in link", async () => {
  const core = await startCore();
  const port = await freePort();
  const env = {
    AGENTORG_URL: core.url,
    AGENTORG_ACTOR_ID: core.rootId,
    AGENTORG_CREDENTIAL: core.root,
    AGENTORG_WEB_PORT: String(port),
  };
  const running = agentorg([], env);
  try {
    await until("the web client comes online", () => online(core));
    const ui = await agentorg(["open"], { ...env, BROWSER: "/usr/bin/false" });
    assert.equal(ui.status, 0, ui.stderr);
    const link = ui.stdout.trim();
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/signin\\?token=`));
    const login = await fetch(link, { redirect: "manual" });
    assert.match(login.headers.get("set-cookie") ?? "", /^agentorg_human=/);
  } finally {
    running.child.kill("SIGTERM");
    const stopped = await running;
    assert.equal(stopped.status, 0, stopped.stderr);
  }
});

test("agentorg-web open says when the web client is not running", async () => {
  const port = await freePort();
  const ui = await agentorg(["open"], {
    AGENTORG_CREDENTIAL: "a credential",
    AGENTORG_WEB_PORT: String(port),
  });
  assert.equal(ui.status, 1);
  assert.match(ui.stderr, /the web client is not running at .*; start it with agentorg-web/);
});

test("the web process requires an Actor identity with an environment credential", async () => {
  const result = await agentorg([], {
    AGENTORG_URL: "http://127.0.0.1:1",
    AGENTORG_CREDENTIAL: "sentinel-private-credential",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set both AGENTORG_ACTOR_ID and AGENTORG_CREDENTIAL/);
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-private-credential/);
});
