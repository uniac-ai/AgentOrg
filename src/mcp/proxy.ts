/**
 * The stdio proxy, `agentorg mcp`: the same MCP server as `/mcp`, served over stdin and stdout for
 * clients that only spawn stdio servers, with each tool call performed over the service's API.
 *
 * The proxy knows no client. Its flags name the client kind and the environment variable holding
 * the client's session id, and every call carries both, so a client-provided session id reaches
 * `session_attach` without the agent passing it. When the service is down, the tools still list
 * and each call fails as `unavailable`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Caller, Operations } from "../operations/index.ts";
import { buildServer } from "./server.ts";

/**
 * Serve MCP on stdio until the client closes it. The SDK's stdio transport does not notice stdin
 * ending, so the end of stdin is what closes the server.
 */
export async function runProxy(operations: Operations, caller: Caller): Promise<void> {
  const server = buildServer(operations, { caller });
  const ended = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  await ended;
  await server.close();
}
