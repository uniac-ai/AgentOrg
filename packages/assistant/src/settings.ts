/**
 * What the `settings` slot adds to a request: the skills exposed to this agent, named in its
 * instructions, and one tool to read them. A skill's text is read only when the model asks for it,
 * but for its `ALWAYS.md`, which every request is told while the skill is exposed (see the README).
 */
import type { agentSettings, SkillEntry } from "@agentorg/interfaces";
import type { Part } from "@agentorg/looper";
import type { Slot } from "@agentorg/sdk";
import type { z } from "zod";
import type { Candidate, LeftOut } from "./tools.js";

/**
 * The longest the agent's own instructions may be: what a request can carry, less room for what
 * the looper tells a worker after them.
 */
export const MAX_INSTRUCTIONS = 198_000;
const SLOT = "settings";
/** The file of a skill whose words the agent is told in every request while it has the skill. */
export const ALWAYS = "ALWAYS.md";
/** The most characters of a skill's `ALWAYS.md` told: what close products keep of a tool's own words. */
export const ALWAYS_MAX = 2_000;

/**
 * The `ALWAYS.md` of each skill exposed to the agent, in their order, read through `settings`, each
 * as a part. A skill with none is refused `unknown`, and gives no part; so does one that can't be
 * read now.
 */
export async function alwaysOf(
  slot: Slot<typeof agentSettings>,
  skills: z.output<typeof SkillEntry>[],
): Promise<Part[]> {
  const read = await Promise.all(
    skills.map(async ({ name }): Promise<Part | undefined> => {
      try {
        const text = (await slot.call.skill({ name, path: ALWAYS })).text.trim();
        return text ? { owner: `${name}/${ALWAYS}`, text, max: ALWAYS_MAX } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return read.filter((part) => part !== undefined);
}

const HEADING = `## Skills
A skill is written instructions for a kind of task. When one fits what you're asked, read it with settings__skill and follow it before you start. Pass path to read a file its SKILL.md refers to.`;

/**
 * What the agent is told, as the looper's parts in order: its own instructions, what its skills
 * always tell it (`always`, from `alwaysOf`), then the skills' names, one a line, as many of each
 * as fit within `MAX_INSTRUCTIONS` in that order; any that don't fit are reported.
 */
export function instructionsWith(
  instructions: string,
  skills: z.output<typeof SkillEntry>[],
  always: Part[] = [],
): { parts: Part[]; leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  const own: Part = { owner: "agent", text: instructions };
  if (skills.length === 0) return { parts: [own], leftOut };
  // Each fits beside the agent's own words and those before it, a blank line between each.
  let used = instructions.length;
  const kept: Part[] = [];
  for (const part of always) {
    const size = 2 + Math.min(part.text.length, part.max ?? part.text.length);
    if (used + size > MAX_INSTRUCTIONS)
      leftOut.push({ slot: SLOT, tool: part.owner, reason: "limit" });
    else {
      kept.push(part);
      used += size;
    }
  }
  let text = HEADING;
  let named = 0;
  for (const { name, description } of skills) {
    const line = `\n- ${name}: ${description}`;
    if (used + 2 + text.length + line.length > MAX_INSTRUCTIONS)
      leftOut.push({ slot: SLOT, tool: name, reason: "limit" });
    else {
      text += line;
      named++;
    }
  }
  return named === 0
    ? { parts: [own, ...kept], leftOut }
    : { parts: [own, ...kept, { owner: "skills", text }], leftOut };
}

/** The one way the model reads a skill: its `SKILL.md`, or a file of its folder by `path`. */
export function skillTool(slot: Slot<typeof agentSettings>): Candidate {
  return {
    slot: SLOT,
    name: "skill",
    description: "Read a skill: its SKILL.md, or with path a file in its folder.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, as your instructions list it." },
        path: { type: "string", description: "A file in the skill's folder, relative to it." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { text } = await slot.call.skill(args as { name: string; path?: string });
      return { output: text, ok: true };
    },
  };
}
