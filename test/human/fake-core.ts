/**
 * The core's connection layer with routing stood in, for testing the human actor before the core
 * routes calls. The real registry, endpoints and reverse connection run; the root's `/mcp` tools
 * and the delivery of calls into the human are this file's. A call into the human is delivered as
 * an MCP task, waited on with `tasks/result`, asked for again after a reconnect, and delivered again
 * when the human no longer knows its task, as the protocol describes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/experimental/tasks/types.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  CancelTaskResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createApp, listen } from "../../src/core/app.ts";
import { Connections } from "../../src/core/connections.ts";
import { rootCredential } from "../../src/core/index.ts";
import type { Surface } from "../../src/core/mcp.ts";
import { Registry } from "../../src/core/registry.ts";
import { Store } from "../../src/core/store.ts";
import { CALL_META } from "../../src/protocol/index.ts";

export interface FakeCall {
  call: string;
  from: string;
  tool: string;
  input: Record<string, unknown>;
  state: "pending" | "done" | "failed" | "withdrawn";
  task?: string;
  output?: unknown;
  error?: string;
}

export const STORAGE = "act_storage";

/** The tools available to the root: the core's built-ins it uses, and one tool of a report. */
const ROOT_TOOLS = ["view", "activity", "release.storage.review"].map((name) => ({
  name,
  inputSchema: { type: "object" as const },
}));

const ok = (structured: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
});
const refused = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const isUnknownTask = (error: unknown) =>
  error instanceof McpError && error.code === ErrorCode.InvalidParams;
const isDropped = (error: unknown) =>
  error instanceof McpError && error.code === ErrorCode.ConnectionClosed;

/** Longer than any test: `tasks/result` holds until the human answers. */
const FOREVER = { timeout: 2 ** 31 - 1 };

export async function fakeCore() {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-human-core-"));
  const store = new Store(join(directory, "core.db"));
  const registry = new Registry(store, () => new Date().toISOString());
  const connections = new Connections(registry);
  const credential = rootCredential(registry, join(directory, "root-credential"));
  const root = registry.root()?.id as string;
  const calls = new Map<string, FakeCall>();
  const waiting = new Map<string, (call: FakeCall) => void>();
  const running = new Set<string>();
  /** The arguments of every call the root made to a tool of another actor. */
  const routed: [string, unknown][] = [];
  let count = 0;
  let onlines = 0;
  let closed = false;

  function settle(call: FakeCall, result: CallToolResult) {
    if (result.isError) {
      Object.assign(call, { state: "failed", error: JSON.stringify(result.content) });
    } else Object.assign(call, { state: "done", output: result.structuredContent });
    waiting.get(call.call)?.(call);
  }

  const taskResult = (client: Client, taskId: string) =>
    client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema, FOREVER);

  /** Deliver a pending call, or wait again on the task it already has. */
  async function run(call: FakeCall) {
    const client = connections.peer(root);
    if (!client || running.has(call.call) || call.state !== "pending") return;
    running.add(call.call);
    try {
      if (call.task !== undefined) {
        try {
          return settle(call, await taskResult(client, call.task));
        } catch (error) {
          if (!isUnknownTask(error)) return;
          call.task = undefined;
        }
      }
      const answer = await client.request(
        {
          method: "tools/call",
          params: {
            name: call.tool,
            arguments: call.input,
            _meta: { [CALL_META]: { id: call.call, from: call.from, cause: null } },
            task: {},
          },
        },
        z.union([CreateTaskResultSchema, CallToolResultSchema]),
      );
      const created = CreateTaskResultSchema.safeParse(answer);
      if (!created.success) return settle(call, CallToolResultSchema.parse(answer));
      call.task = created.data.task.taskId;
      settle(call, await taskResult(client, call.task));
    } catch (error) {
      // After a drop the call runs again when the human comes back online; else it failed.
      if (!isDropped(error)) settle(call, refused((error as Error).message));
    } finally {
      running.delete(call.call);
    }
  }

  connections.onOnline = (actor) => {
    if (actor !== root) return;
    onlines += 1;
    for (const call of calls.values()) void run(call);
  };

  const surface: Surface = {
    tools: () => ROOT_TOOLS,
    call: async (_actor, params) => {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      switch (params.name) {
        case "view":
          if (args.actor !== undefined && args.actor !== STORAGE) {
            return refused(`not_found: no actor ${args.actor}`);
          }
          return ok({
            actor: { id: args.actor ?? root },
            pending: args.actor
              ? []
              : [...calls.values()].filter((call) => call.state === "pending"),
          });
        case "activity":
          return ok({ entries: [], request: args });
        case "release.storage.review":
          routed.push([params.name, args]);
          return ok({ approved: true });
        default:
          return refused(`not_found: there is no tool ${params.name}`);
      }
    },
  };

  const server = await listen(createApp(connections, surface), { port: 0 });

  return {
    url: server.url,
    credential,
    calls,
    routed,
    /** How many times the human came online. */
    onlines: () => onlines,
    /** The core's client of the human's server, while its reverse connection is open. */
    peer: () => connections.peer(root),

    /** Record a call from `from` into one of the human's tools and deliver it; returns its id. */
    deliver(tool: string, input: Record<string, unknown>, from = STORAGE): string {
      const call: FakeCall = { call: `call_${++count}`, from, tool, input, state: "pending" };
      calls.set(call.call, call);
      void run(call);
      return call.call;
    },

    /** The caller withdraws a pending call, which cancels the human's task. */
    async withdraw(id: string) {
      const call = calls.get(id) as FakeCall;
      call.state = "withdrawn";
      await connections
        .peer(root)
        ?.request(
          { method: "tasks/cancel", params: { taskId: call.task } },
          CancelTaskResultSchema,
        );
    },

    /** The call once it is done or failed. */
    settled(id: string): Promise<FakeCall> {
      const call = calls.get(id);
      if (call && call.state !== "pending") return Promise.resolve(call);
      return new Promise((resolve) => waiting.set(id, resolve));
    },

    /** End the human's reverse connection, as a network drop would. */
    async drop() {
      await connections.closeAll();
    },

    async close() {
      if (closed) return;
      closed = true;
      await connections.closeAll();
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type FakeCore = Awaited<ReturnType<typeof fakeCore>>;
