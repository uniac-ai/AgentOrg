/** The commands that run a process: the core. */

import { once } from "node:events";
import { parseArgs } from "node:util";
import { databasePath, ensureHome, rootCredentialPath } from "../home.ts";
import { DEFAULT_CORE_PORT } from "../protocol/index.ts";

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
