/** Exercise application entry points with isolated environments and owned child processes. */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const BINS = {
  cli: "../src/clients/cli/bin.js",
  mcp: "../src/clients/mcp/bin.js",
  server: "../src/server/bin.js",
  web: "../src/clients/web/bin.js",
};
type Program = keyof typeof BINS;

export function command(program: Program, args: string[], env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(BINS[program], import.meta.url)), ...args],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
  return Object.assign(done, { child });
}

export async function serving(program: Program, env: Record<string, string>, args: string[] = []) {
  const running = command(program, args, env);
  const child = running.child;
  const url = await new Promise<string>((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      const match = /serving on (http:\/\/[\d.:]+)/.exec(log);
      if (match?.[1]) resolve(match[1]);
    });
    running.then(
      ({ status, stderr }) => reject(new Error(`${program} exited ${status}: ${stderr}`)),
      reject,
    );
  });
  return {
    process: child,
    url,
    async close() {
      if (child.exitCode === null) child.kill("SIGTERM");
      return running;
    },
  };
}

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
