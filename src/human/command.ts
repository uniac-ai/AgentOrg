/**
 * The human actor's commands: `agentorg human` runs it, and `agentorg ui` signs a browser in to the
 * web app it serves. Both find the root credential in `AGENTORG_CREDENTIAL`, else in the agentorg
 * home's credential file, which `agentorg core` creates.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { readCredential, rootCredentialPath } from "../home.ts";
import { coreUrl } from "../network/index.ts";
import { DEFAULT_PORT, startHuman } from "./index.ts";

const note = (text: string) => process.stderr.write(`agentorg: ${text}\n`);

function port(): number {
  return Number(process.env.AGENTORG_HUMAN_PORT || DEFAULT_PORT);
}

function credential(): string {
  const found = readCredential();
  if (found === undefined) {
    throw new Error(`no root credential in AGENTORG_CREDENTIAL or ${rootCredentialPath()}`);
  }
  return found;
}

export const HUMAN_HELP = `usage: agentorg human [--port <n>]

Run the human actor, the user's side of the organization, on 127.0.0.1 at --port, else AGENTORG_HUMAN_PORT, else ${DEFAULT_PORT}. It connects to the core at AGENTORG_URL with the root credential from AGENTORG_CREDENTIAL or the agentorg home, and serves the web app. It logs to stderr and stops on SIGINT or SIGTERM.`;

export async function humanCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  const human = await startHuman({
    coreUrl: coreUrl(),
    credential: credential(),
    port: values.port === undefined ? port() : Number(values.port),
  });
  note(`serving on ${human.url}, as the root of the core at ${coreUrl()}`);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await human.close();
  return 0;
}

export const UI_HELP = `usage: agentorg ui

Mint a one-time link that signs a browser in to the web app the human actor serves, and print it. In a terminal it also opens the link, with BROWSER or the system's opener. The link works once, for five minutes.`;

/**
 * Print a one-time link that signs a browser in to the web app, and open it when run in a terminal,
 * with `BROWSER` or the system's opener. Run from a script or a pipe, it only prints.
 */
export async function uiCommand(): Promise<number> {
  const human = `http://127.0.0.1:${port()}`;
  const response = await fetch(`${human}/signin/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential()}` },
  }).catch(() => {
    throw new Error(`the human actor is not running at ${human}; start it with agentorg human`);
  });
  const body = (await response.json()) as { path: string; message?: string };
  if (!response.ok) throw new Error(`the human actor refused: ${body.message}`);
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
