/**
 * Progress at a glance: counts by state for the whole organization and for every manager's
 * subtree, which agents changed most recently, and which running ones have gone quiet.
 */

import type { AgentSummary } from "../../../src/page/types.ts";
import { PROGRESS_STATES, type ProgressState, progressState } from "./state.ts";

export type Counts = Record<ProgressState, number>;

const zero = (): Counts => Object.fromEntries(PROGRESS_STATES.map((state) => [state, 0])) as Counts;

export const total = (counts: Counts) =>
  PROGRESS_STATES.reduce((sum, state) => sum + counts[state], 0);

/** The whole organization, closed agents included, counted by state. */
export function totals(agents: readonly AgentSummary[]): Counts {
  const counts = zero();
  for (const { agent } of agents) counts[progressState(agent)] += 1;
  return counts;
}

/** Every agent's subtree, all its descendants with closed ones included, counted by state. */
export function rollups(agents: readonly AgentSummary[]): Map<string, Counts> {
  const children = new Map<string, AgentSummary[]>();
  for (const summary of agents) {
    const manager = summary.agent.manager;
    if (manager !== null) children.set(manager, [...(children.get(manager) ?? []), summary]);
  }
  const counted = new Map<string, Counts>();
  const count = (id: string): Counts => {
    const known = counted.get(id);
    if (known) return known;
    const counts = zero();
    counted.set(id, counts);
    for (const child of children.get(id) ?? []) {
      counts[progressState(child.agent)] += 1;
      const below = count(child.agent.id);
      for (const state of PROGRESS_STATES) counts[state] += below[state];
    }
    return counts;
  };
  for (const { agent } of agents) count(agent.id);
  return counted;
}

/** How long a running agent may go without a write from its sessions before it counts as stale. */
export const STALE_AFTER_MS = 60 * 60_000;

/** A running agent whose sessions have written nothing for a while: it says it works, but is quiet. */
export function isStale(summary: AgentSummary, now: number = Date.now()): boolean {
  return (
    progressState(summary.agent) === "running" &&
    now - Date.parse(summary.last_activity_at) > STALE_AFTER_MS
  );
}

/** The agents whose status changed most recently, newest first. */
export function recentlyChanged(agents: readonly AgentSummary[], limit = 5): AgentSummary[] {
  const at = (summary: AgentSummary) => summary.agent.status?.updated_at ?? "";
  return agents
    .filter((summary) => summary.agent.status !== null && summary.agent.state !== "closed")
    .sort((a, b) => at(b).localeCompare(at(a)))
    .slice(0, limit);
}
