/**
 * How the domain's operations look in MCP: an interface is a `Tool`, a call is a `tools/call`
 * whose `_meta` carries the call's id, caller and cause, a long-running call is an MCP task, and
 * an outcome or an answer is a `CallToolResult`.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Answer, InterfaceDescriptor, Offer, Outcome } from "../../domain/model/index.ts";

/** The endpoints' paths, and the channel's WebSocket subprotocol. */
export const PATHS = { request: "/mcp", channel: "/mcp/reverse" };
export const SUBPROTOCOL = "mcp";

/**
 * `_meta` key on a call. On a `tools/call` the core delivers to an actor it holds `DeliveredCall`.
 * On the result of a routed `tools/call` on `/mcp` it holds `CallReceipt`.
 */
export const CALL_META = "agentorg/call";

/** `_meta` key an actor sets on a `tools/call` to `/mcp`: the id of the call it is handling. */
export const CAUSE_META = "agentorg/cause";

export interface DeliveredCall {
  /** The call's id. Delivery is at least once, so a handler that sees an id again is seeing a repeat. */
  id: string;
  /** The calling actor's id. */
  from: string;
  /** The call that led to this one, if the caller named it. */
  cause: string | null;
}

export interface CallReceipt {
  id: string;
  state: "pending" | "done" | "failed" | "withdrawn";
}

/** What a routed call returns when it is still pending after the bounded wait. */
export const PENDING_OUTPUT = {
  type: "object",
  properties: { call: { type: "string" }, state: { const: "pending" } },
  required: ["call", "state"],
} as const;

const STRUCTURE = ["anyOf", "oneOf", "allOf", "$ref", "patternProperties"];

/** In MCP a one-way tool is one whose output schema is the empty object. */
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

/**
 * The output schema a caller sees for a routed tool: the tool's own, or the pending result, so
 * that a client checking results against it accepts both. Definitions move to the top, where the
 * tool's references to them still resolve.
 */
export function routedOutputSchema(output: Record<string, unknown>): Record<string, unknown> {
  const { $defs, definitions, $schema: _, ...own } = output;
  return {
    type: "object",
    ...($defs === undefined ? {} : { $defs }),
    ...(definitions === undefined ? {} : { definitions }),
    anyOf: [own, PENDING_OUTPUT],
  };
}

/** An actor's tool as the domain's interface; long-running when the actor's server takes tasks. */
export function interfaceOf(tool: Tool, takesTasks: boolean): InterfaceDescriptor {
  const support = tool.execution?.taskSupport;
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { output: tool.outputSchema }),
    one_way: isOneWay(tool.outputSchema),
    long_running: takesTasks && (support === "optional" || support === "required"),
  };
}

/** An interface an actor exposes, as its tool: a long-running one is always run as a task. */
export function exposedToolOf(exposed: InterfaceDescriptor): Tool {
  const { name, title, description, input, output, long_running } = exposed;
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: input as Tool["inputSchema"],
    ...(output === undefined ? {} : { outputSchema: output as Tool["outputSchema"] }),
    ...(long_running ? { execution: { taskSupport: "required" as const } } : {}),
  };
}

/** An interface offered to a caller, as its tool. The core answers it itself, with no tasks. */
export function offeredToolOf(offer: Offer): Tool {
  const { name, title, description, input, output } = offer.interface;
  const outputSchema = output && (offer.routed ? routedOutputSchema(output) : output);
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: input as Tool["inputSchema"],
    ...(outputSchema ? { outputSchema: outputSchema as Tool["outputSchema"] } : {}),
    ...(offer.read_only === undefined ? {} : { annotations: { readOnlyHint: offer.read_only } }),
  };
}

export const textOf = (result: CallToolResult) =>
  result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");

/** What an actor's tool returned, as the domain's outcome. */
export function outcomeOf(result: CallToolResult, name: string): Outcome {
  if (result.isError) return { ok: false, error: textOf(result) || `${name} returned an error` };
  return {
    ok: true,
    value: result.structuredContent ?? null,
    parts: result.content as Record<string, unknown>[],
  };
}

/** An outcome as a tool's result, from an actor's side. */
export function resultOfOutcome(outcome: Outcome): CallToolResult {
  if (!outcome.ok) return { content: [{ type: "text", text: outcome.error }], isError: true };
  const { value, parts } = outcome;
  return {
    content: (parts.length > 0 || value === null
      ? parts
      : [{ type: "text", text: JSON.stringify(value) }]) as CallToolResult["content"],
    ...(value === null || value === undefined
      ? {}
      : { structuredContent: value as Record<string, unknown> }),
  };
}

/** A caller's answer as its tool result on `/mcp`. */
export function resultOfAnswer(answer: Answer): CallToolResult {
  const text = (value: string) => [{ type: "text" as const, text: value }];
  if (answer.state === "refused") {
    return { content: text(`${answer.code}: ${answer.message}`), isError: true };
  }
  if (answer.call === undefined) {
    // A built-in: its value is the whole result.
    const value = (answer as { value: Record<string, unknown> }).value;
    return { content: text(JSON.stringify(value)), structuredContent: value };
  }
  const receipt: CallReceipt = { id: answer.call, state: answer.state };
  const _meta = { [CALL_META]: receipt };
  switch (answer.state) {
    case "done":
      return {
        content: (answer.parts ?? []) as CallToolResult["content"],
        ...(answer.value === null || answer.value === undefined
          ? {}
          : { structuredContent: answer.value as Record<string, unknown> }),
        _meta,
      };
    case "pending":
      return {
        content: text(`call ${answer.call} is pending; read it later with call_result`),
        structuredContent: { call: answer.call, state: "pending" },
        _meta,
      };
    case "failed":
      return { content: text(`failed: ${answer.error}`), isError: true, _meta };
    case "withdrawn":
      return { content: text(`call ${answer.call} was withdrawn`), isError: true, _meta };
  }
}

/** A tool result on `/mcp` as the caller's answer, from an actor's side. */
export function answerOfResult(result: CallToolResult): Answer {
  const receipt = result._meta?.[CALL_META] as CallReceipt | undefined;
  const text = textOf(result);
  if (receipt) {
    if (receipt.state === "done") {
      return {
        state: "done",
        call: receipt.id,
        value: result.structuredContent ?? null,
        parts: result.content as Record<string, unknown>[],
      };
    }
    if (receipt.state === "failed") {
      return { state: "failed", call: receipt.id, error: text.replace(/^failed: /, "") };
    }
    return { state: receipt.state, call: receipt.id };
  }
  if (result.isError) {
    const [, code = "error", message = text] = /^([a-z_]+): ([\s\S]*)$/.exec(text) ?? [];
    return { state: "refused", code, message };
  }
  return { state: "done", value: result.structuredContent ?? null };
}
