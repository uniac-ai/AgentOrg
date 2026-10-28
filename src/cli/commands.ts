/** The commands that do more than parse flags: the core, and a built-in run over `/mcp`. */

import { once } from "node:events";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { databasePath, ensureHome, readCredential, rootCredentialPath } from "../home.ts";
import { type BuiltinName, coreUrl, DEFAULT_CORE_PORT, MCP_PATH } from "../protocol/index.ts";
import { VERSION } from "../version.ts";

const note = (text: string) => process.stderr.write(`agentorg: ${text}\n`);

/**
 * Load the store, which only the core needs, without the warning Node 22 prints the first time
 * `node:sqlite` loads, which would otherwise open every core log. Other warnings pass through.
 */
async function withoutSqliteWarning<T>(load: () => Promise<T>): Promise<T> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    const type = typeof options === "string" ? options : (options as { type?: string })?.type;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await load();
  } finally {
    process.emitWarning = emitWarning;
  }
}

export const CORE_HELP = `usage: agentorg core [--port <n>]

Run the core on 127.0.0.1, at --port, else AGENTORG_PORT, else ${DEFAULT_CORE_PORT}. On first start it creates the agentorg home (AGENTORG_HOME, default ~/.local/share/agentorg), the root actor, and the root's credential in root-credential, readable only by you; when that file is gone, it mints a new one. It logs to stderr and stops on SIGINT or SIGTERM.`;

export async function coreCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  const port = Number(values.port ?? (process.env.AGENTORG_PORT || DEFAULT_CORE_PORT));
  ensureHome();
  const { Store } = await withoutSqliteWarning(() => import("../core/store.ts"));
  const { Core, rootCredential } = await import("../core/index.ts");
  const { listen } = await import("../core/app.ts");
  const store = new Store(databasePath());
  const core = new Core(store);
  rootCredential(core.registry, rootCredentialPath());
  core.connections.onError = (actor, error) =>
    note(`the reverse connection of ${actor} failed to start: ${error.message}`);
  const server = await listen(core.app, { port });
  note(`core serving on ${server.url}; the root's credential is in ${rootCredentialPath()}`);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await core.close();
  await server.close();
  store.close();
  return 0;
}

/**
 * Run a built-in over `/mcp` as the actor whose credential is in `AGENTORG_CREDENTIAL`, else as
 * the root, and print its result as JSON. A refusal goes to stderr, with exit status 1.
 */
export async function builtinCommand(
  name: BuiltinName,
  request: Record<string, unknown>,
): Promise<number> {
  const credential = readCredential();
  if (!credential) {
    throw new Error(
      `no credential: set AGENTORG_CREDENTIAL, or run \`agentorg core\`, which writes the root's to ${rootCredentialPath()}`,
    );
  }
  const url = coreUrl();
  const client = new Client({ name: "agentorg-cli", version: VERSION });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_PATH, url), {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      }),
    );
  } catch (error) {
    throw new Error(
      `the core at ${url} did not accept the connection: ${(error as Error).message}`,
    );
  }
  try {
    const wait = typeof request.wait === "number" ? request.wait : 0;
    const result = (await client.callTool({ name, arguments: request }, undefined, {
      timeout: (wait + 30) * 1000,
    })) as CallToolResult;
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (result.isError) {
      note(text);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}
