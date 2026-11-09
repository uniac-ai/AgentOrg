// Stands in for Playwright MCP: says how it was started, and offers a browser's tools.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "playwright-stand-in", version: "0" });
for (const name of ["browser_navigate", "browser_snapshot", "browser_run_code_unsafe"])
  server.registerTool(name, { description: `Stands in for ${name}.` }, () => ({
    content: [{ type: "text", text: `${process.cwd()} ${process.argv.slice(2).join(" ")}` }],
  }));
await server.connect(new StdioServerTransport());
