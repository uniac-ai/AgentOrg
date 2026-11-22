/**
 * An agent's settings as its engine reads them, from the tree `agent.settings@2` gives: its
 * instructions and skills from management's own roots, and as plugins each root this executor
 * holds, but `control`, which it doesn't carry. A root another provider made is that provider's to
 * hold. Gone once the engine holds the tree itself.
 */
import { type agentSettings, type agentSettings2, SkillEntry } from "@agentorg/interfaces";
import type { Slot } from "@agentorg/sdk";
import { z } from "zod";

type Tree = Awaited<ReturnType<Slot<typeof agentSettings2>["call"]["get"]>>["mounted"];
type Settings = Awaited<ReturnType<Slot<typeof agentSettings>["call"]["get"]>>;

/** The root an AgentOrg control unit gives, which this executor doesn't carry yet. */
const CONTROL = "control";
const Skills = z.array(SkillEntry).catch([]);

/** What the tree says, as the engine reads it; `self` is this executor's own id. */
export function settingsOf(tree: Tree, self: string): Settings {
  const own = (name: string) =>
    tree.find((root) => root.capability === name && root.provider === undefined)?.arguments ?? {};
  const { text } = own("instructions");
  return {
    instructions: typeof text === "string" ? text : "",
    skills: Skills.parse(own("skills").skills),
    plugins: tree
      .filter(({ provider, capability }) => provider === self && capability !== CONTROL)
      .map(({ capability, arguments: given }) => ({
        name: capability,
        ...(Object.keys(given).length > 0 ? { settings: given } : {}),
        capability,
      })),
  };
}

/** The agent's `settings` slot, at major 2, as its engine reads one: it reads the tree as `settingsOf` says. */
export function asSettings(
  slot: Slot<typeof agentSettings2>,
  self: string,
): Slot<typeof agentSettings> {
  return {
    get bound() {
      return slot.bound;
    },
    onBind: (fn) => slot.onBind(fn),
    onUnbind: (fn) => slot.onUnbind(fn),
    on: (event, fn) => slot.on(event, fn),
    call: {
      get: async () => settingsOf((await slot.call.get({})).mounted, self),
      skill: (input) => slot.call.skill(input),
    },
  };
}
