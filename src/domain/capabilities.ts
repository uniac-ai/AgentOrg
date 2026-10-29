/** One projection of built-ins and actor routes, shared by listing, dispatch and team views. */

import type { Connections } from "./connections.ts";
import {
  BUILTIN_NAMES,
  BUILTINS,
  type BuiltinName,
  MANAGER,
  type Offer,
  objectSchema,
} from "./model/index.ts";
import type { ActorRow, Registry } from "./registry.ts";

export type Capability = { offer: Offer } & (
  | { builtin: BuiltinName }
  | { to: string; interface: string }
);

const BUILTIN_CAPABILITIES: Capability[] = BUILTIN_NAMES.map((name) => ({
  builtin: name,
  offer: {
    interface: {
      name,
      description: BUILTINS[name].description,
      input: objectSchema(BUILTINS[name].request, "input"),
      output: objectSchema(BUILTINS[name].response, "output"),
      one_way: false,
      long_running: false,
    },
    routed: false,
    read_only: !BUILTINS[name].writes,
  },
}));

export function capabilities(registry: Registry, connections: Pick<Connections, "interfaces">) {
  return {
    list(actor: ActorRow): Capability[] {
      const named = (prefix: string, to: ActorRow): Capability[] =>
        connections.interfaces(to.id).map((each) => ({
          to: to.id,
          interface: each.name,
          offer: { interface: { ...each, name: `${prefix}.${each.name}` }, routed: true },
        }));
      const manager = actor.manager === null ? undefined : registry.get(actor.manager);
      const routed =
        actor.manager === null
          ? registry
              .open()
              .filter((each) => each.id !== actor.id)
              .flatMap((each) => named(registry.path(each), each))
          : [
              ...(manager ? named(MANAGER, manager) : []),
              ...registry.reports(actor.id).flatMap((report) => named(report.name, report)),
            ];
      const own = BUILTIN_CAPABILITIES.filter(
        (each) => "builtin" in each && (!BUILTINS[each.builtin].rootOnly || actor.manager === null),
      );
      return [...own, ...routed];
    },
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
