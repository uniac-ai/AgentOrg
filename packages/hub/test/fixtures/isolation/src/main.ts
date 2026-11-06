// A test package that tries everything a host process mustn't do, and says how each went.
import { defineActor, defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";

const ROWS = [
  "own",
  "read",
  "write",
  "child",
  "worker",
  "fetch",
  "tcp",
  "dns",
  "signal",
  "unix",
  "home",
  "environ",
  "env",
] as const;

export const isolation = defineInterface({
  name: "isolation",
  major: 1,
  kind: "rpc",
  methods: {
    tryAll: method({
      input: z.object({
        hubPid: z.number().int(),
        port: z.number().int(),
        socket: z.string(),
        home: z.string(),
      }),
      output: z.object(Object.fromEntries(ROWS.map((row) => [row, z.string()]))),
    }),
    allocate: method({ input: z.object({}), output: z.object({}) }),
  },
});

/** How an attempt went: `allowed`, or `blocked: <code>` with the error it got. */
async function attempt(work: () => unknown): Promise<string> {
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => setTimeout(() => reject({ code: "TIMEOUT" }), 5000)),
    ]);
    return "allowed";
  } catch (error) {
    const { code, cause } = error as { code?: string; cause?: { code?: string } };
    return `blocked: ${code ?? cause?.code ?? String(error)}`;
  }
}

export default defineActor({
  exports: { isolation },
  start(ctx) {
    // Built-ins through the process, not imports: a package's bundle has none.
    const fs = process.getBuiltinModule("node:fs");
    const net = process.getBuiltinModule("node:net");
    const dns = process.getBuiltinModule("node:dns");
    const childProcess = process.getBuiltinModule("node:child_process");
    const workers = process.getBuiltinModule("node:worker_threads");
    const kept: unknown[] = [];
    ctx.exports.isolation.implement({
      tryAll: async ({ hubPid, port, socket, home }) => ({
        own: await attempt(() => fs.readFileSync(`${process.argv[2]}/agentorg.json`)),
        read: await attempt(() => fs.readFileSync("/etc/hosts")),
        write: await attempt(() => fs.writeFileSync(`/tmp/agentorg-isolation-${process.pid}`, "x")),
        child: await attempt(() => childProcess.spawnSync("/bin/echo", ["hi"])),
        worker: await attempt(() => new workers.Worker("0", { eval: true }).terminate()),
        fetch: await attempt(() => fetch("https://example.com")),
        tcp: await attempt(
          () =>
            new Promise((resolve, reject) => {
              const socket = net.connect(port, "127.0.0.1", () => resolve(socket.destroy()));
              socket.once("error", reject);
            }),
        ),
        dns: await attempt(() => dns.promises.lookup("example.com")),
        signal: await attempt(() => process.kill(hubPid, 0)),
        // A Unix socket the Hub's user owns: outside the network namespace's reach on Linux, so
        // it must not be there at all.
        unix: await attempt(
          () =>
            new Promise((resolve, reject) => {
              const socket_ = net.connect(socket, () => resolve(socket_.destroy()));
              socket_.once("error", reject);
            }),
        ),
        home: await attempt(() => fs.readFileSync(`${home}/person-credential`)),
        environ: await attempt(() => fs.readFileSync("/proc/1/environ")),
        // Nothing of the Hub's environment; macOS adds its own text-encoding variable.
        env: Object.keys(process.env)
          .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
          .join(","),
      }),
      allocate: async () => {
        for (;;) kept.push(new Array(1_000_000).fill(kept.length));
      },
    });
  },
});
