#!/usr/bin/env node
import { relative } from "node:path";
import { BuildError, buildPackage } from "./package.js";

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
  // A BuildError says what to fix; anything else is a bug, so its stack is shown.
  process.stderr.write(
    `${error instanceof BuildError ? error.message : error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
}
