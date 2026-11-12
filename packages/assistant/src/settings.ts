/**
 * What the `settings` slot adds to a request: the skills exposed to this agent, named in its
 * instructions, and one tool to read them. A skill's text is read only when the model asks for it.
 */
import type { agentSettings, SkillEntry } from "@agentorg/interfaces";
import type { Slot } from "@agentorg/sdk";
import type { z } from "zod";
import type { Candidate, LeftOut } from "./tools.js";

/**
 * The longest the agent's own instructions may be: what a request can carry, less room for what
 * the looper tells a worker after them.
 */
export const MAX_INSTRUCTIONS = 198_000;
const SLOT = "settings";

const HEADING = `## Skills
A skill is written instructions for a kind of task. When one fits what you're asked, read it with settings__skill and follow it before you start. Pass path to read a file its SKILL.md refers to.`;

/** The agent's instructions and the skills that fit in them; any that don't are reported. */
export function instructionsWith(
  instructions: string,
  skills: z.output<typeof SkillEntry>[],
): { instructions: string; leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  if (skills.length === 0) return { instructions, leftOut };
  let text = `${instructions}\n\n${HEADING}`;
  for (const { name, description } of skills) {
    const line = `\n- ${name}: ${description}`;
    if (text.length + line.length > MAX_INSTRUCTIONS)
      leftOut.push({ slot: SLOT, tool: name, reason: "limit" });
    else text += line;
  }
  return leftOut.length === skills.length
    ? { instructions, leftOut }
    : { instructions: text, leftOut };
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
