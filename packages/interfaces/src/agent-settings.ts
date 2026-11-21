import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

/** A skill's name, as the Agent Skills convention writes it. */
export const SkillName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);
/**
 * A file of a skill: a relative path inside its folder, of plain segments, never `.` or `..`, with
 * no backslash or control character.
 */
export const SkillPath = z
  .string()
  .regex(
    /^(?!\.\.?(\/|$))(?!.*\/\.\.?(\/|$))([^/\\\p{Cc}\p{Zl}\p{Zp}]+\/)*[^/\\\p{Cc}\p{Zl}\p{Zp}]+$/u,
  )
  .max(1024);
/** A slug, as a capability's id is (`CapabilityId` in `units.ts`, which imports this file). */
const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
/** A plugin's name: the executor loads the plugin it carries of that name. */
export const PluginName = Slug;
/**
 * A plugin a capability is made of, loaded inside the agent that holds the capability: by its name,
 * with the settings it is loaded with. The settings are the plugin's own to read, any JSON, not
 * only what a unit's form gives.
 */
export const CapabilityPlugin = z.strictObject({
  name: PluginName,
  settings: z.record(z.string().max(64), z.json()).optional(),
});
/** The most one file of a skill holds, as text. */
export const SKILL_FILE_MAX = 256 * 1024;
/** What a list says of a skill, from its `SKILL.md` front matter. */
export const SkillEntry = z.object({
  name: SkillName,
  description: z.string().max(1024),
});

/**
 * `agent.settings@1`: what an agent is run with, read by the program that runs it. Each caller is
 * answered with its own: the instructions it was given, the skills exposed to it, and the plugins
 * of the capabilities it holds, so an agent sees nothing of another's. It is read at each model
 * request.
 */
export const agentSettings = defineInterface({
  name: "agent.settings",
  major: 1,
  kind: "rpc",
  methods: {
    get: method({
      input: z.object({}),
      output: z.object({
        instructions: z.string().max(200_000),
        skills: z.array(SkillEntry),
        /**
         * The plugins of every capability the caller holds, each with its settings and the id of
         * the capability it is of, which the executor loads inside the agent. A plugin is named
         * once: an agent holds no two capabilities with the same plugin. None from a management
         * that doesn't say them: the agent then loads none.
         */
        plugins: z
          .array(CapabilityPlugin.extend({ capability: Slug }))
          .max(64)
          .optional(),
      }),
    }),
    /**
     * A file of a skill exposed to the caller, `SKILL.md` if no `path`. Refused `unknown` when the
     * skill isn't exposed to it or has no such file.
     */
    skill: method({
      input: z.object({ name: SkillName, path: SkillPath.optional() }),
      output: z.object({ text: z.string().max(SKILL_FILE_MAX) }),
    }),
  },
  events: {
    /**
     * The caller's instructions, skills or plugins changed: read them again at the next request.
     */
    changed: event(z.object({})),
  },
});
