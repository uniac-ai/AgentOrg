/** The MCP adapter's stdio process, client hooks and project integration commands. */

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { presentOverStdio } from "../../actor/index.ts";
import { coreUrl } from "../../network/index.ts";
import { help } from "../../runtime/command.ts";
import { Agent } from "./agent.ts";
import { sessionName, sessions } from "./sessions.ts";
import { CONNECT_HELP, STATUS_HELP, setupCommand } from "./setup.ts";
import { waitForNews } from "./waiter.ts";

interface Client {
  /** The client's id for the session, which the agent actor and the waiter both see. */
  session(input?: string): string | undefined;
  /**
   * The words the user typed, from a prompt hook's input; undefined for input the client delivered
   * instead, such as a waiter's output or another session's message.
   */
  typed?(input: string): string | undefined;
  /** For a client whose hooks run the waiter. */
  waiter?: {
    /** True while the session's client process runs. */
    alive(): boolean;
    /**
     * False when the session takes no later input, so nothing the waiter writes could reach it; the
     * waiter then ends at once rather than hold the client open.
     */
    takesInput(): boolean;
    /** The exit status that hands the waiter's output to the session as input. */
    wake: number;
  };
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const claudePid = () => Number(process.env.CLAUDE_PID) || process.ppid;

/** A process's command line, or undefined where `ps` cannot tell. */
function commandLine(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code, run with this command line, takes input after its first prompt. In print
 * mode (`-p`) with its prompt as an argument it takes none, and it runs its hooks to completion
 * before exiting, so a waiter there would hold it open for good. Interactive sessions, and print
 * mode reading stream-json input, as the desktop app's sessions do, take more.
 */
export function claudeTakesInput(line: string): boolean {
  const args = line.trim().split(/\s+/);
  const printing = args.includes("-p") || args.includes("--print");
  return !printing || /--input-format(=|\s+)stream-json\b/.test(line);
}

/** Client-delivered input comes wrapped in an element, such as `<task-notification>…`. */
const WRAPPED = /^\s*<([A-Za-z][\w-]*)[\s>][\s\S]*<\/\1>/;

function hookInput(input: string): { session_id?: unknown; prompt?: unknown } {
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {}
  throw new Error("client hook input must be a JSON object");
}

function typed(input: string): string | undefined {
  const { prompt } = hookInput(input);
  return typeof prompt === "string" && !WRAPPED.test(prompt) ? prompt : undefined;
}

const CLIENTS: Record<string, Client> = {
  "claude-code": {
    session: () => process.env.CLAUDE_CODE_SESSION_ID,
    typed,
    waiter: {
      alive: () => running(claudePid()),
      takesInput: () => claudeTakesInput(commandLine(claudePid()) ?? ""),
      wake: 2,
    },
  },
  codex: {
    session(input) {
      if (input === undefined || input === "") return undefined;
      const { session_id } = hookInput(input);
      return typeof session_id === "string" ? session_id : undefined;
    },
    typed,
  },
};

function client(args: string[]): { name: string; client: Client; rest: string[] } {
  const { values, positionals } = parseArgs({
    args,
    options: { client: { type: "string", default: "claude-code" } },
    allowPositionals: true,
    strict: true,
  });
  const name = values.client;
  const found = Object.hasOwn(CLIENTS, name) ? CLIENTS[name] : undefined;
  if (found === undefined) {
    throw new Error(`unknown client ${name}; known: ${Object.keys(CLIENTS).join(", ")}`);
  }
  return { name, client: found, rest: positionals };
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let read = "";
  for await (const chunk of stream) read += chunk;
  return read;
}

const sessionOf = (name: string, client: Client, input?: string) =>
  sessionName(name, client.session(input));

/** What a session that fills no position reads before its first turn. */
export const ATTACH_FIRST =
  "agentorg: This session can fill a position in an AgentOrg organization. Load the agentorg skill, then attach with `attach` before any other action.";

export const MCP_HELP = `usage: agentorg-mcp [context|prompt|wait] [--client claude-code|codex]
       agentorg-mcp connect|disconnect <claude-code|codex> [--project <dir>]
       agentorg-mcp status [--project <dir>]

Present attach, interfaces and call over stdio, connected to AGENTORG_URL. Listing and invocation require attachment; interfaces reads the actor's permitted operations and call invokes one.
Client hooks: context emits an attachment hint; prompt keeps typed input; wait delivers pending input on stderr with the client's wake status.`;

export async function mcpCommand(args: string[]): Promise<number> {
  const command = args[0];
  const asked = args.includes("--help") || args.includes("-h");
  if (command === "connect" || command === "disconnect" || command === "status") {
    return asked
      ? help(command === "status" ? STATUS_HELP : CONNECT_HELP)
      : setupCommand(command, args.slice(1));
  }
  if (asked) return help(MCP_HELP);
  const { name, client: chosen, rest } = client(args);
  const input =
    rest[0] === "prompt" || (name === "codex" && ["context", "wait"].includes(rest[0] ?? ""))
      ? await text(process.stdin)
      : undefined;
  const session = sessionOf(name, chosen, input);
  if (rest[0] === "context") {
    if (session === undefined || sessions.position(session) === undefined) {
      process.stdout.write(`${ATTACH_FIRST}\n`);
    }
    return 0;
  }
  if (rest[0] === "prompt") {
    const typed = chosen.typed?.(input ?? "");
    if (session !== undefined && typed !== undefined && sessions.position(session) !== undefined) {
      sessions.keepTyped(session, typed);
    }
    return 0;
  }
  if (rest[0] === "wait") {
    const waiter = chosen.waiter;
    if (waiter === undefined || session === undefined || !waiter.takesInput()) return 0;
    const delivered = await waitForNews({
      coreUrl: coreUrl(),
      session,
      alive: waiter.alive,
      write: (text) => process.stderr.write(`${text}\n`),
    });
    return delivered ? waiter.wake : 0;
  }
  if (rest.length > 0) throw new Error(`unknown agent command ${rest.join(" ")}`);
  const agent = new Agent({
    coreUrl: coreUrl(),
    session,
    ...(name === "codex" ? { client: name } : {}),
  });
  const server = await presentOverStdio(agent);
  void agent.resume();
  await Promise.race([
    once(process.stdin, "close"),
    once(process, "SIGINT"),
    once(process, "SIGTERM"),
  ]);
  await server.close();
  await agent.close();
  return 0;
}
