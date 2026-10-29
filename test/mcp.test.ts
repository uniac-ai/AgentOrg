/** The MCP binding on the wire: what the core lists, how calls arrive, and how results come back. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CALL_META, PATHS, PENDING_OUTPUT, SUBPROTOCOL } from "../src/bindings/mcp/index.ts";
import { presentToOccupant } from "../src/bindings/mcp/occupant.ts";
import { ChannelTransport } from "../src/bindings/mcp/transport.ts";
import { Connector } from "../src/network/index.ts";
import { iface, startCore, until } from "./harness.ts";

test("generic presentation preserves dynamic tool lists and optional occupant session context", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let change = () => {};
  let descriptor = iface("first");
  const contexts: unknown[] = [];
  const server = await presentToOccupant(
    {
      offers: async () => [{ interface: descriptor, routed: false }],
      call: async (_name, _input, options) => {
        contexts.push(options?.session);
        return { state: "done", value: {} };
      },
      onChange: (listener) => {
        change = listener;
      },
    },
    serverTransport,
  );
  const client = new Client({ name: "dynamic-occupant", version: "0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changes += 1;
  });
  try {
    await client.connect(clientTransport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["first"],
    );
    await client.callTool({ name: "first", arguments: {} });
    await client.callTool({ name: "first", arguments: {}, _meta: { threadId: "conversation" } });
    assert.deepEqual(contexts, [undefined, "conversation"]);
    descriptor = iface("second");
    change();
    await until("the generic presentation signals its changed tools", () => changes > 0);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["second"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("over MCP, the core lists offers as tools, delivers calls as tasks with their metadata, and answers with receipts", async () => {
  const core = await startCore({ waitMs: 200, stepMs: 50 });
  // The root as a raw MCP server that takes decide as a task.
  const held: { params: CallToolRequest["params"]; taskId: string; store: RequestTaskStore }[] = [];
  const server = new Server(
    { name: "raw", version: "0" },
    {
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
      taskStore: new InMemoryTaskStore(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "decide",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { choice: { type: "string" } },
          required: ["choice"],
        },
        execution: { taskSupport: "optional" },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const store = extra.taskStore as RequestTaskStore;
    const task = await store.createTask({ pollInterval: 60_000 });
    held.push({ params, taskId: task.taskId, store });
    return { task };
  });
  const connector = new Connector({
    url: core.url,
    credential: core.root,
    paths: PATHS,
    subprotocol: SUBPROTOCOL,
  });
  const root = new Client({ name: "root", version: "0" });
  await root.connect(
    new StreamableHTTPClientTransport(connector.requestUrl, { fetch: connector.fetch }),
  );
  await connector.connect((channel) => server.connect(new ChannelTransport(channel)));
  const prog = new Client({ name: "prog", version: "0" });
  try {
    await until("root online", () => core.org.connections.link(core.rootId) !== undefined);
    const created = (await root.callTool({
      name: "actor_create",
      arguments: { name: "prog", purpose: "A program" },
    })) as CallToolResult;
    const { actor, credential } = created.structuredContent as {
      actor: { id: string };
      credential: string;
    };
    await prog.connect(
      new StreamableHTTPClientTransport(new URL(PATHS.request, core.url), {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      }),
    );

    const { tools } = await prog.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.team?.annotations?.readOnlyHint, true);
    assert.equal(byName.actor_create?.annotations?.readOnlyHint, false);
    assert.equal(byName["manager.decide"]?.execution, undefined, "the core runs no tasks itself");
    const anyOf = byName["manager.decide"]?.outputSchema?.anyOf as unknown[];
    assert.deepEqual(anyOf[1], PENDING_OUTPUT);

    const progress: number[] = [];
    const pending = (await prog.callTool({ name: "manager.decide", arguments: {} }, undefined, {
      onprogress: (notification) => progress.push(notification.progress),
    })) as CallToolResult;
    const receipt = pending._meta?.[CALL_META] as { id: string; state: string };
    assert.deepEqual(pending.structuredContent, { call: receipt.id, state: "pending" });
    assert.equal(receipt.state, "pending");
    assert.ok(progress.length > 0);

    await until("decide delivered", () => held.length === 1);
    assert.deepEqual(held[0]?.params._meta?.[CALL_META], {
      id: receipt.id,
      from: actor.id,
      cause: null,
    });
    assert.deepEqual(held[0]?.params.task, {});

    // Finishing the task settles the call through the actor's status notice: the actor's own
    // wait on the task looks again only after a minute, far past this wait.
    await held[0]?.store.storeTaskResult(held[0].taskId, "completed", {
      content: [{ type: "text", text: "yes" }],
      structuredContent: { choice: "yes" },
    });
    const result = (await prog.callTool({
      name: "call_result",
      arguments: { call: receipt.id, wait: 5 },
    })) as CallToolResult;
    const call = result.structuredContent as { state: string; output: unknown };
    assert.equal(call.state, "done");
    assert.deepEqual(call.output, {
      value: { choice: "yes" },
      parts: [{ type: "text", text: "yes" }],
    });
  } finally {
    await prog.close();
    await Promise.allSettled([root.close(), connector.close()]);
    await core.close();
  }
});
