/**
 * What an agent is run with, as its provider is given it in `agent.provider@2`'s `mounted`: the
 * tree of what is mounted on it, worked out from its record each time, so nothing new is kept.
 *
 * - `instructions` and `skills` are management's own: the words it is told of itself, and the
 *   skills exposed to it, each with what its `ALWAYS.md` says. No caller mounts or unmounts them.
 * - `offered`, management's own too, while it holds control: the text of what it can mount.
 * - `control`, while it holds an AgentOrg control unit, held by its executor.
 * - Each plugin of a capability a unit built for it, or its creatable gave it, held by its
 *   executor, under the plugin's own name.
 * - Each capability mounted on it through management, by the provider that made it.
 */
import { type SettingsRoot, type SkillEntry, SkillName, SkillPath } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { z } from "zod";
import { AGENTS_UNIT } from "./control.js";
import type { AgentRecord } from "./stack.js";

type TheAgent = z.infer<typeof AgentRecord>;
type Root = z.infer<typeof SettingsRoot>;

/** The root that tells an agent holding control what it can mount: management's own. */
export const OFFERED_ROOT = "offered";
/** The roots that are management's own: no caller mounts or unmounts them. */
export const OWN_ROOTS = ["instructions", "skills", OFFERED_ROOT];
/** The root an AgentOrg control unit gives its agent, or that is mounted on it as `control`. */
export const CONTROL_ROOT = "control";

/**
 * Where management's `skillTools` is exposed to each agent, so its model is offered the one tool as
 * `settings__skill`, the name it was offered when the agent read skills through its settings.
 */
export const SKILLS_SLOT = "settings";
/** Management's `tools@1` whose one tool reads a skill's files. */
export const SKILL_TOOLS_EXPORT = "skillTools";
/** The one tool `skillTools` lists, as an agent's model is offered it. */
export const SKILL_TOOL = {
  name: "skill",
  description: "Read a skill: its SKILL.md, or with path a file in its folder.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, as your instructions list it." },
      path: { type: "string", description: "A file in the skill's folder, relative to it." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};
/** Its arguments: the skill's name, and the file in its folder if not `SKILL.md`. */
const SkillAsked = z.object({ name: SkillName, path: SkillPath.optional() });
/** What `skill` was asked, or refused `invalid` as the slot's own check refuses it. */
export function skillAsked(input: unknown) {
  const read = SkillAsked.safeParse(input);
  if (read.success) return read.data;
  const issue = read.error.issues[0];
  throw new Refused(
    "invalid",
    `${SKILLS_SLOT}.${SKILL_TOOL.name} input: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "invalid"}`,
  );
}
/** The most a `tools@1` call's output carries. */
const OUTPUT_MAX = 200_000;
/**
 * A skill's file as a call's output: one too long keeps its start and its end, which are what an
 * agent's model is shown of a long output, and says how much was cut between them.
 */
export function fitted(text: string) {
  if (text.length <= OUTPUT_MAX) return text;
  const half = (OUTPUT_MAX - 64) / 2;
  const head = text.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-half).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}\n… [${text.length - head.length - tail.length} characters cut] …\n${tail}`;
}

/** The file of a skill whose words its agent is told in every request while it has the skill. */
export const ALWAYS = "ALWAYS.md";
/** The most of it an agent is told, in characters, as the agent provider tells it. */
const ALWAYS_MAX = 2_000;
/** What a skill always says, from its `ALWAYS.md`: trimmed, and cut where a character ends. */
export function alwaysOf(text: string | undefined) {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const cut = trimmed.slice(0, ALWAYS_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Whether its AgentOrg control unit gives the agent its control. */
export const unitControls = (record: TheAgent, self: string) =>
  record.units.some((unit) => unit.provider === self && unit.unit === AGENTS_UNIT);
/** Whether the agent holds control: from its unit, or mounted on it. */
export const holdsControl = (record: TheAgent, self: string) =>
  unitControls(record, self) || record.mounted.some((one) => one.capability === CONTROL_ROOT);

/**
 * The tree of what is mounted on an agent, in order: management's own roots, its control, its
 * capabilities' plugins, then what was mounted on it. `self` is management's own id, whose control
 * unit it looks for; `told` and `skills` are what management tells it of itself, each skill with
 * what it always says (`always`) if it has that. An agent holding control is told, as `offered`,
 * what `offered` gives of what it can mount, given every capability the tree names.
 */
export function treeOf(
  record: TheAgent,
  self: string,
  told: string,
  skills: (z.infer<typeof SkillEntry> & { always?: string })[],
  offered: (named: string[]) => string | undefined = () => undefined,
): Root[] {
  const tree = rootsOf(record, self, told, skills);
  const text = holdsControl(record, self)
    ? offered(tree.map(({ capability }) => capability))
    : undefined;
  if (text === undefined) return tree;
  const [instructions, skilled, ...rest] = tree as [Root, Root, ...Root[]];
  return [
    instructions,
    skilled,
    { mounted: OFFERED_ROOT, capability: OFFERED_ROOT, arguments: { text } },
    ...rest,
  ];
}

/** The tree but for `offered`. */
function rootsOf(
  record: TheAgent,
  self: string,
  told: string,
  skills: (z.infer<typeof SkillEntry> & { always?: string })[],
): Root[] {
  const held = record.provider;
  const control = unitControls(record, self);
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
