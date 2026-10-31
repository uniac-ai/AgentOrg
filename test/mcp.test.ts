/** Explicit Tool metadata and the fixed MCP presentation offered to an occupant. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  answerOfResult,
  catalogOf,
  offeredToolsOf,
  resultOfAnswer,
} from "../src/bindings/mcp/index.ts";
import { presentToOccupant } from "../src/bindings/mcp/occupant.ts";
import type { ToolDescriptor } from "../src/domain/model/index.ts";
import { iface, until } from "./harness.ts";

test("MCP flattens explicit Tools and roundtrips identity and plain output schemas", () => {
  const catalog: ToolDescriptor[] = [
    {
      id: "hub:notes",
      name: "notes",
      interfaces: [
        {
          interface: iface("read", {
            output: { type: "object", properties: { text: { type: "string" } } },
            long_running: true,
          }),
          call: "read_note",
          read_only: true,
        },
        { interface: iface("send", { one_way: true }), call: "send_note" },
      ],
    },
    {
      id: "hub:team",
      name: "team",
      interfaces: [{ interface: iface("team"), call: "team", read_only: true }],
    },
  ];
  const wire = offeredToolsOf(catalog);
  assert.deepEqual(
    wire.map((tool) => tool.name),
    ["read_note", "send_note", "team"],
  );
  assert.deepEqual(wire[0]?._meta?.["agentorg/tool"], {
    id: "hub:notes",
    name: "notes",
    interface: "read",
    one_way: false,
    long_running: true,
  });
  assert.deepEqual(wire[0]?.outputSchema, catalog[0]?.interfaces[0]?.interface.output);
  assert.deepEqual(catalogOf(wire), catalog);
  const first = wire[0];
  assert.ok(first);
  for (const metadata of [
    undefined,
    null,
    {},
    "notes",
    { id: "hub:notes", name: "notes", interface: "read" },
    { id: 1, name: "notes", interface: "read", one_way: false, long_running: true },
  ]) {
    assert.throws(() => catalogOf([{ ...first, _meta: { "agentorg/tool": metadata } }]));
  }
  const meta = first._meta?.["agentorg/tool"] as Record<string, unknown>;
  for (const duplicate of [
    { ...first, name: "other", _meta: { "agentorg/tool": { ...meta, name: "other" } } },
    { ...first, name: "duplicate_local" },
    { ...first, _meta: { "agentorg/tool": { ...meta, id: "hub:other", interface: "other" } } },
  ])
    assert.throws(() => catalogOf([first, duplicate]));
});

test("MCP answers preserve only completed values or structured refusals", () => {
  for (const answer of [
    { state: "done", value: { summary: "Kept" } },
    { state: "refused", code: "forbidden", message: "Only its manager closes this Actor" },
  ] as const) {
    assert.deepEqual(answerOfResult(resultOfAnswer(answer)), answer);
  }
});

test("generic presentation preserves dynamic explicit Tool lists and occupant session context", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let change = () => {};
  let descriptor = iface("first");
  const contexts: unknown[] = [];
  const server = await presentToOccupant(
    {
      offers: async () => [
        {
          id: "presentation",
          name: "presentation",
          interfaces: [{ interface: descriptor, call: descriptor.name }],
        },
      ],
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
    changes++;
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
    await until("the presentation signals changed Tools", () => changes > 0);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["second"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});
