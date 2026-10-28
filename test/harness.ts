/** A real core over a fresh store on a free port, and fake actors that dial it. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { listen } from "../src/core/app.ts";
import { Core, type CoreOptions, rootCredential } from "../src/core/index.ts";
import { Store } from "../src/core/store.ts";
import { ActorConnection } from "../src/protocol/index.ts";

export async function startCore(options: CoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-core-"));
  const credentialFile = join(directory, "root-credential");
  let store = new Store(join(directory, "core.db"));
  let core = new Core(store, options);
  const root = rootCredential(core.registry, credentialFile);
  let server = await listen(core.app, { port: 0 });
  const port = Number(new URL(server.url).port);
  const actors: ActorConnection[] = [];
  const stop = async () => {
    await core.close();
    await server.close();
    store.close();
  };
  return {
    get core() {
      return core;
    },
    url: server.url,
    /** The root's credential. */
    root,
    rootId: core.registry.root()?.id as string,
    credentialFile,
    /** Connect a fake actor with this credential, closed with the core. */
    async connect(credential: string, actor: FakeActor = fakeActor()) {
      const connection = new ActorConnection({
        url: server.url,
        credential,
        server: actor.server,
        maxRetryMs: 100,
      });
      actors.push(connection);
      await connection.open();
      return connection;
    },
    /** Stop the core and start it again on the same database and port. */
    async restart() {
      await stop();
      store = new Store(join(directory, "core.db"));
      core = new Core(store, options);
      server = await listen(core.app, { port });
    },
    async close() {
      await Promise.allSettled(actors.map((actor) => actor.close()));
      await stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type Handler = (params: CallToolRequest["params"]) => Promise<CallToolResult>;

export interface HeldTask {
  taskId: string;
  params: CallToolRequest["params"];
  /** Finish the task, as when the human answers. */
  complete(result: CallToolResult, status?: "completed" | "failed"): Promise<void>;
}

export interface FakeActor {
  server: Server;
  tools: Tool[];
  /** Calls the actor received, in order. */
  received: CallToolRequest["params"][];
  /** Calls it took as tasks, in order. */
  tasks: HeldTask[];
  taskStore: InMemoryTaskStore | undefined;
}

/**
 * An actor exposing `tools`, answering each call with `handler`. With `tasks`, it has a task store,
 * and a call that asks for a task gets one, which the test completes.
 */
export function fakeActor(
  tools: Tool[] = [],
  handler: Handler = async () => ({ content: [] }),
  options: { tasks?: boolean } = {},
): FakeActor {
  const taskStore = options.tasks ? new InMemoryTaskStore() : undefined;
  const server = new Server(
    { name: "fake", version: "0" },
    taskStore
      ? {
          capabilities: {
            tools: { listChanged: true },
            tasks: { requests: { tools: { call: {} } }, cancel: {} },
          },
          taskStore,
        }
      : { capabilities: { tools: { listChanged: true } } },
  );
  const actor: FakeActor = { server, tools, received: [], tasks: [], taskStore };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: actor.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    actor.received.push(request.params);
    const store = extra.taskStore as RequestTaskStore | undefined;
    if (request.params.task && store) {
      const task = await store.createTask({ pollInterval: 20 });
      actor.tasks.push({
        taskId: task.taskId,
        params: request.params,
        complete: (result, status = "completed") =>
          store.storeTaskResult(task.taskId, status, result),
      });
      return { task };
    }
    return handler(request.params);
  });
  return actor;
}

export const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});

/** A result with structured content, as a tool with an output schema returns it. */
export const structured = (value: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

/** Wait until `condition` holds, failing after a generous guard that names what never happened. */
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  guardMs = 5000,
) {
  const deadline = Date.now() + guardMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
