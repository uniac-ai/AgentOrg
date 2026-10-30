/** JSON Schema for the model's Zod schemas, in the shape interfaces and commands read it. */

import { z } from "zod";

export type JsonSchema = { [key: string]: unknown };

/** A built-in's schemas, audit policy and caller-facing description. */
export interface BuiltinSpec {
  readonly writes: boolean;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  /** The first paragraph is the summary. */
  readonly description: string;
}

/** A feature's contract, shared by its bound operations and schema-only consumers. */
export function toolDefinition<const N extends string, const S extends Record<string, BuiltinSpec>>(
  name: N,
  interfaces: S,
) {
  return { id: `hub:${name}`, name, interfaces };
}

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
