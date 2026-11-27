/**
 * The skills exposed to the agent, as what is mounted on it gives them: each named in what it is
 * told, with what each that has an `ALWAYS.md` always says, which comes with them, and one function
 * to read a skill's files, which runs through the tools management exposes to the agent at
 * `settings`. What doesn't fit beside the agent's own words is left out.
 */
import { SkillEntry } from "@agentorg/interfaces";
import type { Context } from "cordis";
import { z } from "zod";
import { alwaysOf, instructionsWith, skillTool } from "../settings.js";
import type { Capability } from "../substrate.js";
import { WORDS } from "./instructions.js";

/** Where the skills go among what a request is told: after the agent's own words. */
export const SKILLS_ORDER = -30;
/** Each skill, with what it always says (its `ALWAYS.md`) when it has that. */
const Skills = z.array(SkillEntry.extend({ always: z.string().optional() })).catch([]);

/** The `skills` capability, mounted with `{ skills }`. */
export const skills = (): Capability<{ skills?: unknown } | undefined> => ({
  name: "skills",
  title: "Skills",
  inject: ["context", "hub"],
  apply(ctx: Context, args) {
    const exposed = Skills.parse(args?.skills);
    if (exposed.length === 0) return;
    const always = alwaysOf(exposed);
    // In its place among the functions, though the tools at `settings` list it too: connections
    // offers what this offers no second time.
    ctx.context.pass(
      (request) => {
        const words = request.instructions.find((part) => part.owner === WORDS)?.text ?? "";
        const { parts, leftOut } = instructionsWith(words, exposed, always);
        request.instructions.push(...parts.slice(1));
        request.leftOut.push(...leftOut);
        request.functions.push(skillTool(ctx.hub));
      },
      { order: SKILLS_ORDER },
    );
  },
});
