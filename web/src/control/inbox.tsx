// The inbox's control: what waits on the user, with each item's sender.

import { useQuery } from "@tanstack/react-query";
import type { AgentRecord, AskRecord, MessageRecord } from "../../../src/page/types.ts";
import { agentsQuery, inboxQuery } from "../data/queries.ts";
import { InboxView } from "../views/inbox.tsx";
import { PaneSkeleton } from "../views/states.tsx";

export type InboxEntry =
  | { kind: "ask"; ask: AskRecord; from: AgentRecord | undefined; at: string }
  | { kind: "message"; message: MessageRecord; from: AgentRecord | undefined; at: string };

export interface InboxModel {
  /** Oldest first: asks and messages together, in the order they arrived. */
  entries: InboxEntry[];
}

export function InboxControl() {
  const inbox = useQuery(inboxQuery);
  const agents = useQuery(agentsQuery);
  if (!inbox.data) return <PaneSkeleton />;
  const byId = new Map(agents.data?.agents.map(({ agent }) => [agent.id, agent]));
  const entries: InboxEntry[] = [
    ...inbox.data.asks.map((ask) => ({
      kind: "ask" as const,
      ask,
      from: byId.get(ask.agent),
      at: ask.opened_at,
    })),
    ...inbox.data.messages.map((message) => ({
      kind: "message" as const,
      message,
      from: byId.get(message.from),
      at: message.sent_at,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return <InboxView entries={entries} />;
}
