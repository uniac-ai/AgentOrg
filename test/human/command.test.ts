import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { until } from "../harness.ts";
import { fakeCore } from "./fake-core.ts";

const BIN = new URL("../../src/cli/bin.js", import.meta.url).pathname;

function agentorg(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return Object.assign(done, { child });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("agentorg human serves as the root of the core, and agentorg ui prints its sign-in link", async () => {
  const core = await fakeCore();
  const port = await freePort();
  const env = {
    AGENTORG_URL: core.url,
    AGENTORG_CREDENTIAL: core.credential,
    AGENTORG_HUMAN_PORT: String(port),
  };
  const running = agentorg(["human"], env);
  try {
    await until("the human actor comes online", () => core.onlines() > 0);
    const ui = await agentorg(["ui"], { ...env, BROWSER: "/usr/bin/false" });
    assert.equal(ui.code, 0, ui.stderr);
    const link = ui.stdout.trim();
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/signin\\?token=`));
    const login = await fetch(link, { redirect: "manual" });
    assert.match(login.headers.get("set-cookie") ?? "", /^agentorg_human=/);
  } finally {
    running.child.kill("SIGTERM");
    const stopped = await running;
    await core.close();
    assert.equal(stopped.code, 0, stopped.stderr);
  }
});

test("agentorg ui says when the human actor is not running", async () => {
  const port = await freePort();
  const ui = await agentorg(["ui"], {
    AGENTORG_CREDENTIAL: "a credential",
    AGENTORG_HUMAN_PORT: String(port),
  });
  assert.equal(ui.code, 1);
  assert.match(ui.stderr, /the human actor is not running at .*; start it with agentorg human/);
});
