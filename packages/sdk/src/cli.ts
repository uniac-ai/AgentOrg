#!/usr/bin/env node
import { relative } from "node:path";
import { buildPackage } from "./package.js";

const [command, dir = "."] = process.argv.slice(2);
if (command !== "build") {
  process.stderr.write("Usage: agentorg build [package-dir]\n");
  process.exit(2);
}
try {
  const built = await buildPackage(dir);
  process.stdout.write(
    `${built.manifest.name}@${built.manifest.version} ${built.hash}\n${relative(process.cwd(), built.file)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
