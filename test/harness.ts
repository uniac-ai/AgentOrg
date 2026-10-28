/** A real core over a fresh store on a free port, and fake actors that dial it. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
  const store = new Store(join(directory, "core.db"));
  const core = new Core(store, options);
  const credentialFile = join(directory, "root-credential");
  const root = rootCredential(core.registry, credentialFile);
  const server = await listen(core.app, { port: 0 });
  const actors: ActorConnection[] = [];
  return {
    core,
    url: server.url,
    /** The root's credential. */
    root,
    rootId: core.registry.root()?.id as string,
    credentialFile,
    /** Connect a fake actor with this credential, closed with the core. */
    async connect(credential: string, actor: FakeActor = fakeActor()) {
      const connection = new ActorConnection({ url: server.url, credential, server: actor.server });
      actors.push(connection);
      await connection.open();
      return connection;
    },
    async close() {
      await Promise.allSettled(actors.map((actor) => actor.close()));
      await core.close();
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type Handler = (params: CallToolRequest["params"]) => Promise<CallToolResult>;

export interface FakeActor {
  server: Server;
  tools: Tool[];
  /** Calls the actor received, in order. */
  received: CallToolRequest["params"][];
}

/** An actor exposing `tools`, answering each call with `handler`. */
export function fakeActor(
  tools: Tool[] = [],
  handler: Handler = async () => ({ content: [] }),
): FakeActor {
  const server = new Server(
    { name: "fake", version: "0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const actor: FakeActor = { server, tools, received: [] };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: actor.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    actor.received.push(request.params);
    return handler(request.params);
  });
  return actor;
}

export const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});

/** Wait until `condition` holds, failing after a generous guard that names what never happened. */
export async function until(what: string, condition: () => boolean, guardMs = 5000) {
  const deadline = Date.now() + guardMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
