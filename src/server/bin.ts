#!/usr/bin/env node
import { run } from "../runtime/command.ts";
import { main } from "./command.ts";

process.exitCode = await run("agentorg-server", process.argv.slice(2), main);
