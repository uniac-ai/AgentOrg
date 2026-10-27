import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { live, TOKEN } from "./live.ts";

const BIN = new URL("../src/cli/bin.js", import.meta.url).pathname;

// biome-ignore lint/suspicious/noExplicitAny: the tests read tool results loosely, as clients do.
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: any };

/** A client of `agentorg mcp`, run as a stdio server the way an agent's client runs it. */
async function proxy(env: Record<string, string>) {
  const client = new Client({ name: "agentorg-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", "--client=claude-code", "--client-session-env=SESSION_VAR"],
      env: { ...(process.env as Record<string, string>), SESSION_VAR: "cc-p1", ...env },
      stderr: "ignore",
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<Result>;
  return { client, call };
}

const ASK = {
  title: "Which database?",
  context: "The service needs one store.",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommendation: "SQLite",
};
const NEW_AGENT = { new_agent: { title: "Plan", purpose: "Decide." } };

test("the proxy serves the tools and instructions, with the client session from the environment", async () => {
  const server = await live();
  try {
    const { client, call } = await proxy({ AGENTORG_URL: server.url, AGENTORG_TOKEN: TOKEN });
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("session_attach") && !tools.includes("ask_answer_as_user"));
    assert.match(client.getInstructions() ?? "", /session_attach/);
    const { session } = (await call("session_attach", NEW_AGENT)).structuredContent;
    assert.deepEqual([session.client, session.client_session_id], ["claude-code", "cc-p1"]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("an ask_wait through the proxy returns once the ask is answered", async () => {
  const server = await live();
  try {
    const { client, call } = await proxy({ AGENTORG_URL: server.url, AGENTORG_TOKEN: TOKEN });
    const { session } = (await call("session_attach", NEW_AGENT)).structuredContent;
    const ask = (await call("ask_open", { session: session.id, ...ASK })).structuredContent;
    const waiting = call("ask_wait", { ask: ask.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await server.service.ask_answer_as_user(
      { ask: ask.id, choice: "Postgres" },
      { channel: "page" },
    );
    assert.equal((await waiting).structuredContent.answer.choice, "Postgres");
    await client.close();
  } finally {
    await server.close();
  }
});

test("with no service ever started, the proxy still starts and each call says how to start it", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise((resolve) => probe.close(resolve));
  const home = mkdtempSync(join(tmpdir(), "agentorg-never-"));
  try {
    const { client, call } = await proxy({
      AGENTORG_URL: url,
      AGENTORG_HOME: home,
      AGENTORG_TOKEN: "",
    });
    assert.ok((await client.listTools()).tools.length > 0);
    const result = await call("session_context", {});
    assert.ok(result.isError);
    assert.equal(
      result.content[0]?.text,
      `unavailable: agentorg service not running at ${url}; start it with \`agentorg serve\``,
    );
    await client.close();
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("the proxy exits 0 when its client closes stdin", async () => {
  const child = spawn(process.execPath, [BIN, "mcp", "--client=x"], {
    env: { ...process.env, AGENTORG_TOKEN: "" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /unsettled/);
});
