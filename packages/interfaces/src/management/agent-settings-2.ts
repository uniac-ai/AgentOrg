import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { ROOTS_MAX, SettingsRoot } from "../provider/mounted.js";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "../provider/skills.js";

/**
 * `agent.settings@2`: what an agent is run with, read by the program that runs it: the tree of what
 * is mounted on it, in the order it was mounted, in place of `agent.settings@1`'s instructions,
 * skills and plugins. Each caller is answered with its own, so an agent sees nothing of another's.
 */
export const agentSettings2 = defineInterface({
  name: "agent.settings",
  major: 2,
  kind: "rpc",
  methods: {
    get: method({
      input: z.object({}),
      output: z.object({ mounted: z.array(SettingsRoot).max(ROOTS_MAX) }),
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
    /** What is mounted on the caller changed, or what a root says: read it again. */
    changed: event(z.object({})),
  },
});
