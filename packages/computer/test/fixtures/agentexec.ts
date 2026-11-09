// Stands in for AgentExec's built file: the same command line, and the tools each level offers.
import { readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const { values } = parseArgs({
  options: { workspace: { type: "string" }, level: { type: "string" } },
});
const root = realpathSync(values.workspace as string);
const tools = ["read", "list", "search"];
if (values.level !== "read") tools.push("edit");
if (values.level === "terminal") tools.push("exec_command", "write_stdin");

const server = new McpServer({ name: "agentexec-stand-in", version: "0" });
for (const name of tools)
  server.registerTool(name, { description: `Stands in for ${name}.` }, () => ({
    content: [
      { type: "text", text: `${name} in ${root}: ${readFileSync(`${root}/seen.txt`, "utf8")}` },
    ],
  }));
await server.connect(new StdioServerTransport());
