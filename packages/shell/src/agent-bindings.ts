/**
 * What a new agent gets: the assistant package's slots, each bound at creation (step 5, §4). The
 * slots are its `logic` module's; `model` and `store` it always gets, and the person decides the
 * rest in New agent's dialog.
 */
export const AGENT_GRANTS = [
  { slot: "model", what: "ChatGPT", iface: "llm.session@1", fixed: true },
  { slot: "store", what: "its own storage", iface: "kv@1", fixed: true },
  { slot: "layout", what: "your home", iface: "layout@1", fixed: false },
  { slot: "packages", what: "install packages", iface: "hub.packages@1", fixed: false },
  { slot: "actors", what: "create and run Actors", iface: "hub.actors@1", fixed: false },
  { slot: "grants", what: "ask for connections", iface: "hub.grants@1", fixed: false },
  { slot: "exports", what: "see what's offered", iface: "hub.exports@1", fixed: false },
] as const;

export type AgentSlot = (typeof AGENT_GRANTS)[number]["slot"];

/** The package New agent creates from, and the model's, found by name in `packages.list`. */
export const ASSISTANT = "assistant";
export const CHATGPT = "chatgpt";

/** Where each slot is served: the chatgpt Actor's session, the built-ins, the person's layout. */
const PROVIDERS: Record<AgentSlot, (chatgpt: string) => { provider: string; export: string }> = {
  model: (chatgpt) => ({ provider: chatgpt, export: "model.session" }),
  store: () => ({ provider: "storage", export: "kv" }),
  layout: () => ({ provider: "person", export: "layout" }),
  packages: () => ({ provider: "hub", export: "packages" }),
  actors: () => ({ provider: "hub", export: "actors" }),
  grants: () => ({ provider: "hub", export: "grants" }),
  exports: () => ({ provider: "hub", export: "exports" }),
};

/**
 * A new agent's bindings for `hub.actors.create`: every grant but the ones switched off, which
 * can't be `model` or `store`. `chatgpt` is the chatgpt Actor's id.
 */
export function agentBindings(
  chatgpt: string,
  off: ReadonlySet<string> = new Set(),
): { slot: string; provider: string; export: string }[] {
  return AGENT_GRANTS.filter((grant) => grant.fixed || !off.has(grant.slot)).map((grant) => ({
    slot: `logic.${grant.slot}`,
    ...PROVIDERS[grant.slot](chatgpt),
  }));
}
