/**
 * The core as each admitted actor's MCP server on its bidirectional channel. Each request
 * acts as the immutable identity admitted on that connection: its tool list
 * is the domain's offers to it, and a tool call is an invocation, with progress notifications
 * while the domain waits.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Application } from "../../domain/ports.ts";
import { VERSION } from "../../version.ts";
import { offeredToolsOf, resultOfAnswer } from "./encoding.ts";

export async function serveActor(
  application: Application,
  party: string,
  transport: Transport,
  connectionId?: string,
): Promise<void> {
  const server = new Server(
    { name: "agentorg", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offeredToolsOf(application.available(party, connectionId)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const progressToken = params._meta?.progressToken;
    let progress = 0;
    const answer = await application.invoke(party, params.name, params.arguments ?? {}, {
      ...(connectionId === undefined ? {} : { connectionId }),
      signal: extra.signal,
      progress: async (message) => {
        if (progressToken === undefined) return;
        progress += 1;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, message },
        });
      },
    });
    return resultOfAnswer(answer);
  });
  await server.connect(transport);
}
