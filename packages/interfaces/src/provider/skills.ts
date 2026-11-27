import { z } from "zod";

/** A skill's name, as the Agent Skills convention writes it. */
export const SkillName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);
/** What a list says of a skill, from its `SKILL.md` front matter. */
export const SkillEntry = z.object({
  name: SkillName,
  description: z.string().max(1024),
});
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
