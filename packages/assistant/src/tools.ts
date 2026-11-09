/**
 * The assistant's tools, gathered afresh for each model request. A typed slot gives one function
 * per method, whose parameters are the JSON Schema the Hub checks the call against. A `tools@1`
 * slot gives whatever it lists now, with its server's own input schemas. Each is offered as
 * `<slot>__<name>`, and a call runs through the slot, so the Hub checks and audits it like any
 * other.
 */
import { type Tool, type ToolEntry, tools as toolsInterface } from "@agentorg/interfaces";
import {
  type DescribedInterface,
  describeInterface,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "@agentorg/sdk";
import type { z } from "zod";
import { head } from "./history.js";

export interface ToolSlot {
  readonly bound: boolean;
  readonly call: Readonly<Record<string, (input: never) => Promise<unknown>>>;
}
/** How a function call ended, as the model and the record see it. */
export interface Outcome {
  output: string;
  ok: boolean;
  code?: string;
}
interface Found {
  tool: z.input<typeof Tool>;
  run(input: unknown): Promise<Outcome>;
}
export type Tools = Map<string, Found>;
/** A tool as its slot gives it, before it has the name a request offers it under. */
export interface Candidate {
  slot: string;
  name: string;
  description?: string;
  parameters: Record<string, z.core.util.JSONType>;
  run: Found["run"];
}
/**
 * Something the model isn't offered, and why: `name` (past 64 characters as a function name),
 * `duplicate` (its function name is already taken), `limit` (past what a request can carry), or,
 * with no `tool`, the code its slot's list failed with.
 */
export interface LeftOut {
  slot: string;
  tool?: string;
  reason: string;
}

/** A function's output is cut to this many bytes of UTF-8, so one result can't fill a request. */
export const MAX_OUTPUT = 16 * 1024;
/** What a request can carry: its tools count, and, with the record and instructions, one frame. */
export const MAX_TOOLS = 128;
export const TOOLS_BUDGET = 256 * 1024;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const encoder = new TextEncoder();
const TOOLS_ID = describeInterface(toolsInterface).id;

/** The code and message of anything a call or a turn can throw. */
export function codeOf(error: unknown): { code: string; message: string } {
  if (error instanceof Refused) return { code: error.code, message: error.message };
  if (error instanceof NotConnected)
    return { code: "not_connected", message: `${error.target} is not connected.` };
  if (error instanceof OutcomeUnknown) return { code: "outcome_unknown", message: error.message };
  return { code: "failed", message: "The call failed." };
}

/** At most `MAX_OUTPUT` bytes of `text`, cut at a character, saying so when it is cut. */
export function capped(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= MAX_OUTPUT) return text;
  const head = new TextDecoder().decode(bytes.subarray(0, MAX_OUTPUT - 16)).replace(/�$/, "");
  return `${head}… (cut)`;
}

/** The methods of a typed slot, as tools. An unbound slot, or another kind, gives none. */
export function methodsOf(name: string, described: DescribedInterface, slot: ToolSlot) {
  if (!slot.bound || described.kind !== "rpc") return [];
  return Object.entries(described.methods).map(
    ([method, { input }]): Candidate => ({
      slot: name,
      name: method,
      description: `${method} on ${name} (${described.id})`,
      // A described schema is JSON by construction.
      parameters: input as Candidate["parameters"],
      run: async (args) => {
        const call = slot.call[method] as (input: unknown) => Promise<unknown>;
        return { output: JSON.stringify((await call(args)) ?? {}), ok: true };
      },
    }),
  );
}

/** Whether a slot is a `tools@1`, whose tools are whatever it lists. */
export const listsTools = (described: DescribedInterface) => described.id === TOOLS_ID;

/**
 * What a `tools@1` slot lists now. A slot that can't answer gives no tools and says why, and is
 * asked again at the next request.
 */
export async function listedBy(
  name: string,
  slot: { readonly call: Readonly<Record<string, (input: unknown) => Promise<unknown>>> },
): Promise<{ candidates: Candidate[]; leftOut: LeftOut[] }> {
  const list = slot.call.list as (input: object) => Promise<unknown>;
  const call = slot.call.call as (input: object) => Promise<unknown>;
  let entries: z.output<typeof ToolEntry>[];
  try {
    ({ tools: entries } = (await list({})) as { tools: typeof entries });
  } catch (error) {
    return { candidates: [], leftOut: [{ slot: name, reason: codeOf(error).code }] };
  }
  const candidates = entries.map(
    (entry): Candidate => ({
      slot: name,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      parameters: entry.inputSchema as Candidate["parameters"],
      run: async (args) => {
        const { output, failed } = (await call({ name: entry.name, arguments: args })) as {
          output: string;
          failed?: true;
        };
        return failed ? { output, ok: false, code: "failed" } : { output, ok: true };
      },
    }),
  );
  return { candidates, leftOut: [] };
}

/**
 * The tools one request offers, by function name, and what it can't. A character a function name
 * can't have becomes `_`. Candidates are taken in order, so the first ones given are the ones kept
 * when a request is full; what doesn't fit is reported, never sent.
 */
export function offered(candidates: Candidate[]): { tools: Tools; leftOut: LeftOut[] } {
  const tools: Tools = new Map();
  const leftOut: LeftOut[] = [];
  let bytes = 0;
  for (const { slot, name, description, parameters, run } of candidates) {
    const toolName = `${slot}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const tool = {
      name: toolName,
      ...(description ? { description: head(description, MAX_DESCRIPTION) } : {}),
      parameters,
    };
    const size = encoder.encode(JSON.stringify(tool)).byteLength;
    const reason =
      toolName.length > MAX_NAME
        ? "name"
        : tools.has(toolName)
          ? "duplicate"
          : tools.size >= MAX_TOOLS || bytes + size > TOOLS_BUDGET
            ? "limit"
            : undefined;
    if (reason) {
      leftOut.push({ slot, tool: name, reason });
      continue;
    }
    bytes += size;
    tools.set(toolName, { tool, run });
  }
  return { tools, leftOut };
}

const failure = ({ code, message }: { code: string; message: string }) =>
  JSON.stringify({ error: { code, message } });

/** Run a function call through its slot: the result, or the refusal, as the function's output. */
export async function runTool(tools: Tools, name: string, args: string): Promise<Outcome> {
  const refused = (code: string, message: string) => ({
    output: failure({ code, message }),
    ok: false,
    code,
  });
  const found = tools.get(name);
  if (!found) return refused("unknown_tool", `No tool is named ${name.slice(0, 64)}.`);
  let input: unknown;
  try {
    input = args.trim() === "" ? {} : JSON.parse(args);
  } catch {
    return refused("invalid", "The arguments aren't JSON.");
  }
  try {
    return await found.run(input);
  } catch (error) {
    const { code, message } = codeOf(error);
    return refused(code, message);
  }
}
