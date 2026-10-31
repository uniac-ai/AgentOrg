/**
 * Commands generated from the core's built-ins: `actor_create` is `agentorg actor create`,
 * and `view` is `agentorg view`. Each runs against the core as the actor whose credential is in
 * `AGENTORG_ACTOR_ID` and `AGENTORG_CREDENTIAL`, else as the local root.
 *
 * Each top-level field of the built-in's request becomes a flag (`since` becomes `--since`); a list
 * field takes its flag once per item, and an object field is given as JSON. A required field named
 * after the command's first word, such as `actor` in `agentorg actor close`, may be positional
 * or use its named flag.
 * `--json` gives the whole request as JSON, with any flags overriding its fields. The request is
 * checked against the built-in's schema before it is sent.
 */

import { parseArgs } from "node:util";
import { invalid } from "../../domain/errors.ts";
import {
  BUILTIN_NAMES,
  BUILTINS,
  type BuiltinName,
  type JsonSchema,
  objectSchema,
} from "../../domain/model/index.ts";

type Kind = "string" | "number" | "boolean" | "strings" | "objects" | "json";

interface Field {
  name: string;
  flag: string;
  kind: Kind;
  description: string;
  positional: boolean;
}

export const wordsOf = (name: BuiltinName) => name.split("_");
const summaryOf = (name: BuiltinName) => BUILTINS[name].description.split("\n\n")[0] ?? "";

/** The schema itself, without the `null` of an optional field. */
function bare(schema: JsonSchema): JsonSchema {
  const variants = (schema.anyOf as JsonSchema[] | undefined)?.filter(
    (each) => each.type !== "null",
  );
  return variants?.length === 1
    ? { ...(variants[0] as JsonSchema), description: schema.description }
    : schema;
}

function kindOf(schema: JsonSchema): Kind {
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "array")
    return (schema.items as JsonSchema)?.type === "string" ? "strings" : "objects";
  return "json";
}

function fieldsOf(name: BuiltinName): Field[] {
  const schema = objectSchema(BUILTINS[name].request, "input");
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const [subject] = wordsOf(name);
  return Object.entries((schema.properties as Record<string, JsonSchema>) ?? {}).map(
    ([field, property]) => {
      const resolved = bare(property);
      return {
        name: field,
        flag: field.replaceAll("_", "-"),
        kind: kindOf(resolved),
        description: String(resolved.description ?? ""),
        positional: field === subject && required.has(field),
      };
    },
  );
}

/**
 * The built-in a command line names, such as `actor create`, and the arguments after it. The
 * longest match wins, so `progress set` is not `progress` with an argument.
 */
export function builtinOf(argv: string[]): { name: BuiltinName; rest: string[] } | undefined {
  const [name] = BUILTIN_NAMES.filter((each) =>
    wordsOf(each).every((word, index) => argv[index] === word),
  ).sort((a, b) => wordsOf(b).length - wordsOf(a).length);
  return name && { name, rest: argv.slice(wordsOf(name).length) };
}

const json = (text: string, flag: string) => {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid([{ code: "custom", path: [flag], message: "must be JSON", input: text }]);
  }
};

/** The checked request a command line gives. */
export function requestOf(name: BuiltinName, args: string[]): Record<string, unknown> {
  const fields = fieldsOf(name);
  const options = Object.fromEntries([
    ["json", { type: "string" as const }],
    ...fields.map((field) => [
      field.flag,
      {
        type: field.kind === "boolean" ? ("boolean" as const) : ("string" as const),
        multiple: field.kind === "strings" || field.kind === "objects",
      },
    ]),
  ]);
  const parsedArgs = parseArgs({ args, options, allowPositionals: true, strict: true });
  const values = parsedArgs.values as Record<string, string | boolean | string[] | undefined>;
  const { positionals } = parsedArgs;
  const body: Record<string, unknown> = values.json ? json(String(values.json), "json") : {};
  for (const field of fields) {
    const value = field.positional ? (positionals[0] ?? values[field.flag]) : values[field.flag];
    if (value === undefined) continue;
    const convert = (each: string) =>
      field.kind === "number"
        ? Number(each)
        : field.kind === "string" || field.kind === "strings"
          ? each
          : json(each, field.flag);
    body[field.name] = Array.isArray(value)
      ? value.map((each) => convert(String(each)))
      : typeof value === "boolean"
        ? value
        : convert(String(value));
  }
  const parsed = BUILTINS[name].request.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return body;
}

export function helpOf(name: BuiltinName): string {
  const fields = fieldsOf(name);
  const positional = fields.find((field) => field.positional);
  return [
    `usage: agentorg ${wordsOf(name).join(" ")}${positional ? ` <${positional.name}>` : ""} [flags]`,
    "",
    BUILTINS[name].description,
    "",
    ...fields.map((field) => {
      const value =
        field.kind === "boolean"
          ? ""
          : field.kind === "objects" || field.kind === "json"
            ? " <json>"
            : " <value>";
      const repeat = field.kind === "strings" || field.kind === "objects" ? " (repeatable)" : "";
      return `  --${field.flag}${value}${repeat}  ${field.description}`;
    }),
    "  --json <json>  the whole request as a JSON object",
  ].join("\n");
}

/** One line per built-in command, for the usage text. */
export function builtinLines(): string[] {
  return BUILTIN_NAMES.map((name) => `  ${wordsOf(name).join(" ").padEnd(24)}${summaryOf(name)}`);
}
