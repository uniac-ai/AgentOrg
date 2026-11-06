/**
 * The assistant's tools: every method of each bound slot, apart from its model and store, as a
 * function tool named `<slot>__<method>` whose parameters are the method's input JSON Schema, the
 * schema the Hub checks the call against. A call runs through the slot, so the Hub checks and
 * audits it like any other.
 */
import type { Tool } from "@agentorg/interfaces";
import { type DescribedInterface, NotConnected, OutcomeUnknown, Refused } from "@agentorg/sdk";
import type { z } from "zod";

export interface ToolSlot {
  readonly bound: boolean;
  readonly call: Readonly<Record<string, (input: never) => Promise<unknown>>>;
}
interface Found {
  tool: z.input<typeof Tool>;
  slot: ToolSlot;
  method: string;
}
export type Tools = Map<string, Found>;

/** A function's output is cut to this many bytes of UTF-8, so one result can't fill a request. */
export const MAX_OUTPUT = 16 * 1024;
const encoder = new TextEncoder();

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

/** The tools the bound slots give right now, by name. */
export function toolsOf(slots: Record<string, { described: DescribedInterface; slot: ToolSlot }>) {
  const tools: Tools = new Map();
  for (const [name, { described, slot }] of Object.entries(slots)) {
    if (!slot.bound || described.kind !== "rpc") continue;
    for (const [method, { input }] of Object.entries(described.methods)) {
      const tool = {
        name: `${name}__${method}`,
        description: `${method} on ${name} (${described.id})`,
        // A described schema is JSON by construction.
        parameters: input as Record<string, z.core.util.JSONType>,
      };
      tools.set(tool.name, { tool, slot, method });
    }
  }
  return tools;
}

const failure = ({ code, message }: { code: string; message: string }) =>
  JSON.stringify({ error: { code, message } });

/** Run a function call through its slot: the result, or the refusal, as the function's output. */
export async function runTool(
  tools: Tools,
  name: string,
  args: string,
): Promise<{ output: string; ok: boolean; code?: string }> {
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
    const call = found.slot.call[found.method] as (input: unknown) => Promise<unknown>;
    return { output: JSON.stringify((await call(input)) ?? {}), ok: true };
  } catch (error) {
    const { code, message } = codeOf(error);
    return refused(code, message);
  }
}
