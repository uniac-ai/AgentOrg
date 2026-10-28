/**
 * The agent actor's commands. `agentorg agent` is the MCP server a client starts for each session
 * over stdio. The client's hooks start the others: `agentorg agent context`, whose output the
 * session reads before its first turn, `agentorg agent prompt`, which keeps what the user types,
 * and `agentorg agent wait`, the waiter. What differs between clients is how they name the session,
 * how they hand a hook what the user typed, how a waiter tells that the session still runs, and the
 * exit status with which a waiter's output wakes the session; `CLIENTS` holds it.
 */

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { presentOverStdio } from "../actor/index.ts";
import { coreUrl } from "../network/index.ts";
import { Agent } from "./agent.ts";
import { sessions } from "./sessions.ts";
import { waitForNews } from "./waiter.ts";

interface Client {
  /** The client's id for the session, which the agent actor and the waiter both see. */
  session(): string | undefined;
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

/** Input Claude Code delivers comes wrapped in an element, such as `<task-notification>…`. */
const WRAPPED = /^\s*<([A-Za-z][\w-]*)[\s>][\s\S]*<\/\1>/;

const CLIENTS: Record<string, Client> = {
  "claude-code": {
    session: () => process.env.CLAUDE_CODE_SESSION_ID,
    typed(input) {
      const { prompt } = JSON.parse(input) as { prompt?: unknown };
      return typeof prompt === "string" && !WRAPPED.test(prompt) ? prompt : undefined;
    },
    waiter: {
      alive: () => running(claudePid()),
      takesInput: () => claudeTakesInput(commandLine(claudePid()) ?? ""),
      wake: 2,
    },
  },
  codex: { session: () => undefined },
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

const sessionOf = (name: string, client: Client) => {
  const id = client.session();
  return id === undefined ? undefined : `${name}-${id}`;
};

/** What a session that fills no position reads before its first turn. */
export const ATTACH_FIRST = "agentorg: Attach with `attach` before any other action.";

export const AGENT_HELP = `usage: agentorg agent [--client claude-code|codex]
       agentorg agent context [--client claude-code]
       agentorg agent prompt [--client claude-code]
       agentorg agent wait [--client claude-code]

Run the agent actor, which lets a client's session fill a position: the MCP server the client starts over stdio for each session, connected to the core at AGENTORG_URL. Until the session attaches, it offers attach; then the position's interfaces. It keeps the credentials of positions the session creates in the agentorg home, and remembers which position the session fills, so a resumed session fills it again.

context prints, for a session that fills no position yet, the line telling it to attach first, and nothing for one that does. The client's session-start hook runs it.

prompt reads the client's prompt hook input on stdin and, for a session that fills a position, keeps what the user typed, so that the session can record it as the user's answer to its question. It keeps nothing the client delivered instead.

wait is the waiter the client's hooks run: it waits for messages to the session's position, writes them on stderr and exits with the status that hands them to the session as input. It exits 0 with nothing to deliver, and at once for a session that takes no later input, such as Claude Code's print mode with its prompt as an argument.`;

export async function agentCommand(args: string[]): Promise<number> {
  const { name, client: chosen, rest } = client(args);
  const session = sessionOf(name, chosen);
  if (rest[0] === "context") {
    if (session === undefined || sessions.position(session) === undefined) {
      process.stdout.write(`${ATTACH_FIRST}\n`);
    }
    return 0;
  }
  if (rest[0] === "prompt") {
    const input = await text(process.stdin);
    const typed = chosen.typed?.(input);
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
  const agent = new Agent({ coreUrl: coreUrl(), session });
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
