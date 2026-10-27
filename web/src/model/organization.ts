/**
 * The organization as the app shows it: the open agents as a tree under the user, and the path
 * from the user down to any agent.
 */

import type { AgentRecord, AgentSummary } from "../../../src/page/types.ts";

export interface OrgNode {
  summary: AgentSummary;
  children: OrgNode[];
}

/** The agents that are not closed, as a tree in the order given; one without a listed manager is a root. */
export function organization(agents: readonly AgentSummary[]): OrgNode[] {
  const open = agents.filter(({ agent }) => agent.state !== "closed");
  const nodes = new Map(open.map((summary) => [summary.agent.id, { summary, children: [] }]));
  const roots: OrgNode[] = [];
  for (const node of nodes.values()) {
    const manager = node.summary.agent.manager;
    const parent = manager === null ? undefined : nodes.get(manager);
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

/** The managers above an agent, outermost first; an unknown or cyclic manager ends the path. */
export function managers(id: string, agents: ReadonlyMap<string, AgentRecord>): AgentRecord[] {
  const above: AgentRecord[] = [];
  for (let next = agents.get(id)?.manager ?? null; next !== null; ) {
    const manager = agents.get(next);
    if (manager === undefined || above.includes(manager)) break;
    above.unshift(manager);
    next = manager.manager;
  }
  return above;
}
