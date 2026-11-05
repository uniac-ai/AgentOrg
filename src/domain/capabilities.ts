/** Explicit Hub Tools shared by discovery and invocation, with operations kept private. */

import { objectSchema, type ToolDescriptor } from "./model/index.ts";
import type { FeatureTool, Operation } from "./tools.ts";

interface ToolExposure extends Pick<ToolDescriptor, "id" | "name"> {
  interfaces: { operation: Operation; offer: ToolDescriptor["interfaces"][number] }[];
}

export function descriptorsOf(tools: ToolExposure[]): ToolDescriptor[] {
  return tools.map(({ id, name, interfaces }) => ({
    id,
    name,
    interfaces: interfaces.map((each) => each.offer),
  }));
}

export function capabilities(tools: FeatureTool[]) {
  const exposed: ToolExposure[] = tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    interfaces: tool.interfaces.map((operation) => ({
      operation,
      offer: {
        call: operation.name,
        interface: {
          name: operation.name,
          description: operation.definition.description,
          input: objectSchema(operation.definition.request, "input"),
          output: objectSchema(operation.definition.response, "output"),
          one_way: false,
          long_running: false,
        },
        read_only: !operation.definition.writes,
      },
    })),
  }));
  return { list: () => exposed };
}

export type Capabilities = ReturnType<typeof capabilities>;
