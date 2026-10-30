/** Local JSON Schema validation for Actor interfaces and Provider configuration. */

import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; its function is the default export, or the module itself.
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as <T extends Ajv | Ajv2020>(ajv: T) => T;
const options = {
  strict: false,
  validateFormats: true,
  allErrors: true,
  addUsedSchema: false,
  logger: false as const,
};
const draft7 = addFormats(new Ajv(options));
const draft2020 = addFormats(new Ajv2020(options));
const compiled = new Map<string, ValidateFunction | null>();

/** Each schema resolves its own definitions; compilation never loads a remote reference. */
function validator(schema: unknown): ValidateFunction | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  let key: string | undefined;
  try {
    key = JSON.stringify(schema);
    if (compiled.has(key)) return compiled.get(key) ?? undefined;
    const dialect = (schema as Record<string, unknown>).$schema;
    const ajv =
      typeof dialect === "string" &&
      /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(dialect)
        ? draft2020
        : draft7;
    const check = ajv.compile(JSON.parse(key));
    if ("$async" in check && check.$async === true) {
      compiled.set(key, null);
      return undefined;
    }
    compiled.set(key, check);
    return check;
  } catch {
    if (key !== undefined) compiled.set(key, null);
    return undefined;
  }
}

export function validSchema(schema: unknown): boolean {
  return validator(schema) !== undefined;
}

/** A value's schema violation; invalid schema diagnostics never include schema contents. */
export function violation(schema: object, value: unknown): string | undefined {
  const check = validator(schema);
  if (!check) return "the schema itself is invalid";
  return check(value) ? undefined : "the value does not match the schema";
}
