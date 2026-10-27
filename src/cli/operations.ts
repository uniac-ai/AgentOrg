/**
 * Commands generated from the contract: `agentorg {subject} {verb}` for each agent and API
 * operation.
 *
 * Each top-level field of the operation's request becomes a flag (`client_session_id` becomes
 * `--client-session-id`); a list field takes its flag once per item, with object items given as
 * JSON, and an object field is given as JSON. A required field named after the subject, such as
 * `ask` in `agentorg ask wait`, is positional. `--json` gives the whole request as JSON, with any
 * flags overriding its fields. The request is validated before it is sent.
 */

import { parseArgs } from "node:util";
import { API_OPERATIONS } from "../api/index.ts";
import {
  type JsonSchema,
  OPERATIONS,
  type OperationName,
  objectSchema,
  subjectAndVerb,
  summaryOf,
} from "../contract/index.ts";
import { invalid } from "../operations/index.ts";

type Kind = "string" | "number" | "boolean" | "strings" | "objects" | "json";

export interface Field {
  name: string;
  flag: string;
  kind: Kind;
  description: string;
  positional: boolean;
}

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

export function fieldsOf(name: OperationName): Field[] {
  const schema = objectSchema(OPERATIONS[name].request, "input");
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const [subject] = subjectAndVerb(name);
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

/** The operation a command line names, such as `ask record-answer`, if it is on the API. */
export function operationOf(subject: string, verb: string): OperationName | undefined {
  const name = `${subject}_${verb.replaceAll("-", "_")}` as OperationName;
  return API_OPERATIONS.includes(name) ? name : undefined;
}

const json = (text: string, flag: string) => {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid([{ code: "custom", path: [flag], message: "must be JSON", input: text }]);
  }
};

/** The validated request a command line gives. */
export function requestOf(name: OperationName, args: string[]): unknown {
  const fields = fieldsOf(name);
  const options = Object.fromEntries([
    ["json", { type: "string" as const }],
    ...fields
      .filter((field) => !field.positional)
      .map((field) => [
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
    const value = field.positional ? positionals[0] : values[field.flag];
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
  const parsed = OPERATIONS[name].request.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data;
}

export function helpOf(name: OperationName, extra = ""): string {
  const [subject, verb] = subjectAndVerb(name);
  const fields = fieldsOf(name);
  const positional = fields.find((field) => field.positional);
  const lines = [
    `usage: agentorg ${subject} ${verb.replaceAll("_", "-")}${positional ? ` <${positional.name}>` : ""} [flags]`,
    "",
    OPERATIONS[name].description,
    "",
    ...fields
      .filter((field) => !field.positional)
      .map((field) => {
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
  ];
  return [...lines, ...(extra ? ["", extra] : [])].join("\n");
}

export function usage(): string {
  const commands = API_OPERATIONS.map((name) => {
    const [subject, verb] = subjectAndVerb(name);
    return `  ${`${subject} ${verb.replaceAll("_", "-")}`.padEnd(24)}${summaryOf(name)}`;
  });
  return [
    "usage: agentorg <command> [flags]",
    "",
    "The record of agents, their sessions, asks to managers, and messages up.",
    "",
    "  serve [--port <n>]      run the service on 127.0.0.1",
    "  mcp --client <kind> [--client-session-env <variable>]",
    "                          serve MCP over stdio, relayed to the service",
    "  ui                      open the decisions page, signed in",
    ...commands,
    "",
    "Every command prints its result as JSON on stdout and its errors on stderr, and exits",
    "non-zero when the service is down or refuses. `agentorg <command> --help` shows its flags.",
  ].join("\n");
}
