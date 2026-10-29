/** The web client's process, browser sign-in and user-service commands. */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { readCredential, rootCredentialPath } from "../../home.ts";
import { coreUrl } from "../../network/index.ts";
import { help } from "../../runtime/command.ts";
import { serviceCommand, serviceHelp } from "../../runtime/hosting.ts";
import { service } from "../../runtime/services.ts";
import { printReport, serviceStatus } from "../../runtime/status.ts";
import { DEFAULT_PORT, startWeb } from "./index.ts";

const PROGRAM = "agentorg-web";
const SERVICE = () => service(PROGRAM, "the web client");
const note = (text: string) => process.stderr.write(`${PROGRAM}: ${text}\n`);

function port(): number {
  return Number(process.env.AGENTORG_WEB_PORT || DEFAULT_PORT);
}

/** Where the web client serves: 127.0.0.1 at `AGENTORG_WEB_PORT`, else 8741. */
export const webUrl = () => `http://127.0.0.1:${port()}`;

function credential(): string {
  const found = readCredential();
  if (found === undefined) {
    throw new Error(`no root credential in AGENTORG_CREDENTIAL or ${rootCredentialPath()}`);
  }
  return found;
}

export const WEB_HELP = `usage: agentorg-web [--port <n>]
       agentorg-web open
       agentorg-web service install|uninstall
       agentorg-web status

Serve the web client on 127.0.0.1 at --port, else AGENTORG_WEB_PORT, else ${DEFAULT_PORT}. It connects to the core at AGENTORG_URL with AGENTORG_CREDENTIAL or the root's local credential. open signs a browser in. service manages only this web client's user service; status reports its availability.`;

export async function main(args: string[]): Promise<number> {
  const asked = args.includes("--help") || args.includes("-h");
  if (args[0] === "service") {
    return asked ? help(serviceHelp(PROGRAM)) : serviceCommand(SERVICE(), webUrl(), args.slice(1));
  }
  if (args[0] === "open") {
    if (asked) return help(OPEN_HELP);
    parseArgs({ args: args.slice(1), strict: true });
    return openCommand();
  }
  if (asked) return help(WEB_HELP);
  if (args[0] === "status") {
    parseArgs({ args: args.slice(1), strict: true });
    return printReport(await serviceStatus(SERVICE(), webUrl()));
  }
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  const human = await startWeb({
    coreUrl: coreUrl(),
    credential: credential(),
    port: values.port === undefined ? port() : Number(values.port),
  });
  note(`serving on ${human.url}, as the root of the core at ${coreUrl()}`);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await human.close();
  return 0;
}

export const OPEN_HELP = `usage: agentorg-web open

Mint a one-time link that signs a browser in to the web app the web client serves, and print it. In a terminal it also opens the link, with BROWSER or the system's opener. The link works once, for five minutes.`;

/**
 * Print a one-time link that signs a browser in to the web app, and open it when run in a terminal,
 * with `BROWSER` or the system's opener. Run from a script or a pipe, it only prints.
 */
export async function openCommand(): Promise<number> {
  const human = webUrl();
  const response = await fetch(`${human}/signin/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential()}` },
  }).catch(() => {
    throw new Error(`the web client is not running at ${human}; start it with agentorg-web`);
  });
  const body = (await response.json()) as { path: string; message?: string };
  if (!response.ok) throw new Error(`the web client refused: ${body.message}`);
  const url = human + body.path;
  process.stdout.write(`${url}\n`);
  if (!process.stdout.isTTY) return 0;
  const platform = process.platform;
  const opener =
    process.env.BROWSER ||
    (platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open");
  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  return 0;
}
