/**
 * The human's queue: the calls into the user, held as MCP tasks. The core delivers a call to
 * `decide`, `note` or `report` as a task-augmented `tools/call`; the human's server takes it as a
 * task at once, and the call waits here until the user answers it in the web app, which completes
 * the task. The queue lives in memory: after a restart the core finds its tasks unknown and
 * delivers every pending call again, which rebuilds it.
 */

import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CALL_META, type DeliveredCall } from "../bindings/mcp/index.ts";
import { VERSION } from "../version.ts";
import { isToolName, TOOL_LIST, TOOLS } from "./tools.ts";
import type { Pending } from "./types.ts";

/** How often the core's wait on a task's result looks again. */
const POLL_MS = 500;

/** A call the human refuses: the core records it as failed, with this message. */
const refuse = (message: string) => new McpError(ErrorCode.InvalidParams, message);

interface Held {
  pending: Pending;
  task: string;
  store: RequestTaskStore;
}

export class Queue {
  /** The MCP server the core reaches over the reverse connection. */
  readonly server: Server;
  readonly #held = new Map<string, Held>();

  constructor() {
    this.server = new Server(
      { name: "agentorg-human", version: VERSION },
      {
        capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } },
        taskStore: new InMemoryTaskStore(),
      },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));
    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const delivered = params._meta?.[CALL_META] as DeliveredCall | undefined;
      if (!isToolName(params.name)) throw refuse(`unknown tool ${params.name}`);
      const input = TOOLS[params.name].input.safeParse(params.arguments ?? {});
      if (!input.success) throw refuse(`invalid: ${z.prettifyError(input.error)}`);
      if (params.task === undefined || extra.taskStore === undefined || !delivered?.id) {
        throw refuse(`${params.name} runs as a task of a call the core delivers`);
      }
      const task = await extra.taskStore.createTask({ pollInterval: POLL_MS });
      this.#held.set(delivered.id, {
        pending: {
          call: delivered.id,
          from: delivered.from,
          cause: delivered.cause,
          tool: params.name,
          input: input.data,
          received_at: new Date().toISOString(),
        } as Pending,
        task: task.taskId,
        store: extra.taskStore,
      });
      return { task };
    });
  }

  /** The calls waiting on the user, oldest first. One its caller withdrew is dropped. */
  async pending(): Promise<Pending[]> {
    for (const [call, held] of this.#held) {
      const task = await held.store.getTask(held.task).catch(() => undefined);
      if (task?.status !== "working") this.#held.delete(call);
    }
    return [...this.#held.values()].map((held) => held.pending);
  }

  /** Complete a waiting call with its output; false when the call no longer waits. */
  async complete(call: string, output: Record<string, unknown>): Promise<boolean> {
    const held = this.#held.get(call);
    if (held === undefined) return false;
    this.#held.delete(call);
    const result = {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
    return held.store
      .storeTaskResult(held.task, "completed", result as CallToolResult)
      .then(() => true)
      .catch(() => false);
  }
}
