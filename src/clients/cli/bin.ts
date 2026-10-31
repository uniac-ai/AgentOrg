#!/usr/bin/env node
import { run } from "../../runtime/command.ts";
import { main } from "./index.ts";

process.exitCode = await run("agentorg", process.argv.slice(2), main);
