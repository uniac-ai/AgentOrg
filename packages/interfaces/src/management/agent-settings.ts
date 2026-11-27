import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { CapabilityPlugin, Slug } from "../provider/plugins.js";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "../provider/skills.js";

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
