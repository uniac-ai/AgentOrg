/**
 * What the decisions page shows, built from the service's reads: what waits on the user, the
 * organization tree, and one agent in full. The routes build these models and the views render them.
 */

import type { z } from "zod";
import type { Agent, AgentDetail, AgentSummary, Ask, Message } from "../contract/index.ts";

export type AgentRecord = z.output<typeof Agent>;
export type AskRecord = z.output<typeof Ask>;
export type MessageRecord = z.output<typeof Message>;
export type Summary = z.output<typeof AgentSummary>;
export type Detail = z.output<typeof AgentDetail>;

/** An ask with the asks it carries up, each with the ones it carries. */
export interface Chain {
  ask: AskRecord;
  carries: Chain[];
}

/** Each ask's escalation chain, from the asks it can reach. An ask not among them is left out. */
export function chain(ask: AskRecord, asks: ReadonlyMap<string, AskRecord>): Chain {
  const carried = ask.escalates.flatMap((id) => asks.get(id) ?? []);
  return { ask, carries: carried.map((child) => chain(child, asks)) };
}

/** A note to the user waits until read; a report, until acknowledged. */
export function waitsOnUser(message: MessageRecord): boolean {
  if (message.to !== null) return false;
  return message.kind === "report" ? message.acknowledged_at === null : message.read_at === null;
}

export interface TreeNode {
  summary: Summary;
  children: TreeNode[];
}

/** The agents as a tree under the user, in the order given; an agent without a listed manager is a root. */
export function tree(agents: readonly Summary[]): TreeNode[] {
  const nodes = new Map(agents.map((summary) => [summary.agent.id, { summary, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const manager = node.summary.agent.manager;
    const parent = manager === null ? undefined : nodes.get(manager);
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

/** An answer the service refused, shown where it was given, with what the user had entered. */
export interface Refusal {
  /** The ask it was for, or `close` for closing the inspected agent. */
  target: string;
  message: string;
  choice?: string | undefined;
  words?: string | undefined;
}

/** What every page knows: the agents by id, for names and links, and the form token. */
export interface Context {
  agents: ReadonlyMap<string, AgentRecord>;
  csrfToken: string;
  /** An ask just answered, or an agent just closed, read back to confirm what the record holds. */
  settled?: AskRecord | AgentRecord | undefined;
  refusal?: Refusal | undefined;
}

export interface Decisions {
  asks: Chain[];
  messages: MessageRecord[];
  organization: TreeNode[];
}

export interface Inspection {
  detail: Detail;
  open: Chain[];
  settled: Chain[];
  /** The agents under it that are not closed; it closes only once there are none. */
  openChildren: AgentRecord[];
  confirmClose: boolean;
}

const byTime =
  <T>(at: (record: T) => string, direction: 1 | -1) =>
  (a: T, b: T) =>
    direction * at(a).localeCompare(at(b));

/** One agent's asks, both ways: open ones oldest first, then the rest newest first. */
export function inspection(
  detail: Detail,
  agents: readonly Summary[],
  confirmClose: boolean,
): Inspection {
  const asks = [...detail.own_asks, ...detail.addressed_asks];
  const byId = new Map(asks.map((ask) => [ask.id, ask]));
  const chains = (state: (ask: AskRecord) => boolean, direction: 1 | -1) =>
    asks
      .filter(state)
      .sort(byTime((ask: AskRecord) => ask.opened_at, direction))
      .map((ask) => chain(ask, byId));
  return {
    detail,
    open: chains((ask) => ask.state === "open", 1),
    settled: chains((ask) => ask.state !== "open", -1),
    openChildren: agents
      .map((summary) => summary.agent)
      .filter((agent) => agent.manager === detail.agent.id && agent.state !== "closed"),
    confirmClose,
  };
}

/** Messages to the user still waiting on them, oldest first. */
export function messagesToUser(details: readonly Detail[]): MessageRecord[] {
  return details
    .flatMap((detail) => detail.messages.filter(waitsOnUser))
    .sort(byTime((message: MessageRecord) => message.sent_at, 1));
}
