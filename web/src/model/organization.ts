/**
 * The organization as the app shows it, from the root's `team`: each position with its reports,
 * every member by id, the path from the root down to any actor, and every open question in it.
 */

import type { Builtins, PositionRecord, QuestionRecord } from "../../../src/clients/web/types.ts";

/** A position, with the reports `team` listed after it. */
export type Member = PositionRecord & { reports: Member[] };

export interface Organization {
  /** The root, the user, with everyone under it. */
  root: Member;
  /** Every member, the root included, by actor id. */
  members: ReadonlyMap<string, Member>;
}

/** The organization from a `team` read that starts at the root, each report under its manager. */
export function organizationOf(team: Builtins["team"]["result"]): Organization {
  const members = new Map<string, Member>(
    team.positions.map((position) => [position.id, { ...position, reports: [] }]),
  );
  for (const member of members.values()) {
    const manager = member.manager === null ? undefined : members.get(member.manager);
    manager?.reports.push(member);
  }
  const root = members.get(team.root);
  if (root === undefined) throw new Error("the team does not start at the root");
  return { root, members };
}

/** Every member in a tree, in order. */
export const flatten = (nodes: readonly Member[]): Member[] =>
  nodes.flatMap((node) => [node, ...flatten(node.reports)]);

/** The managers above an actor, outermost first, without the root; an unknown one ends the path. */
export function managers(id: string, members: Organization["members"]): Member[] {
  const above: Member[] = [];
  for (let next = members.get(id)?.manager ?? null; next !== null; ) {
    const manager = members.get(next);
    if (manager === undefined || manager.manager === null || above.includes(manager)) break;
    above.unshift(manager);
    next = manager.manager;
  }
  return above;
}

/** Every open question in the organization, oldest first. */
export const openQuestions = (organization: Organization): QuestionRecord[] =>
  [...organization.members.values()]
    .flatMap((member) => member.questions)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

/** The open questions that wait on an actor, as their addressee. */
export const waitingOn = (id: string, organization: Organization): QuestionRecord[] =>
  openQuestions(organization).filter((question) => question.to === id);
