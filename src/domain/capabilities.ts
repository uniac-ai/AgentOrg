/** Actor-relative Tools shared by listing, dispatch and team views, with private destinations. */

import type { Connections } from "./connections.ts";
import {
  BUILTIN_NAMES,
  BUILTINS,
  type BuiltinName,
  MANAGER,
  objectSchema,
  type ToolDescriptor,
} from "./model/index.ts";
import type { ActorRow, Registry } from "./registry.ts";

export type Capability = { offer: ToolDescriptor["interfaces"][number] } & (
  | { builtin: BuiltinName }
  | { to: string }
);
interface ToolExposure extends Pick<ToolDescriptor, "id" | "name"> {
  interfaces: Capability[];
}

const builtins = new Map<string, ToolExposure>();
for (const name of BUILTIN_NAMES) {
  const spec = BUILTINS[name];
  const tool = builtins.get(spec.tool) ?? {
    id: `hub:${spec.tool}`,
    name: spec.tool,
    interfaces: [],
  };
  tool.interfaces.push({
    builtin: name,
    offer: {
      call: name,
      interface: {
        name,
        description: spec.description,
        input: objectSchema(spec.request, "input"),
        output: objectSchema(spec.response, "output"),
        one_way: false,
        long_running: false,
      },
      routed: false,
      read_only: !spec.writes,
    },
  });
  builtins.set(spec.tool, tool);
}

export function capabilities(registry: Registry, connections: Pick<Connections, "interfaces">) {
  return {
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
      const own = [...builtins.values()].map((tool) => ({
        ...tool,
        interfaces: tool.interfaces.filter(
          (each) =>
            "builtin" in each && (!BUILTINS[each.builtin].rootOnly || actor.manager === null),
        ),
      }));
      return [...own, ...routed].filter((tool) => tool.interfaces.length > 0);
    },
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
