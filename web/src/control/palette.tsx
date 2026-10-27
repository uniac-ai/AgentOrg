// ⌘K (or Ctrl+K), control: jump to a view, an agent or an open ask. An ask opens where it
// waits: in the user's own pane when it is addressed to the user, else in its addressee's pane.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useKeys } from "@/lib/keys";
import type { AgentRecord, AskRecord } from "../../../src/page/types.ts";
import { agentsQuery, openAsksQuery } from "../data/queries.ts";
import { PaletteView } from "../views/palette.tsx";

export type Destination = "/" | "/inbox" | "/activity";

export interface PaletteModel {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentRecord[];
  asks: AskRecord[];
  byId: ReadonlyMap<string, AgentRecord>;
  onView: (to: Destination) => void;
  onAgent: (agent: AgentRecord) => void;
  onAsk: (ask: AskRecord) => void;
}

export function PaletteControl() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const agents = useQuery(agentsQuery);
  const asks = useQuery(openAsksQuery);
  useKeys((event) => {
    if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return false;
    setOpen((current) => !current);
    return true;
  });
  const go = (to: () => Promise<void>) => {
    setOpen(false);
    void to();
  };
  const all = agents.data?.agents.map(({ agent }) => agent) ?? [];
  const model: PaletteModel = {
    open,
    onOpenChange: setOpen,
    agents: all.filter((agent) => agent.state !== "closed"),
    asks: asks.data?.asks ?? [],
    byId: new Map(all.map((agent) => [agent.id, agent])),
    onView: (to) => go(() => navigate({ to })),
    onAgent: (agent) =>
      go(() => navigate({ to: "/people/$agentId", params: { agentId: agent.id } })),
    onAsk: (ask) =>
      go(() =>
        ask.to === null
          ? navigate({ to: "/inbox/asks/$askId", params: { askId: ask.id } })
          : navigate({
              to: "/people/$agentId/asks/$askId",
              params: { agentId: ask.to, askId: ask.id },
            }),
      ),
  };
  return <PaletteView {...model} />;
}
