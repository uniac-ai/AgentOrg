/** Bind each feature's interface contracts to its own operations, before core composition. */

import type { z } from "zod";
import type { BuiltinSpec, ToolDescriptor } from "./model/index.ts";
import type { ActorRow, Waiting } from "./ports.ts";

export interface Operation {
  name: string;
  definition: BuiltinSpec;
  invoke(actor: ActorRow, input: unknown, context: Waiting): unknown;
}

export interface FeatureTool extends Pick<ToolDescriptor, "id" | "name"> {
  interfaces: Operation[];
}

type Handlers<S extends Record<string, BuiltinSpec>> = {
  [N in keyof S]: (
    actor: ActorRow,
    request: z.output<S[N]["request"]>,
    context: Waiting,
  ) => z.output<S[N]["response"]> | Promise<z.output<S[N]["response"]>>;
};

export function bindTool<const S extends Record<string, BuiltinSpec>>(
  definition: Pick<FeatureTool, "id" | "name"> & { interfaces: S },
  handlers: Handlers<S>,
): FeatureTool {
  return {
    id: definition.id,
    name: definition.name,
    interfaces: Object.entries(definition.interfaces).map(([name, spec]) => ({
      name,
      definition: spec,
      invoke: handlers[name] as Operation["invoke"],
    })),
  };
}
