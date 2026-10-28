/**
 * Checking values against JSON Schema, the domain's schema language for interfaces: a call's
 * input against its interface's input schema, and its structured value against the output schema.
 */

import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; its function is the default export, or the module itself.
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

const ajv = addFormats(
  new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }),
);
/** Compiled schemas by their JSON, since every read of an actor's interfaces parses them afresh. */
const compiled = new Map<string, ReturnType<Ajv["compile"]>>();

/** Why `value` breaks `schema`, or undefined when it conforms. */
export function violation(schema: object, value: unknown): string | undefined {
  const key = JSON.stringify(schema);
  let check = compiled.get(key);
  if (!check) {
    try {
      check = ajv.compile(schema);
    } catch (error) {
      return `the schema itself is invalid: ${(error as Error).message}`;
    }
    compiled.set(key, check);
  }
  return check(value) ? undefined : ajv.errorsText(check.errors);
}
