/**
 * The organization as the app shows it: the views of the root and every open actor under it, as a
 * tree of reports, and the path from the root down to any actor.
 */

import type { ActorRecord, CallRecord, ViewRecord } from "../../../src/human/types.ts";

/** Every open actor's view, by actor id, from the root down. */
export interface Organization {
  root: string;
  views: Record<string, ViewRecord>;
}

export interface OrgNode {
  view: ViewRecord;
  children: OrgNode[];
}

/** The actors under `id` as a tree, in the order their views list them; the root's is everyone. */
export function tree(organization: Organization, id = organization.root): OrgNode[] {
  return (organization.views[id]?.reports ?? []).flatMap((report) => {
    const view = organization.views[report.id];
    return view ? [{ view, children: tree(organization, report.id) }] : [];
  });
}

/** Every actor the organization's views show, by id. */
export function actors(organization: Organization): Map<string, ActorRecord> {
  const all = new Map<string, ActorRecord>();
  for (const view of Object.values(organization.views)) {
    for (const actor of [view.actor, ...(view.manager ? [view.manager] : []), ...view.reports]) {
      if (!all.has(actor.id)) all.set(actor.id, actor);
    }
  }
  return all;
}

/** Every call the organization's views show, by id. */
export function calls(organization: Organization): Map<string, CallRecord> {
  const all = new Map<string, CallRecord>();
  for (const view of Object.values(organization.views)) {
    for (const call of [...view.pending, ...view.open_calls, ...view.history])
      all.set(call.id, call);
  }
  return all;
}

/** The managers above an actor, outermost first, without the root; an unknown one ends the path. */
export function managers(id: string, known: ReadonlyMap<string, ActorRecord>): ActorRecord[] {
  const above: ActorRecord[] = [];
  for (let next = known.get(id)?.manager ?? null; next !== null; ) {
    const manager = known.get(next);
    if (manager === undefined || manager.manager === null || above.includes(manager)) break;
    above.unshift(manager);
    next = manager.manager;
  }
  return above;
}

/** Every actor in a tree, in order. */
export const flatten = (nodes: OrgNode[]): ActorRecord[] =>
  nodes.flatMap((node) => [node.view.actor, ...flatten(node.children)]);
