/**
 * The wiring: whose exposed interfaces each actor may call, and under what names. By default an
 * actor reaches up and down one step: its manager's interfaces as `manager.<name>` and each direct
 * report's as `<handle>.<name>`. The root reaches every actor, under its path, as
 * `release.storage.review`. Lateral grants are deferred; when they come, they are one table the
 * root writes.
 */

import { type InterfaceDescriptor, MANAGER } from "./model/index.ts";
import type { ActorRow, Registry } from "./registry.ts";

export interface Route {
  /** The name the caller calls it by. */
  name: string;
  to: ActorRow;
  interface: InterfaceDescriptor;
}

/** Every interface the actor may call on other actors. */
export function routes(registry: Registry, actor: ActorRow): Route[] {
  const named = (prefix: string, to: ActorRow) =>
    to.interfaces.map((each) => ({ name: `${prefix}.${each.name}`, to, interface: each }));
  if (actor.manager === null) {
    return registry
      .open()
      .filter((each) => each.id !== actor.id)
      .flatMap((each) => named(registry.path(each), each));
  }
  const manager = registry.get(actor.manager);
  return [
    ...(manager ? named(MANAGER, manager) : []),
    ...registry.reports(actor.id).flatMap((report) => named(report.name, report)),
  ];
}

export function route(registry: Registry, actor: ActorRow, name: string): Route | undefined {
  return routes(registry, actor).find((each) => each.name === name);
}
