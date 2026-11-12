// A real MCP server over stdio with its own names for a call's group and a group's stop: `meta`
// tells what its call carried in `_meta`, and `stopped` the groups it was asked to stop. It fails
// to stop the group "fails".
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const stopped: string[] = [];
const server = new McpServer({ name: "groups", version: "1.0.0" });
server.registerTool("meta", { description: "Tells what its call carried." }, (ctx) => ({
  content: [{ type: "text", text: JSON.stringify(ctx.mcpReq._meta ?? {}) }],
}));
server.registerTool("stopped", { description: "Tells the groups it was asked to stop." }, () => ({
  content: [{ type: "text", text: JSON.stringify(stopped) }],
}));
server.server.setRequestHandler(
  "test/group/stop",
  { params: z.object({ group: z.string() }), result: z.object({ stopped: z.number() }) },
  ({ group }) => {
    if (group === "fails") throw new Error("It can't be stopped.");
    stopped.push(group);
    return { stopped: 1 };
  },
);
await server.connect(new StdioServerTransport());
