/**
 * The wiring: whose exposed tools each actor may call, and under what names. By default an actor
 * reaches up and down one step: its manager's tools as `manager.<tool>` and each direct report's as
 * `<handle>.<tool>`. The root reaches every actor, under its path, as `release.storage.review`.
 * Lateral grants are deferred; when they come, they are one table the root writes.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MANAGER } from "../protocol/index.ts";
import type { ActorRecord, Registry } from "./registry.ts";

export type { Tool };

export interface Route {
  /** The name the caller calls it by. */
  name: string;
  to: ActorRecord;
  tool: Tool;
}

/** Every tool the actor may call on other actors. */
export function routes(registry: Registry, actor: ActorRecord): Route[] {
  const named = (prefix: string, to: ActorRecord) =>
    (to.tools as Tool[]).map((tool) => ({ name: `${prefix}.${tool.name}`, to, tool }));
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

export function route(registry: Registry, actor: ActorRecord, name: string): Route | undefined {
  return routes(registry, actor).find((each) => each.name === name);
}
