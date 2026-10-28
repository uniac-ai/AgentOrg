// The organization below a position, control: its totals by state, the members that changed
// lately, and its reports as a chart, each with what waits on it and what of its waits on the
// user. The user's page and every actor's page show it under their own content.

import type { Member } from "../model/organization.ts";
import { flatten, type Organization, openQuestions } from "../model/organization.ts";
import { type Counts, isStale, recentlyChanged, rollup, total, totals } from "../model/progress.ts";

export interface ChartNode {
  member: Member;
  /** Open questions waiting on it. */
  waiting: number;
  /** Its subtree by state, when it has actors under it. */
  rollup: Counts | undefined;
  stale: boolean;
  /** Its open questions waiting on the user. */
  waitingOnYou: number;
  children: ChartNode[];
}

export interface BelowModel {
  totals: Counts;
  recent: Member[];
  chart: ChartNode[];
}

export function belowOf(member: Member, organization: Organization): BelowModel {
  const now = Date.now();
  const open = openQuestions(organization);
  const root = organization.root.id;
  const build = (nodes: Member[]): ChartNode[] =>
    nodes.map((node) => {
      const counts = rollup(node);
      return {
        member: node,
        waiting: open.filter((question) => question.to === node.id).length,
        rollup: total(counts) > 0 ? counts : undefined,
        stale: isStale(node, now),
        waitingOnYou: node.questions.filter((question) => question.to === root).length,
        children: build(node.reports),
      };
    });
  const everyone = flatten(member.reports);
  return {
    totals: totals(everyone),
    recent: recentlyChanged(everyone),
    chart: build(member.reports),
  };
}
