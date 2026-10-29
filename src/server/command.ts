/** The server process and its own user-service lifecycle. */

import { once } from "node:events";
import { parseArgs } from "node:util";
import { databasePath, ensureHome, rootCredentialPath } from "../home.ts";
import { coreUrl, DEFAULT_CORE_PORT } from "../network/index.ts";
import { help } from "../runtime/command.ts";
import { serviceCommand, serviceHelp } from "../runtime/hosting.ts";
import { service } from "../runtime/services.ts";
import { printReport, serviceStatus } from "../runtime/status.ts";

const PROGRAM = "agentorg-server";
const SERVICE = () => service(PROGRAM, "the core");
const HELP = `usage: agentorg-server [--port <n>]
       agentorg-server service install|uninstall
       agentorg-server status

Run the organization's core on 127.0.0.1 at --port, else AGENTORG_PORT, else ${DEFAULT_CORE_PORT}. Its records and root credential are in AGENTORG_HOME, default ~/.local/share/agentorg. The first start creates the root. A missing root credential file is replaced on startup.

service manages only the core's user service. status reports its executable, launcher, service and availability.`;

/** Suppress only Node 22's experimental SQLite notice while loading the store. */
async function storeModule() {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    const type = typeof options === "string" ? options : (options as { type?: string })?.type;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("../storage/sqlite/index.ts");
  } finally {
    process.emitWarning = emitWarning;
  }
}

export async function main(args: string[]): Promise<number> {
  const asked = args.includes("--help") || args.includes("-h");
  if (args[0] === "service") {
    return asked ? help(serviceHelp(PROGRAM)) : serviceCommand(SERVICE(), coreUrl(), args.slice(1));
  }
  if (asked) return help(HELP);
  if (args[0] === "status") {
    parseArgs({ args: args.slice(1), strict: true });
    return printReport(await serviceStatus(SERVICE(), coreUrl()));
  }
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  ensureHome();
  const { SqliteStore } = await storeModule();
  const { rootCredential, startCore } = await import("./index.ts");
  const store = new SqliteStore(databasePath());
  const core = await startCore(store, {
    port: Number(values.port ?? (process.env.AGENTORG_PORT || DEFAULT_CORE_PORT)),
    onError: (actor, error) =>
      process.stderr.write(
        `${PROGRAM}: the channel of ${actor} failed to start: ${error.message}\n`,
      ),
  });
  await rootCredential(core.organization.registry, rootCredentialPath());
  process.stderr.write(
    `${PROGRAM}: core serving on ${core.url}; the root's credential is in ${rootCredentialPath()}\n`,
  );
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await core.close();
  store.close();
  return 0;
}
