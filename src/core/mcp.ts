/**
 * `/mcp`: the core as every actor's MCP server, over Streamable HTTP. Each request stands alone,
 * without an MCP session, and acts as the actor its credential names. What the actor may list and
 * call is the surface's to say.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.ts";

export interface CallContext {
  /** Tell the caller the call is still running, when it asked for progress. */
  progress(message: string): Promise<void>;
  /** Aborted when the caller cancels or goes away. */
  signal: AbortSignal;
}

export interface Surface {
  /** The actor's available tools. */
  tools(actor: string): Tool[];
  call(
    actor: string,
    params: CallToolRequest["params"],
    context: CallContext,
  ): Promise<CallToolResult>;
}

export async function handleMcp(
  surface: Surface,
  actor: string,
  request: Request,
): Promise<Response> {
  const server = new Server(
    { name: "agentorg", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: surface.tools(actor) }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    const progressToken = call.params._meta?.progressToken;
    let progress = 0;
    return surface.call(actor, call.params, {
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
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
