// A real MCP server over stdio. `grow` adds a tool, so the server says its list changed; `die` ends
// the process, so whoever started it sees it go.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Says it back.", inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: "text", text }] }),
);
server.registerTool("refuse", { description: "Always fails." }, () => ({
  isError: true,
  content: [{ type: "text", text: "It can't be done." }],
}));
server.registerTool(
  "env",
  { description: "Tells a variable.", inputSchema: { name: z.string() } },
  ({ name }) => ({
    content: [{ type: "text", text: process.env[name] ?? "(unset)" }],
  }),
);
server.registerTool("grow", { description: "Adds a tool." }, () => {
  server.registerTool("grown", { description: "Added at run time." }, () => ({
    content: [{ type: "text", text: "grown" }],
  }));
  return { content: [{ type: "text", text: "grew" }] };
});
server.registerTool("pid", { description: "Tells its process id." }, () => ({
  content: [{ type: "text", text: String(process.pid) }],
}));
server.registerTool("die", { description: "Ends the server." }, () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: "text", text: "bye" }] };
});
await server.connect(new StdioServerTransport());
