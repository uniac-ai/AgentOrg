/** Actor-relative Tools shared by listing, dispatch and team views, with private destinations. */

import type { Connections } from "./connections.ts";
import { MANAGER, objectSchema, type ToolDescriptor } from "./model/index.ts";
import type { ActorRow, Registry } from "./registry.ts";
import type { FeatureTool, Operation } from "./tools.ts";

export type Capability = { offer: ToolDescriptor["interfaces"][number] } & (
  | { operation: Operation }
  | { to: string }
);
interface ToolExposure extends Pick<ToolDescriptor, "id" | "name"> {
  interfaces: Capability[];
}

export function descriptorsOf(tools: ToolExposure[]): ToolDescriptor[] {
  return tools.map(({ id, name, interfaces }) => ({
    id,
    name,
    interfaces: interfaces.map((each) => each.offer),
  }));
}

export function capabilities(
  registry: Registry,
  connections: Pick<Connections, "interfaces">,
  tools: FeatureTool[],
) {
  const builtins: ToolExposure[] = tools.map((tool) => ({
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
        routed: false,
        read_only: !operation.definition.writes,
      },
    })),
  }));
  return {
    known: (name: string) =>
      tools.some((tool) => tool.interfaces.some((each) => each.name === name)),
    list(actor: ActorRow): ToolExposure[] {
      if (actor.closed_at !== null) return [];
      const named = (name: string, to: ActorRow): ToolExposure => ({
        id: to.id,
        name,
        interfaces: connections.interfaces(to.id).map((each) => ({
          to: to.id,
          offer: { interface: each, call: `${name}.${each.name}`, routed: true },
        })),
      });
      const manager = actor.manager === null ? undefined : registry.get(actor.manager);
      const routed =
        actor.manager === null
          ? registry
              .open()
              .filter((each) => each.id !== actor.id)
              .map((each) => named(registry.path(each), each))
          : [
              ...(manager ? [named(MANAGER, manager)] : []),
              ...registry.reports(actor.id).map((report) => named(report.name, report)),
            ];
      return [...builtins, ...routed].filter((tool) => tool.interfaces.length > 0);
    },
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
