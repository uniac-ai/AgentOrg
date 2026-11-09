// The app's programs: ChatGPT, the agent provider, the MCP provider and management, each an Actor
// of its own that this process runs on its own channel, with its own private folder under the home.
// Every step reads what is there before it acts, so each start converges on the same system.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startManager } from "@agentorg/manager";
import { startMcpProvider } from "@agentorg/mcp";
import type { Log } from "@agentorg/sdk";
import { startAgentProvider } from "assistant/provider";
import { startChatGPT } from "chatgpt";
import type { PersonCalls } from "./model.js";

export interface ProgramsOptions {
  home: string;
  hubUrl: string;
  /** Where the first run says what it couldn't do. */
  log?: (message: string) => void;
  /** How ChatGPT's requests leave, instead of the network. For tests. */
  fetch?: (request: Request, init: RequestInit) => Promise<Response>;
}

export interface Programs {
  /** The Actors running now, by program. */
  chatgpt?: string;
  agents?: string;
  mcp?: string;
  management?: string;
  /** Leave the Hub, in the order that lets each finish. What each keeps stays. */
  close(): Promise<void>;
}

/** The Hub's exports each program holds. */
const hubBinding = (name: string) => ({ slot: name, provider: "hub", export: name });
interface Identity {
  actorId: string;
  credential: string;
}
type Actor = { actorId: string; state: string };
type Binding = { consumer: string; slot: string };

/**
 * Make what is missing and start each program. A program whose Actor exists keeps it and its
 * credential. A step that fails is logged, the programs that don't need it still start, and the
 * next start tries again.
 */
export async function startPrograms(
  person: PersonCalls,
  options: ProgramsOptions,
): Promise<Programs> {
  const log = options.log ?? (() => {});
  const { hubUrl } = options;
  const root = join(options.home, "programs");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const call = <T>(slot: string, method: string, input: unknown = {}) =>
    person.call(slot, method, input) as Promise<T>;
  const programLog: Log = {
    info() {},
    warn() {},
    error: (message) => log(message),
  };
  const dirOf = (name: string) => join(root, name);
  const identityFile = (name: string) => join(root, `${name}.identity`);

  /** The program's Actor: the one kept for it unless that is closed, or a new one. */
  const identity = async (
    name: string,
    title: string,
    bindings: { slot: string; provider: string; export: string }[],
  ): Promise<Identity> => {
    let kept: Identity | undefined;
    try {
      kept = JSON.parse(readFileSync(identityFile(name), "utf8")) as Identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (kept) {
      const { actors } = await call<{ actors: Actor[] }>("actors", "list");
      const { actorId } = kept;
      if (actors.some((actor) => actor.actorId === actorId && actor.state !== "closed"))
        return kept;
    }
    const made = await call<Identity>("actors", "create", { name: title, bindings });
    const file = identityFile(name);
    writeFileSync(`${file}.tmp`, JSON.stringify(made), { mode: 0o600, flush: true });
    renameSync(`${file}.tmp`, file);
    return made;
  };
  /** Bind the person's `slot` to `export` of `provider`, unless it is bound already. */
  const personSlot = async (slot: string, provider: string, exported: string) => {
    const { bindings } = await call<{ bindings: Binding[] }>("bindings", "list", {
      actor: "person",
    });
    if (bindings.some((binding) => binding.consumer === "person" && binding.slot === slot)) return;
    await call("grants", "bind", { consumer: "person", slot, provider, export: exported });
  };
  const closers: (() => Promise<void>)[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      log(
        `First run: ${what} didn't work: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  const chatgpt = await attempt("ChatGPT", async () => {
    const { actorId, credential } = await identity("chatgpt", "ChatGPT", []);
    const running = await startChatGPT({
      hubUrl,
      actorId,
      credential,
      dir: dirOf("chatgpt"),
      log: programLog,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    closers.unshift(() => running.close());
    await personSlot("login", actorId, "login");
    return actorId;
  });

  // Each agent's binding to the model comes from the provider's own, so ChatGPT goes first.
  const agents =
    chatgpt &&
    (await attempt("the agent provider", async () => {
      const { actorId, credential } = await identity("agents", "Agents", [
        hubBinding("actors"),
        { slot: "model", provider: chatgpt, export: "session" },
      ]);
      const running = await startAgentProvider({
        hubUrl,
        actorId,
        credential,
        model: { actor: chatgpt, export: "session" },
        dir: dirOf("agents"),
        log: programLog,
      });
      closers.unshift(() => running.close());
      return actorId;
    }));

  const mcp = await attempt("the MCP provider", async () => {
    const { actorId, credential } = await identity("mcp", "MCP", [hubBinding("actors")]);
    const running = await startMcpProvider({
      hubUrl,
      actorId,
      credential,
      dir: dirOf("mcp"),
      log: programLog,
    });
    closers.unshift(() => running.close());
    return actorId;
  });

  const management = await attempt("management", async () => {
    const { actorId, credential } = await identity("management", "Management", [
      hubBinding("actors"),
      hubBinding("grants"),
      hubBinding("bindings"),
    ]);
    // Management outlasts the providers at the end and is up before they're connected to it.
    const running = await startManager({
      hubUrl,
      actorId,
      credential,
      dir: dirOf("management"),
      log: programLog,
    });
    closers.push(() => running.close());
    for (const [slot, exported] of [
      ["agents", "agents"],
      ["connections", "connections"],
      ["skills", "skills"],
    ] as const)
      await personSlot(slot, actorId, exported);
    return actorId;
  });

  if (management)
    for (const provider of [agents, mcp])
      if (provider)
        await attempt("connecting a provider to management", () =>
          call("grants", "expose", { provider, export: "provider", to: management }),
        );

  return {
    ...(chatgpt ? { chatgpt } : {}),
    ...(agents ? { agents } : {}),
    ...(mcp ? { mcp } : {}),
    ...(management ? { management } : {}),
    async close() {
      for (const close of closers)
        await close().catch((error: unknown) => log(`A program didn't stop: ${String(error)}`));
    },
  };
}
