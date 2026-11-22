import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "./agent-settings.js";
import { Arguments } from "./capability-provider.js";
import { Id } from "./hub.js";
import { CapabilityId } from "./units.js";

/**
 * A capability mounted on an agent, as the program that runs the agent holds it. `mounted` is the
 * id it was mounted under. `capability` is what it is: the executor holds it by the plugin of the
 * same name. `arguments` are what it was mounted with, never a secret. `provider` is the Actor
 * whose `capability.provider@1` made it.
 *
 * Two roots are management's own, and name no provider: no caller mounts or unmounts them.
 * - `instructions`, whose arguments are `{ text }`: the words the agent is told of itself.
 * - `skills`, whose arguments are `{ skills }`: each skill exposed to it, by its name and
 *   description, whose files `skill` reads.
 */
export const SettingsRoot = z.strictObject({
  mounted: Id,
  capability: CapabilityId,
  arguments: Arguments,
  provider: Id.optional(),
});

/**
 * The most roots an agent's tree has: management's own, and beside them what it holds, of which
 * its executor holds at most 64 plugins.
 */
export const ROOTS_MAX = 256;

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
