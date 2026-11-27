/**
 * What the skills exposed to this agent add to a request: each named in its instructions, and one
 * tool to read them, which management exposes to it at `settings`. A skill's text is read only when
 * the model asks for it, but for its `ALWAYS.md`, which comes with the list of what is mounted on
 * the agent and every request is told while the skill is exposed (see the README).
 */
import type { SkillEntry } from "@agentorg/interfaces";
import { FRAME, type Part } from "@agentorg/looper";
import { NotConnected } from "@agentorg/sdk";
import type { z } from "zod";
import type { AgentHub } from "./connector.js";
import { type Candidate, type LeftOut, listsTools, runThrough } from "./tools.js";

/**
 * The longest the agent's own instructions may be: what a request can carry, less room for what
 * the looper tells a worker before them, its frame, and after them.
 */
export const MAX_INSTRUCTIONS = 198_000 - FRAME.length - 2;
/** Where management exposes the `tools@1` whose one tool reads a skill's files. */
const SLOT = "settings";
/** The file of a skill whose words the agent is told in every request while it has the skill. */
export const ALWAYS = "ALWAYS.md";
/** The most characters of a skill's `ALWAYS.md` told: what close products keep of a tool's own words. */
export const ALWAYS_MAX = 2_000;

/**
 * What each skill exposed to the agent always says, in their order, each as a part: its
 * `ALWAYS.md`, as management gives it with the skill. A skill with none gives no part.
 */
export function alwaysOf(skills: { name: string; always?: string }[]): Part[] {
  return skills.flatMap(({ name, always }) => {
    const text = always?.trim();
    return text ? [{ owner: `${name}/${ALWAYS}`, text, max: ALWAYS_MAX }] : [];
  });
}

const HEADING = `## Skills
A skill is written instructions for a kind of task. When one fits what you're asked, read it with settings__skill and follow it before you start. Pass path to read a file its SKILL.md refers to.`;

/**
 * What the agent is told, as the looper's parts in order: its own instructions, cut to
 * `MAX_INSTRUCTIONS`, what its skills always tell it (`always`, from `alwaysOf`), then the skills'
 * names, one a line, as many of each as fit within `MAX_INSTRUCTIONS` in that order; any that
 * don't fit are reported.
 */
export function instructionsWith(
  instructions: string,
  skills: z.output<typeof SkillEntry>[],
  always: Part[] = [],
): { parts: Part[]; leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  const own: Part = { owner: "agent", text: instructions, max: MAX_INSTRUCTIONS };
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

/**
 * The one way the model reads a skill: its `SKILL.md`, or a file of its folder by `path`. It runs
 * through the `tools@1` exposed to the agent at `settings` as the call runs.
 */
export function skillTool(hub: Pick<AgentHub, "exposed">): Candidate {
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
    run: async (args, group) => {
      const slot = hub.exposed().find((one) => one.slot === SLOT && listsTools(one.described));
      if (!slot) throw new NotConnected(SLOT);
      return runThrough(slot, "skill")(args, group);
    },
  };
}
