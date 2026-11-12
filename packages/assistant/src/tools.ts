/**
 * The assistant's tools, gathered afresh for each model request. A `tools@1` slot gives whatever
 * it lists now, with its server's own input schemas. Each is offered as
 * `<slot>__<name>`, and a call runs through the slot, so the Hub checks and audits it like any
 * other.
 */
import { type ToolEntry, tools as toolsInterface } from "@agentorg/interfaces";
import { type Outcome, Refusal, type Tool } from "@agentorg/looper";
import {
  type DescribedInterface,
  describeInterface,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "@agentorg/sdk";
import type { z } from "zod";

/** A tool as its slot gives it, before it has the name a request offers it under. */
export interface Candidate {
  slot: string;
  name: string;
  description?: string;
  parameters: Record<string, z.core.util.JSONType>;
  run(input: unknown): Promise<Outcome>;
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

/**
 * What a request can carry of the agent's tools: one fewer than a request's count, since the
 * looper offers one function of its own beside them; and, with the record and instructions, one
 * frame.
 */
export const MAX_TOOLS = 127;
export const TOOLS_BUDGET = 256 * 1024;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const encoder = new TextEncoder();
const TOOLS_ID = describeInterface(toolsInterface).id;

/** The first `length` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function head(text: string, length: number): string {
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The code and message of what a call through a slot threw. */
export function codeOf(error: unknown): { code: string; message: string } {
  if (error instanceof Refused) return { code: error.code, message: error.message };
  if (error instanceof NotConnected)
    return { code: "not_connected", message: `${error.target} is not connected.` };
  if (error instanceof OutcomeUnknown) return { code: "outcome_unknown", message: error.message };
  return { code: "failed", message: "The call failed." };
}

/**
 * A call through a slot, as the looper is told how it went: what the slot refuses is the looper's
 * `Refusal`, with the code to show and the slot's own error as its cause.
 */
export const relayed = <T>(call: Promise<T>): Promise<T> =>
  call.catch((error: unknown) => {
    const { code, message } = codeOf(error);
    throw code === "failed" && !(error instanceof Refused)
      ? error
      : new Refusal(code, message, { cause: error });
  });

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
export function offered(candidates: Candidate[]): { tools: Tool[]; leftOut: LeftOut[] } {
  const tools = new Map<string, Tool>();
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
    tools.set(toolName, { ...tool, run: (input) => relayed(run(input)) });
  }
  return { tools: [...tools.values()], leftOut };
}
