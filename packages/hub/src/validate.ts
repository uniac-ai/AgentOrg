import type { DescribedInterface, JsonSchema } from "@agentorg/sdk";
import { Refused } from "@agentorg/sdk";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** A part of an interface with its own schema: a method's input or output, an event, or `open`. */
export type Part =
  | { method: string; side: "input" | "output" }
  | { event: string }
  | { open: true };

const describe = (part: Part) =>
  "method" in part
    ? `${part.method} ${part.side}`
    : "event" in part
      ? `${part.event} event`
      : "open";

function schemaOf(iface: DescribedInterface, part: Part): JsonSchema | undefined {
  if ("method" in part)
    return iface.kind === "rpc" && Object.hasOwn(iface.methods, part.method)
      ? iface.methods[part.method]?.[part.side]
      : undefined;
  if ("event" in part)
    return iface.kind === "rpc" && Object.hasOwn(iface.events, part.event)
      ? iface.events[part.event]
      : undefined;
  return iface.kind === "stream" ? iface.open : undefined;
}

function partsOf(iface: DescribedInterface): Part[] {
  if (iface.kind === "stream") return [{ open: true }];
  if (iface.kind !== "rpc") return [];
  return [
    ...Object.keys(iface.methods).flatMap((method) => [
      { method, side: "input" as const },
      { method, side: "output" as const },
    ]),
    ...Object.keys(iface.events).map((event) => ({ event })),
  ];
}

/** Interfaces kept compiled; past this the least recently compiled is dropped and recompiled on use. */
const MAX_COMPILED = 1024;

/**
 * JSON Schema validation in the 2020-12 dialect, with ajv in strict mode. Each interface is
 * compiled once, keyed by its hash, so every Actor declaring the same contract shares the work.
 */
export class Validators {
  // addUsedSchema off: a schema's `$id` stays its own, so one Actor's can't clash with another's.
  readonly #ajv = new Ajv2020({ strict: true, addUsedSchema: false });
  readonly #compiled = new Map<string, Map<string, ValidateFunction>>();
  readonly #schemas = new Map<string, JsonSchema[]>();

  /** Compile every schema of an interface; one that won't compile is refused as `invalid`. */
  prepare(iface: DescribedInterface): Map<string, ValidateFunction> {
    const known = this.#compiled.get(iface.hash);
    if (known) return known;
    const compiled = new Map<string, ValidateFunction>();
    const schemas: JsonSchema[] = [];
    for (const part of partsOf(iface)) {
      const schema = schemaOf(iface, part) as JsonSchema;
      schemas.push(schema);
      try {
        compiled.set(describe(part), this.#ajv.compile(schema));
      } catch (error) {
        throw new Refused(
          "invalid",
          `${iface.id} ${describe(part)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.#compiled.set(iface.hash, compiled);
    this.#schemas.set(iface.hash, schemas);
    // Actors can declare new interfaces on every connect, so the oldest are forgotten past a bound.
    for (const [hash] of this.#compiled) {
      if (this.#compiled.size <= MAX_COMPILED) break;
      this.#compiled.delete(hash);
      const schemas = this.#schemas.get(hash) ?? [];
      this.#schemas.delete(hash);
      // ajv keeps object schemas only; `true` and `false` aren't cached and can't be removed.
      for (const schema of schemas)
        if (typeof schema === "object" && schema !== null) this.#ajv.removeSchema(schema);
    }
    return compiled;
  }

  /** Whether the part exists on the interface. */
  has(iface: DescribedInterface, part: Part): boolean {
    return schemaOf(iface, part) !== undefined;
  }

  /**
   * Check a value against a part's schema. A caller's misfit is `invalid` (nothing ran); a
   * provider's is `bad_output` (it ran and broke the contract).
   */
  check(iface: DescribedInterface, part: Part, value: unknown, code: "invalid" | "bad_output") {
    const validate = this.prepare(iface).get(describe(part));
    if (!validate) throw new Refused("invalid", `${iface.id} has no ${describe(part)}.`);
    if (validate(value)) return;
    const issue = validate.errors?.[0];
    throw new Refused(
      code,
      `${iface.id} ${describe(part)}: ${issue ? `${issue.instancePath || "value"} ${issue.message}` : "invalid"}`,
    );
  }
}
