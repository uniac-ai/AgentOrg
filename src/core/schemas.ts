/**
 * The JSON Schemas of actors' tools: checking a call's input and output against them, and the
 * output schema a caller sees for a routed tool.
 */

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";

const validator = new AjvJsonSchemaValidator();
/** Compiled schemas by their JSON, since every read of an actor's tools parses them afresh. */
const compiled = new Map<string, JsonSchemaValidator<unknown>>();

/** Why `value` breaks `schema`, or undefined when it conforms. */
export function violation(schema: object, value: unknown): string | undefined {
  const key = JSON.stringify(schema);
  let check = compiled.get(key);
  if (!check) {
    try {
      check = validator.getValidator(schema as JsonSchemaType);
    } catch (error) {
      return `the schema itself is invalid: ${(error as Error).message}`;
    }
    compiled.set(key, check);
  }
  const result = check(value);
  return result.valid ? undefined : result.errorMessage;
}

/** What a routed call returns when it is still pending after the bounded wait. */
export const PENDING_OUTPUT = {
  type: "object",
  properties: { call: { type: "string" }, state: { const: "pending" } },
  required: ["call", "state"],
} as const;

/**
 * The output schema a caller sees for a routed tool: the tool's own, or the pending result, so
 * that a client checking results against it accepts both. Definitions move to the top, where the
 * tool's references to them still resolve.
 */
export function routedOutputSchema(outputSchema: Record<string, unknown>): Record<string, unknown> {
  const { $defs, definitions, $schema: _, ...own } = outputSchema;
  return {
    type: "object",
    ...($defs === undefined ? {} : { $defs }),
    ...(definitions === undefined ? {} : { definitions }),
    anyOf: [own, PENDING_OUTPUT],
  };
}

const STRUCTURE = ["anyOf", "oneOf", "allOf", "$ref", "patternProperties"];

/** A one-way tool returns nothing: its output schema is the empty object. */
export function isOneWay(outputSchema: Record<string, unknown> | undefined): boolean {
  if (outputSchema === undefined) return false;
  const { properties = {}, required = [], additionalProperties = false } = outputSchema;
  return (
    Object.keys(properties as object).length === 0 &&
    (required as unknown[]).length === 0 &&
    additionalProperties === false &&
    STRUCTURE.every((keyword) => !(keyword in outputSchema))
  );
}
