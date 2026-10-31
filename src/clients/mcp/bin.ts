#!/usr/bin/env node
import { run } from "../../runtime/command.ts";
import { mcpCommand } from "./command.ts";

process.exitCode = await run("agentorg-mcp", process.argv.slice(2), mcpCommand);
