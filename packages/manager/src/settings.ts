/**
 * What an agent is run with, as `agent.settings@2` says it: the tree of what is mounted on it,
 * worked out from its record at each read, so nothing new is kept.
 *
 * - `instructions` and `skills` are management's own: the words it is told of itself, and the
 *   skills exposed to it. No caller mounts or unmounts them.
 * - `control`, while it holds an AgentOrg control unit, held by its executor.
 * - Each plugin of a capability a unit built for it, or its creatable gave it, held by its
 *   executor, under the plugin's own name.
 * - Each capability mounted on it through management, by the provider that made it.
 */
import type { SettingsRoot, SkillEntry } from "@agentorg/interfaces";
import type { z } from "zod";
import { AGENTS_UNIT } from "./control.js";
import type { AgentRecord } from "./stack.js";

type TheAgent = z.infer<typeof AgentRecord>;
type Root = z.infer<typeof SettingsRoot>;

/** The roots that are management's own: no caller mounts or unmounts them. */
export const OWN_ROOTS = ["instructions", "skills"];
/** The root an AgentOrg control unit gives its agent. */
export const CONTROL_ROOT = "control";

/**
 * The tree of what is mounted on an agent, in order: management's own roots, its control, its
 * capabilities' plugins, then what was mounted on it. `self` is management's own id, whose control
 * unit it looks for; `told` and `skills` are what management tells it of itself.
 */
export function treeOf(
  record: TheAgent,
  self: string,
  told: string,
  skills: z.infer<typeof SkillEntry>[],
): Root[] {
  const held = record.provider;
  const control = record.units.some((unit) => unit.provider === self && unit.unit === AGENTS_UNIT);
  return [
    { mounted: "instructions", capability: "instructions", arguments: { text: told } },
    { mounted: "skills", capability: "skills", arguments: { skills } },
    ...(control
      ? [{ mounted: CONTROL_ROOT, capability: CONTROL_ROOT, arguments: {}, provider: held }]
      : []),
    ...record.capabilities.flatMap(({ plugins = [] }) =>
      plugins.map(({ name, settings }) => ({
        mounted: name,
        capability: name,
        arguments: settings ?? {},
        provider: held,
      })),
    ),
    ...record.mounted.map(({ mounted, capability, arguments: given, provider }) => ({
      mounted,
      capability,
      arguments: given,
      provider,
    })),
  ];
}
