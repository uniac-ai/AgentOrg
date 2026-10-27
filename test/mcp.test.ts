import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { INSTRUCTIONS } from "../src/mcp/instructions.ts";
import { AUTH, live } from "./live.ts";

const AGENT_TOOLS = [
  "agent_create",
  "agent_close",
  "session_attach",
  "session_context",
  "status_set",
  "ask_open",
  "ask_get",
  "ask_wait",
  "ask_withdraw",
  "ask_answer",
  "ask_record_answer",
  "message_send",
  "inbox_read",
  "message_ack",
];

// biome-ignore lint/suspicious/noExplicitAny: the tests read tool results loosely, as clients do.
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: any };

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "agentorg-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { ...AUTH, ...headers } },
  });
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>, options = {}) =>
    client.callTool({ name, arguments: args }, undefined, options) as Promise<Result>;
  return { client, call };
}

/** A manager created by the user, a child, and a session of each over MCP. */
async function organization(url: string) {
  const manager = await connect(url, {
    "Agentorg-Client": "claude-code",
    "Agentorg-Client-Session-Id": "m-1",
  });
  const top = await manager.call("session_attach", {
    new_agent: { title: "Run the release", purpose: "Ship 1.0." },
  });
  const managing = top.structuredContent.session.id as string;
  const created = await manager.call("agent_create", {
    session: managing,
    title: "Migrate",
    purpose: "Move to SQLite.",
  });
  const child = await connect(url, {
    "Agentorg-Client": "codex",
    "Agentorg-Client-Session-Id": "c-1",
  });
  const attached = await child.call("session_attach", { agent: created.structuredContent.id });
  return { manager, child, managing, working: attached.structuredContent.session.id as string };
}

const ASK = {
  title: "Which database?",
  context: "The service needs one store.",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommendation: "SQLite",
};

test("the instructions fit every known client", () => {
  assert.ok(INSTRUCTIONS.length > 0 && INSTRUCTIONS.length < 4096, String(INSTRUCTIONS.length));
});

test("agents get the agent operations as tools, and the instructions", async () => {
  const server = await live();
  try {
    const { client } = await connect(server.url);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      AGENT_TOOLS,
    );
    const readOnly = tools
      .filter((tool) => tool.annotations?.readOnlyHint)
      .map((tool) => tool.name);
    assert.deepEqual(readOnly, ["session_context", "ask_get", "ask_wait"]);
    assert.ok(
      tools.every(
        (tool) => tool.inputSchema.type === "object" && tool.outputSchema?.type === "object",
      ),
    );
    assert.match(client.getInstructions() ?? "", /session_attach/);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a tool call carries the client and its session id, and results match their schemas", async () => {
  const server = await live();
  try {
    const { manager, child, working } = await organization(server.url);
    const context = await child.call("session_context", {});
    assert.equal(context.isError, undefined);
    assert.equal(context.structuredContent.facts.session.id, working);
    assert.deepEqual(
      [
        context.structuredContent.facts.session.client,
        context.structuredContent.facts.session.client_session_id,
      ],
      ["codex", "c-1"],
    );
    await manager.client.close();
    await child.client.close();
  } finally {
    await server.close();
  }
});

test("refusals come back as tool errors that start with their code", async () => {
  const server = await live();
  try {
    const { call, client } = await connect(server.url);
    const invalid = await call("ask_open", { session: "ses_1", title: "x" });
    const missing = await call("ask_open", { session: "ses_404", ...ASK });
    const unknown = await call("ask_answer_as_user", { ask: "ask_1", choice: "SQLite" });
    assert.ok(invalid.isError && invalid.content[0]?.text.startsWith("invalid:"));
    assert.ok(missing.isError && missing.content[0]?.text.startsWith("not_found:"));
    assert.ok(unknown.isError && unknown.content[0]?.text.includes("unknown tool"));
    await client.close();
  } finally {
    await server.close();
  }
});

test("ask_wait reports progress until the ask is answered, and wakes", async () => {
  const server = await live({ progressIntervalMs: 50 });
  try {
    const { manager, child, managing, working } = await organization(server.url);
    const ask = (await child.call("ask_open", { session: working, ...ASK })).structuredContent;
    const progress: number[] = [];
    const waiting = child.call(
      "ask_wait",
      { ask: ask.id },
      {
        onprogress: (event: { progress: number }) => progress.push(event.progress),
        resetTimeoutOnProgress: true,
      },
    );
    while (progress.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.call("ask_answer", { session: managing, ask: ask.id, choice: "Postgres" });
    const waited = await waiting;
    assert.equal(waited.structuredContent.answer.choice, "Postgres");
    assert.deepEqual(progress.slice(0, 2), [1, 2]);
    const short = await child.call("ask_open", { session: working, ...ASK });
    const open = await child.call("ask_wait", {
      ask: short.structuredContent.id,
      timeout_seconds: 0.1,
    });
    assert.equal(open.structuredContent.state, "open");
    await manager.client.close();
    await child.client.close();
  } finally {
    await server.close();
  }
});
