/**
 * An actor's MCP server for the session that fills its position, as a Claude Code or Codex session
 * starts it over stdio. It lists the actor's offers as tools and answers each call with the
 * actor's answer, encoded as the core encodes them, so the session sees what a caller of the core
 * sees. It is separate from the core's own server, and tells the session when the offers change.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Presented } from "../../actor/api.ts";
import { VERSION } from "../../version.ts";
import { offeredToolOf, resultOfAnswer } from "./encoding.ts";

/** Serve `presented` on `transport`, by default this process's stdin and stdout. */
export async function presentToOccupant(
  presented: Presented,
  transport: Transport = new StdioServerTransport(),
): Promise<{ close(): Promise<void> }> {
  const server = new Server(
    { name: "agentorg", version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: presented.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await presented.offers()).map(offeredToolOf),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const progressToken = params._meta?.progressToken;
    let progress = 0;
    const answer = await presented.call(params.name, params.arguments ?? {}, {
      ...(typeof params._meta?.threadId === "string" ? { session: params._meta.threadId } : {}),
      progress: (message) => {
        if (progressToken === undefined) return;
        progress += 1;
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, message },
          })
          .catch(() => {});
      },
    });
    return resultOfAnswer(answer);
  });
  presented.onChange(() => void server.sendToolListChanged().catch(() => {}));
  await server.connect(transport);
  return { close: () => server.close() };
}
