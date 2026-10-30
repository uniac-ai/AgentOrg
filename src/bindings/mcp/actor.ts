/**
 * An actor's side of MCP, behind the actor library's API. Calls out go from an MCP client and
 * calls in come to an MCP server on the same admitted channel. The server serves the actor's
 * handlers. A long-running handler runs as an MCP task: the task is created at once, and finished
 * when the handler's promise settles. A cancelled task aborts the handler's signal.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Task,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Actor, CallOptions, Exposed, Reply } from "../../actor/api.ts";
import type { Connector } from "../../connection/index.ts";
import type { Answer, Outcome, ToolDescriptor } from "../../domain/model/index.ts";
import { VERSION } from "../../version.ts";
import {
  answerOfResult,
  CALL_META,
  CAUSE_META,
  catalogOf,
  type DeliveredCall,
  exposedToolOf,
  resultOfOutcome,
} from "./encoding.ts";
import { mcpTransports } from "./transport.ts";

/** How often the core's wait on a task's result looks again. */
const POLL_MS = 500;

/** A task store that aborts a task's handler when the task is cancelled. */
class CancellableTasks extends InMemoryTaskStore {
  readonly controllers = new Map<string, AbortController>();

  override async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    message?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, message, sessionId);
    if (status === "cancelled") this.controllers.get(taskId)?.abort();
  }
}

const outcomeOfReply = (reply: Reply): Outcome => ({
  ok: true,
  value: reply.value ?? null,
  parts: reply.parts ?? [],
});

export class McpActor implements Actor {
  private readonly connector: Connector;
  private readonly client: Client;
  private readonly server: Server | undefined;
  private exposed: Exposed[];
  private connected = false;

  constructor(connector: Connector, exposed: Exposed[] | undefined, name: string) {
    this.connector = connector;
    this.exposed = exposed ?? [];
    this.client = new Client({ name, version: VERSION });
    this.server = exposed === undefined ? undefined : this.serve(name);
  }

  get ended(): number | undefined {
    return this.connector.ended;
  }

  private serve(name: string): Server {
    const tasks = new CancellableTasks();
    const server = new Server(
      { name, version: VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          tasks: { requests: { tools: { call: {} } }, cancel: {} },
        },
        taskStore: tasks,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.exposed.map((each) => exposedToolOf(each.interface)),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const exposed = this.exposed.find((each) => each.interface.name === params.name);
      if (!exposed) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${params.name}`);
      const delivered = params._meta?.[CALL_META] as DeliveredCall | undefined;
      const incoming = {
        id: delivered?.id ?? "",
        from: delivered?.from ?? "",
        cause: delivered?.cause ?? null,
      };
      const run = (signal: AbortSignal): Promise<Outcome> =>
        Promise.resolve()
          .then(() => exposed.handle(params.arguments ?? {}, { ...incoming, signal }))
          .then(outcomeOfReply, (error: Error) => ({ ok: false, error: error.message }));
      if (params.task === undefined || extra.taskStore === undefined) {
        return resultOfOutcome(await run(extra.signal));
      }
      const store = extra.taskStore;
      const task = await store.createTask({ pollInterval: POLL_MS });
      const controller = new AbortController();
      tasks.controllers.set(task.taskId, controller);
      void run(controller.signal).then(async (outcome) => {
        tasks.controllers.delete(task.taskId);
        if (controller.signal.aborted) return;
        const status = outcome.ok ? "completed" : "failed";
        await store
          .storeTaskResult(task.taskId, status, resultOfOutcome(outcome) as CallToolResult)
          .catch(() => {});
      });
      return { task };
    });
    return server;
  }

  async open(): Promise<void> {
    await this.connector.connect(async (channel) => {
      const transports = mcpTransports(channel, this.server !== undefined);
      if (this.server && transports.server) await this.server.connect(transports.server);
      await this.client.connect(transports.client);
    });
    this.connected = true;
  }

  async available(): Promise<ToolDescriptor[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return catalogOf(tools);
  }

  async call(
    name: string,
    input: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<Answer> {
    const result = await this.client.callTool(
      {
        name,
        arguments: input,
        ...(options.cause === undefined ? {} : { _meta: { [CAUSE_META]: options.cause } }),
      },
      undefined,
      {
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.progress
          ? {
              onprogress: (progress: { message?: string }) =>
                options.progress?.(progress.message ?? ""),
            }
          : {}),
      },
    );
    return answerOfResult(result as CallToolResult);
  }

  async expose(exposed: Exposed[]): Promise<void> {
    if (!this.server) throw new Error("this client exposes nothing");
    this.exposed = exposed;
    if (this.connected) await this.server.sendToolListChanged().catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.client.close(), this.connector.close()]);
  }
}
