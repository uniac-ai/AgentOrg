// The user's own pane, control: everything waiting on the user, the ask open beside it, and the
// writes that settle a message.

import { useQuery } from "@tanstack/react-query";
import { Outlet, useParams } from "@tanstack/react-router";
import { useRowKeys } from "@/lib/keys";
import type { AgentRecord, AskRecord, MessageRecord } from "../../../src/page/types.ts";
import { useAcknowledge, useMarkRead } from "../data/mutations.ts";
import { agentsQuery, inboxQuery } from "../data/queries.ts";
import { InboxView } from "../views/inbox.tsx";
import { notices } from "../views/notices.ts";
import { PaneSkeleton } from "../views/states.tsx";

export type InboxEntry =
  | { kind: "ask"; ask: AskRecord; from: AgentRecord | undefined; at: string }
  | { kind: "message"; message: MessageRecord; from: AgentRecord | undefined; at: string };

export interface InboxModel {
  /** Oldest first: asks and messages together, in the order they arrived. */
  entries: InboxEntry[];
  /** The ask open in the thread beside the list. */
  openAsk: string | undefined;
  onAcknowledge: (message: MessageRecord) => void;
  onMarkRead: (message: MessageRecord) => void;
  thread: React.ReactNode;
}

export function InboxControl() {
  const inbox = useQuery(inboxQuery);
  const agents = useQuery(agentsQuery);
  const { askId } = useParams({ strict: false });
  const acknowledge = useAcknowledge();
  const markRead = useMarkRead();
  useRowKeys();
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
  const model: InboxModel = {
    entries,
    openAsk: askId,
    onAcknowledge: (message) =>
      acknowledge.mutate(message.id, {
        onSuccess: () => notices.acknowledged(message),
        onError: notices.refused,
      }),
    onMarkRead: (message) =>
      markRead.mutate(message.id, {
        onSuccess: () => notices.read(message),
        onError: notices.refused,
      }),
    thread: askId ? <Outlet /> : null,
  };
  return <InboxView {...model} />;
}
