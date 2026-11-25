// The app's programs: ChatGPT, the agent provider, the MCP provider, the computer connector and management, each an Actor
// of its own that this process runs on its own channel, with its own private folder under the home.
// Every step reads what is there before it acts, so each start converges on the same system.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startComputerProvider } from "@agentorg/computer-connector";
import { HubState, PERSON } from "@agentorg/hub";
import type { CapabilityDefinition } from "@agentorg/interfaces";
import { type ManagerOptions, startManager } from "@agentorg/manager";
import { startMcpProvider } from "@agentorg/mcp";
import { memory } from "@agentorg/memory";
import type { Log } from "@agentorg/sdk";
import type { AgentPlugin } from "assistant/plugins";
import { startAgentProvider } from "assistant/provider";
import { startChatGPT } from "chatgpt";
import type { z } from "zod";
import type { PersonCalls } from "./oauth.js";

export interface ProgramsOptions {
  home: string;
  hubUrl: string;
  /** Where the first run says what it couldn't do. */
  log?: (message: string) => void;
  /** How ChatGPT's requests leave, instead of the network. For tests. */
  fetch?: (request: Request, init: RequestInit) => Promise<Response>;
  /**
   * Where the computer connector looks for a local service and for `agentcomputer` to start one,
   * the web unit's server, and agents' folders, and how long it waits between looks for a computer
   * here. For tests.
   */
  computer?: {
    dataFolder?: string;
    webUrl?: string;
    agentsFolder?: string;
    path?: string;
    macRecord?: string | null;
    /** A provider that makes computers is there: the Computer unit asks which. */
    makes?: boolean;
  };
  /**
   * Whether a home with no agents gets the first Assistant, once AgentOrg Mac is there. Off by
   * default: the `agentorg` command turns it on.
   */
  assistant?: boolean;
  /**
   * Capabilities the agents' executor carries and offers beside memory and control, each a plugin
   * with its definition, whose id is the plugin's name. For tests.
   */
  carried?: { plugin: AgentPlugin; offer: z.infer<typeof CapabilityDefinition> }[];
}

/**
 * Memory, as the agents' executor offers it through `capability.provider@1`: a person, an agent
 * or another program mounts it through management. It takes no arguments.
 */
export const MEMORY = {
  id: "memory",
  title: "Memory",
  description: "It remembers what you tell it to, across its conversations.",
  arguments: { type: "object" as const, properties: {}, additionalProperties: false },
};
/**
 * Control, as the agents' executor offers it: what lets an agent mount and unmount capabilities on
 * itself and on the agents it made. An AgentOrg control unit gives it too. It takes no arguments.
 */
export const CONTROL = {
  id: "control",
  title: "Control",
  description: "It mounts and unmounts capabilities on the agent itself and on the agents it made.",
  arguments: { type: "object" as const, properties: {}, additionalProperties: false },
};

export interface Programs {
  /** The Actors running now, by program. */
  chatgpt?: string;
  agents?: string;
  mcp?: string;
  computer?: string;
  management?: string;
  /** Leave the Hub, in the order that lets each finish. What each keeps stays. */
  close(): Promise<void>;
}

/**
 * Close every Actor that runs a package, as an earlier release's do: the programs replace them.
 * Before the Hub opens. Each stays listed as closed; the files it left in the home stay too, unread.
 */
export function closePackageActors(home: string) {
  if (!existsSync(join(home, "hub.db"))) return;
  const state = HubState.open(home);
  try {
    for (const { actorId, package: from, state: now } of state.actors())
      if (now !== "closed" && from !== "external" && from !== "builtin")
        state.closeActor(PERSON, actorId);
  } finally {
    state.close();
  }
}

/** The bundled Assistant: the base, the computer the person has, and the web. */
const ASSISTANT_TEMPLATE: NonNullable<ManagerOptions["templates"]>[number] = {
  id: "assistant",
  title: "Assistant",
  description: "Works on a computer and on the web.",
  base: { provider: "AgentOrg", creatable: "assistant" },
  units: [
    { provider: "Computers", unit: "computer", values: { access: "terminal" } },
    { provider: "Computers", unit: "web", values: { service: "exa" } },
  ],
};

/** The Assistant made at a home's first start, and what its file under `programs` keeps. */
const FIRST_ASSISTANT = "Assistant";
const MADE_FILE = "assistant.json";
/** The parts of this machine the first Assistant uses, switched on in AgentOrg Mac once. */
const FIRST_PARTS = ["terminal", "files", "screen"];
/**
 * What the first Assistant's AgentOrg control unit lets it do: make and manage its own agents from
 * the Assistant template, on its own computer, with commands, and no browser of their own.
 */
export const FIRST_CONTROL = {
  agents: "own",
  templates: ["assistant"],
  places: ["own"],
  access: "terminal",
  browser: false,
};

/**
 * The Assistant as capabilities, which `agents@2` offers as one: a computer the person has, the
 * web, memory, and control with what the first Assistant's control unit lets it do.
 */
const ASSISTANT: NonNullable<ManagerOptions["capabilityTemplates"]>[number] = {
  id: "assistant",
  title: "Assistant",
  description: "Works on a computer and on the web, remembers, and makes agents of its own.",
  capabilities: [
    { provider: "Computers", capability: "computer", arguments: { access: "terminal" } },
    { provider: "Computers", capability: "web", arguments: { service: "exa" } },
    { provider: "AgentOrg", capability: "memory", arguments: {} },
    { provider: "AgentOrg", capability: "control", arguments: FIRST_CONTROL },
  ],
};

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
      const { actorId, credential } = await identity("agents", "AgentOrg", [
        hubBinding("actors"),
        { slot: "model", provider: chatgpt, export: "session" },
      ]);
      const running = await startAgentProvider({
        hubUrl,
        actorId,
        credential,
        model: { actor: chatgpt, export: "session" },
        dir: dirOf("agents"),
        // The plugins an agent's capabilities may name: each loaded only in an agent that holds it.
        plugins: [memory, ...(options.carried ?? []).map(({ plugin }) => plugin)],
        // What it offers to be mounted on its agents, each by the plugin's own name.
        offers: [MEMORY, CONTROL, ...(options.carried ?? []).map(({ offer }) => offer)],
        log: programLog,
      });
      closers.unshift(() => running.close());
      return actorId;
    }));

  const mcp = await attempt("the MCP provider", async () => {
    const { actorId, credential } = await identity("mcp", "Local", [hubBinding("actors")]);
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

  let computerProvider: Awaited<ReturnType<typeof startComputerProvider>> | undefined;
  const computer = await attempt("the computer connector", async () => {
    const { actorId, credential } = await identity("computer", "Computers", [hubBinding("actors")]);
    const running = await startComputerProvider({
      hubUrl,
      actorId,
      credential,
      dir: dirOf("computer"),
      log: programLog,
      ...options.computer,
    });
    computerProvider = running;
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
      templates: [ASSISTANT_TEMPLATE],
      capabilityTemplates: [ASSISTANT],
    });
    closers.push(() => running.close());
    for (const [slot, exported] of [
      ["agents", "agents"],
      ["connections", "connections"],
      ["skills", "skills"],
    ] as const)
      await personSlot(slot, actorId, exported);
    // Its agents@2, exposed to the person beside agents@1 until the page moves to it.
    await call("grants", "expose", {
      provider: actorId,
      export: "agents2",
      to: "person",
      as: "agents2",
    });
    return actorId;
  });

  if (management) {
    for (const provider of [agents, mcp, computer])
      if (provider)
        await attempt("connecting a provider to management", () =>
          call("grants", "expose", { provider, export: "provider", to: management }),
        );
    // The agents' executor, the computer connector and the MCP provider make capabilities too:
    // management mounts them through each.
    for (const provider of [agents, computer, mcp])
      if (provider)
        await attempt("connecting a provider's capabilities to management", () =>
          call("grants", "expose", { provider, export: "capabilities", to: management }),
        );
  }

  /**
   * The first Assistant, on a home with no agents: once AgentOrg Mac's service answers, its parts
   * are switched on, once, and one agent is made with its computer, the screen when it can be
   * had, the web, its own agents, and memory. The file under `programs` says how far it got, so
   * a start that didn't finish goes on from there without switching anything again. A home that
   * has agents, or gets one while the app waits, gets none.
   */
  const made = join(root, MADE_FILE);
  const kept = (() => {
    try {
      return JSON.parse(readFileSync(made, "utf8")) as { switched?: true; made?: boolean };
    } catch {
      return {};
    }
  })();
  const mark = (what: { switched?: true; made?: boolean; agent?: string }) => {
    writeFileSync(`${made}.tmp`, JSON.stringify({ ...what, at: new Date().toISOString() }), {
      mode: 0o600,
      flush: true,
    });
    renameSync(`${made}.tmp`, made);
  };
  const stopAssisting = new AbortController();
  const firstAssistant = async () => {
    if (!options.assistant || kept.made !== undefined) return;
    if (!agents || !computer || !management || !computerProvider) return;
    const someThere = async () =>
      (await call<{ agents: unknown[] }>("agents", "list")).agents.length > 0;
    const none = () => mark({ ...kept, made: false });
    if (await someThere()) return none();
    if (!(await computerProvider.macService(stopAssisting.signal))) return;
    // The person may have made one while the app waited.
    if (await someThere()) return none();
    if (!kept.switched) {
      for (const part of await computerProvider.switchOn(FIRST_PARTS))
        log(
          `First run: this Mac's ${part} couldn't be switched on in AgentOrg; switch it on there.`,
        );
      mark({ switched: true });
    }
    if (stopAssisting.signal.aborted) return;
    type Option = { value: unknown; unavailable?: string };
    const { units } = await call<{
      units: { id: string; provider: string; form: { id: string; options?: Option[] }[] }[];
    }>("agents", "units");
    const form = units.find((one) => one.id === "computer" && one.provider === computer)?.form;
    const why = (field: string, value: string) => {
      const option = form
        ?.find((one) => one.id === field)
        ?.options?.find((one) => one.value === value);
      return option ? option.unavailable : `It has no ${field} ${value}.`;
    };
    const noScreen = why("screen", "on");
    const stack = {
      base: { provider: agents, creatable: "assistant" },
      template: "assistant",
      units: [
        {
          provider: computer,
          unit: "computer",
          values: { access: "terminal", screen: noScreen ? "off" : "on", ownBrowser: "none" },
        },
        { provider: computer, unit: "web", values: { service: "exa" } },
        { provider: management, unit: "control", values: FIRST_CONTROL },
        // Management's Memory unit asks nothing: it is named with no values.
        { provider: management, unit: "memory" },
      ],
    };
    // Why this computer can't be had now, if it can't: its unit's check says.
    const { problems } = await call<{ problems: { unit?: number; message: string }[] }>(
      "agents",
      "check",
      { stack },
    );
    const notHere = problems.find((one) => one.unit === 0)?.message;
    if (notHere) return log(`First run: the Assistant isn't made yet: ${notHere}`);
    const { agent } = await call<{ agent: string }>("agents", "create", {
      stack,
      name: FIRST_ASSISTANT,
    });
    mark({ switched: true, made: true, agent });
    if (noScreen) log(`First run: the Assistant was made without the screen: ${noScreen}`);
  };
  const assisting = firstAssistant().catch((error: unknown) => {
    if (!stopAssisting.signal.aborted)
      log(
        `First run: the Assistant couldn't be made: ${error instanceof Error ? error.message : String(error)}`,
      );
  });

  return {
    ...(chatgpt ? { chatgpt } : {}),
    ...(agents ? { agents } : {}),
    ...(mcp ? { mcp } : {}),
    ...(computer ? { computer } : {}),
    ...(management ? { management } : {}),
    async close() {
      // The first Assistant's wait ends, and a creation under way finishes, before anything closes.
      stopAssisting.abort();
      await assisting;
      for (const close of closers)
        await close().catch((error: unknown) => log(`A program didn't stop: ${String(error)}`));
    },
  };
}
