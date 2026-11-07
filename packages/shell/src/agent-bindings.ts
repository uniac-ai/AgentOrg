/**
 * What a new agent gets: the assistant package's slots, each bound at creation (step 5, §4). The
 * slots are its `logic` module's; `model` and `store` it always gets, and the person decides the
 * rest in New agent's dialog. A grant that `needs` another is off while that one is: installing
 * creates and starts Actors.
 */
export const AGENT_GRANTS = [
  { slot: "model", what: "ChatGPT", iface: "llm.session@1", fixed: true },
  { slot: "store", what: "its own storage", iface: "kv@1", fixed: true },
  { slot: "layout", what: "your home", iface: "layout@1", fixed: false },
  { slot: "packages", what: "install packages", iface: "hub.packages@1", fixed: false },
  { slot: "actors", what: "create and run Actors", iface: "hub.actors@1", fixed: false },
  { slot: "grants", what: "ask for connections", iface: "hub.grants@1", fixed: false },
  { slot: "exports", what: "see what's offered", iface: "hub.exports@1", fixed: false },
  {
    slot: "installer",
    what: "install Actors",
    iface: "installer@1",
    fixed: false,
    needs: "actors",
  },
] as const;

export type AgentSlot = (typeof AGENT_GRANTS)[number]["slot"];

/**
 * Where the app's first run records what it made, in the person's store: its `assistant` is the
 * package New agent installs, by hash, never a package found by its name.
 */
export const FIRST_RUN = "app/first-run";

/**
 * The Actors a new agent's slots reach beside the built-ins: the person's own ChatGPT (what its
 * `login` is bound to) and installer (what its `installer` is bound to).
 */
export interface AgentProviders {
  chatgpt: string;
  installer: string;
}

/** Where each slot is served: ChatGPT's session, the installer, the built-ins, the person's layout. */
const PROVIDERS: Record<AgentSlot, (ids: AgentProviders) => { provider: string; export: string }> =
  {
    model: (ids) => ({ provider: ids.chatgpt, export: "model.session" }),
    store: () => ({ provider: "storage", export: "kv" }),
    layout: () => ({ provider: "person", export: "layout" }),
    packages: () => ({ provider: "hub", export: "packages" }),
    actors: () => ({ provider: "hub", export: "actors" }),
    grants: () => ({ provider: "hub", export: "grants" }),
    exports: () => ({ provider: "hub", export: "exports" }),
    installer: (ids) => ({ provider: ids.installer, export: "installer.installer" }),
  };

/**
 * A new agent's connections for `installer.install`: every grant but the ones switched off, which
 * can't be `model` or `store`.
 */
export function agentConnections(
  ids: AgentProviders,
  off: ReadonlySet<string> = new Set(),
): Record<string, { actor: string; export: string }> {
  return Object.fromEntries(
    AGENT_GRANTS.filter((grant) => grant.fixed || !off.has(grant.slot)).map((grant) => {
      const { provider, export: name } = PROVIDERS[grant.slot](ids);
      return [`logic.${grant.slot}`, { actor: provider, export: name }];
    }),
  );
}

type Call = (slot: string, method: string, input: unknown) => Promise<unknown>;

/**
 * The person's ChatGPT and installer: the Actors the person's `login` and `installer` are bound to,
 * as the app's first run binds them (never an Actor found by its package's name).
 */
export async function agentProviders(call: Call): Promise<AgentProviders> {
  const { bindings } = (await call("bindings", "list", { actor: "person" })) as {
    bindings: { consumer: string; slot: string; provider: string }[];
  };
  const of = (slot: string) =>
    bindings.find((b) => b.consumer === "person" && b.slot === slot)?.provider;
  const chatgpt = of("login");
  const installer = of("installer");
  // Both are bound by the app's first run at its start; one that didn't finish tries again then.
  if (!chatgpt || !installer)
    throw new Error("AgentOrg isn't set up yet. Restart it to finish setting up.");
  return { chatgpt, installer };
}

/**
 * New agent itself: install the assistant package `assistant` named `name` through the person's
 * `installer`, with `agentConnections` to the person's own ChatGPT and installer, and start it, all
 * or nothing. `call` is the person's call (the shell's `/api`, or a test's). Returns the installer's
 * answer: its id, the slots left unbound (the switched-off ones among them) and the seeds that
 * didn't land.
 */
export async function installAgent(
  call: Call,
  agent: { assistant: string; name: string; off?: ReadonlySet<string> },
): Promise<{ actorId: string; unbound: string[]; unseeded: string[] }> {
  return (await call("installer", "install", {
    package: agent.assistant,
    name: agent.name,
    connections: agentConnections(await agentProviders(call), agent.off),
    start: true,
  })) as { actorId: string; unbound: string[]; unseeded: string[] };
}
