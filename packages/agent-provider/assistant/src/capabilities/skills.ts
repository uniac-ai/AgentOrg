/**
 * The skills exposed to the agent, as its settings give them: each named in what it is told, with
 * the `ALWAYS.md` of each that has one, and one function to read a skill's files, which it reads
 * through the agent's `settings`. What doesn't fit beside the agent's own words is left out.
 */
import { SkillEntry } from "@agentorg/interfaces";
import type { Part } from "@agentorg/looper";
import type { Context } from "cordis";
import { z } from "zod";
import { alwaysOf, instructionsWith, skillTool } from "../settings.js";
import type { Capability } from "../substrate.js";
import { WORDS } from "./instructions.js";

/** Where the skills go among what a request is told: after the agent's own words. */
export const SKILLS_ORDER = -30;
const Skills = z.array(SkillEntry).catch([]);

/** The `skills` capability, mounted with `{ skills }`. */
export const skills = (): Capability<{ skills?: unknown } | undefined> => ({
  name: "skills",
  title: "Skills",
  inject: ["context", "hub"],
  apply(ctx: Context, args) {
    const exposed = Skills.parse(args?.skills);
    if (exposed.length === 0) return;
    const slot = ctx.hub.slots.settings;
    let always: Part[] = [];
    // Each skill's `ALWAYS.md`, read once a turn: a pass can't wait for it.
    ctx.context.turn(async () => {
      always = await alwaysOf(slot, exposed);
    });
    ctx.context.pass(
      (request) => {
        const words = request.instructions.find((part) => part.owner === WORDS)?.text ?? "";
        const { parts, leftOut } = instructionsWith(words, exposed, always);
        request.instructions.push(...parts.slice(1));
        request.leftOut.push(...leftOut);
        request.functions.push(skillTool(slot));
      },
      { order: SKILLS_ORDER },
    );
  },
});
