/**
 * The agent actor's commands. `agentorg agent` is the MCP server a client starts for each session
 * over stdio. The client's hooks start the other two: `agentorg agent context`, whose output the
 * session reads before its first turn, and `agentorg agent wait`, the waiter. What differs between
 * clients is how they name the session, how a waiter tells that the session still runs, and the
 * exit status with which a waiter's output wakes the session; `CLIENTS` holds it.
 */

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
  /** For a client whose hooks run the waiter. */
  waiter?: {
    /** True while the session's client process runs. */
    alive(): boolean;
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

const CLIENTS: Record<string, Client> = {
  "claude-code": {
    session: () => process.env.CLAUDE_CODE_SESSION_ID,
    waiter: { alive: () => running(Number(process.env.CLAUDE_PID) || process.ppid), wake: 2 },
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

const sessionOf = (name: string, client: Client) => {
  const id = client.session();
  return id === undefined ? undefined : `${name}-${id}`;
};

/** What a session that fills no position reads before its first turn. */
export const ATTACH_FIRST = "agentorg: Attach with `attach` before any other action.";

export const AGENT_HELP = `usage: agentorg agent [--client claude-code|codex]
       agentorg agent context [--client claude-code]
       agentorg agent wait [--client claude-code]

Run the agent actor, which lets a client's session fill a position: the MCP server the client starts over stdio for each session, connected to the core at AGENTORG_URL. Until the session attaches, it offers attach; then the position's interfaces. It keeps the credentials of positions the session creates in the agentorg home, and remembers which position the session fills, so a resumed session fills it again.

context prints, for a session that fills no position yet, the line telling it to attach first, and nothing for one that does. The client's session-start hook runs it.

wait is the waiter the client's hooks run: it waits for messages to the session's position, writes them on stderr and exits with the status that hands them to the session as input. It exits 0 with nothing to deliver.`;

export async function agentCommand(args: string[]): Promise<number> {
  const { name, client: chosen, rest } = client(args);
  const session = sessionOf(name, chosen);
  if (rest[0] === "context") {
    if (session === undefined || sessions.position(session) === undefined) {
      process.stdout.write(`${ATTACH_FIRST}\n`);
    }
    return 0;
  }
  if (rest[0] === "wait") {
    const waiter = chosen.waiter;
    if (waiter === undefined || session === undefined) return 0;
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
