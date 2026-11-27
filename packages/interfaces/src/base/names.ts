import { z } from "zod";

/** The ids and names every set of interfaces takes. */

export const Id = z.string().min(1).max(128);
/** A slot or export: `name`, or `module.name`. */
export const Name = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)?$/)
  .max(129);
/** A slot made at run time: one segment, at most 48 characters, so tools named from it fit. */
export const SlotName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(48);
