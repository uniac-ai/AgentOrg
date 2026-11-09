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
/** The most one file of a skill holds, as text. */
export const SKILL_FILE_MAX = 256 * 1024;
/** What a list says of a skill, from its `SKILL.md` front matter. */
export const SkillEntry = z.object({
  name: SkillName,
  description: z.string().max(1024),
});

/**
 * `agent.settings@1`: what an agent is run with, read by the program that runs it. Each caller is
 * answered with its own: the instructions it was given and the skills exposed to it, so an agent
 * sees nothing of another's. It is read at each model request.
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
    /** The caller's instructions or skills changed: read them again at the next request. */
    changed: event(z.object({})),
  },
});
