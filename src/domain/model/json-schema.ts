/** JSON Schema for the model's Zod schemas, in the shape interfaces and commands read it. */

import { z } from "zod";

export type JsonSchema = { [key: string]: unknown };

/**
 * A schema as an object at the top, with the named schemas it refers to in `$defs`. Zod puts a
 * named schema itself in `$defs` and refers to it from the top, which some clients do not accept.
 */
export function objectSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const {
    $schema,
    $ref,
    $defs = {},
    ...rest
  } = z.toJSONSchema(schema, { io }) as JsonSchema & {
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
  };
  if (typeof $ref !== "string") return rest;
  const id = $ref.split("/").pop() as string;
  const { [id]: top, ...others } = $defs;
  return Object.keys(others).length > 0 ? { ...top, $defs: others } : { ...top };
}
