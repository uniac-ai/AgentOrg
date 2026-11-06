import { parentPort } from "node:worker_threads";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** One schema of an interface, keyed by the interface's hash and the part's name. */
export interface SchemaPart {
  key: string;
  schema: unknown;
}
/** Compile the parts this worker doesn't have yet; then, with `check`, validate one value. */
export interface Job {
  id: number;
  parts: SchemaPart[];
  check?: { key: string; value: unknown };
}
export type Reply =
  | { id: number; ok: true }
  | { id: number; ok: false; stage: "compile" | "check"; message: string };
/** Sent once a job's schemas are compiled, before its value is checked: the check's budget starts. */
export interface Compiled {
  id: number;
  compiled: true;
}

/** Parts kept compiled; past this the oldest are dropped and compiled again on use. */
const MAX_COMPILED = 4096;

// addUsedSchema off: a schema's `$id` stays its own, so one Actor's can't clash with another's.
// allowMatchingProperties: strict mode would otherwise test each patternProperties regex against the
// property names while compiling, running an Actor's regex on its own strings outside any check.
const ajv = new Ajv2020({ strict: true, addUsedSchema: false, allowMatchingProperties: true });
const compiled = new Map<string, { validate: ValidateFunction; schema: unknown }>();

function compile(part: SchemaPart): ValidateFunction {
  const known = compiled.get(part.key);
  if (known) return known.validate;
  const validate = ajv.compile(part.schema as object);
  compiled.set(part.key, { validate, schema: part.schema });
  for (const [key, entry] of compiled) {
    if (compiled.size <= MAX_COMPILED) break;
    compiled.delete(key);
    // ajv keeps object schemas only; `true` and `false` aren't cached and can't be removed.
    if (typeof entry.schema === "object" && entry.schema !== null) ajv.removeSchema(entry.schema);
  }
  return validate;
}

function run(job: Job, compiled: () => void): Reply {
  let validate: ValidateFunction | undefined;
  for (const part of job.parts)
    try {
      const fn = compile(part);
      if (part.key === job.check?.key) validate = fn;
    } catch (error) {
      return {
        id: job.id,
        ok: false,
        stage: "compile",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  if (!job.check || !validate) return { id: job.id, ok: true };
  compiled();
  if (validate(job.check.value)) return { id: job.id, ok: true };
  const issue = validate.errors?.[0];
  return {
    id: job.id,
    ok: false,
    stage: "check",
    message: issue ? `${issue.instancePath || "value"} ${issue.message}` : "invalid",
  };
}

parentPort?.on("message", (job: Job) =>
  parentPort?.postMessage(
    run(job, () => parentPort?.postMessage({ id: job.id, compiled: true } satisfies Compiled)),
  ),
);
// ajv is loaded: from here, jobs and their budgets.
parentPort?.postMessage("ready");
