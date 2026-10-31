/** Semantic Hub Tools and operation results at the MCP boundary. */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Answer, Id, INTERFACE_NAME, type ToolDescriptor } from "../../domain/model/index.ts";

const TOOL_META = "agentorg/tool";
const ToolMetadata = z.strictObject({
  id: Id,
  name: z.string().min(1),
  interface: z.string().regex(INTERFACE_NAME),
  one_way: z.boolean(),
  long_running: z.boolean(),
});

/** Flatten explicit Hub Tools for MCP while retaining their identity and local names. */
export function offeredToolsOf(catalog: ToolDescriptor[]): Tool[] {
  return catalog.flatMap((tool) =>
    tool.interfaces.map((offer) => {
      const { name, title, description, input, output, one_way, long_running } = offer.interface;
      return {
        name: offer.call,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        inputSchema: input as Tool["inputSchema"],
        ...(output === undefined ? {} : { outputSchema: output as Tool["outputSchema"] }),
        ...(offer.read_only === undefined
          ? {}
          : { annotations: { readOnlyHint: offer.read_only } }),
        _meta: {
          [TOOL_META]: { id: tool.id, name: tool.name, interface: name, one_way, long_running },
        },
      };
    }),
  );
}

/** Reconstruct the Hub catalog from explicit metadata, without inferring identities from aliases. */
export function catalogOf(tools: Tool[]): ToolDescriptor[] {
  const catalog = new Map<string, ToolDescriptor>();
  const calls = new Set<string>();
  for (const tool of tools) {
    const parsed = ToolMetadata.safeParse(tool._meta?.[TOOL_META]);
    if (!parsed.success) throw new Error("invalid Hub Tool catalog metadata");
    const meta = parsed.data;
    const group = catalog.get(meta.id) ?? { id: meta.id, name: meta.name, interfaces: [] };
    if (
      group.name !== meta.name ||
      calls.has(tool.name) ||
      group.interfaces.some((each) => each.interface.name === meta.interface)
    ) {
      throw new Error("inconsistent Hub Tool catalog metadata");
    }
    const readOnly = tool.annotations?.readOnlyHint;
    group.interfaces.push({
      call: tool.name,
      interface: {
        name: meta.interface,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        input: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { output: tool.outputSchema }),
        one_way: meta.one_way,
        long_running: meta.long_running,
      },
      ...(readOnly === undefined ? {} : { read_only: readOnly }),
    });
    catalog.set(meta.id, group);
    calls.add(tool.name);
  }
  return [...catalog.values()];
}

export const textOf = (result: CallToolResult) =>
  result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");

export function resultOfAnswer(answer: Answer): CallToolResult {
  if (answer.state === "refused") {
    return {
      content: [{ type: "text", text: `${answer.code}: ${answer.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(answer.value) }],
    structuredContent: answer.value as Record<string, unknown>,
  };
}

export function answerOfResult(result: CallToolResult): Answer {
  if (result.isError) {
    const text = textOf(result);
    const [, code = "error", message = text] = /^([a-z_]+): ([\s\S]*)$/.exec(text) ?? [];
    return { state: "refused", code, message };
  }
  return { state: "done", value: result.structuredContent ?? null };
}
