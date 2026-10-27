// An agent's pane, control: the agent in full, read from the service.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { AgentFull } from "../../../src/page/types.ts";
import { ApiError } from "../data/client.ts";
import { agentQuery } from "../data/queries.ts";
import { AgentView } from "../views/agent.tsx";
import { NotFoundView, PaneSkeleton } from "../views/states.tsx";

export interface AgentModel {
  detail: AgentFull;
}

export function AgentControl() {
  const { agentId } = useParams({ from: "/people/$agentId" });
  const agent = useQuery(agentQuery(agentId));
  if (agent.error instanceof ApiError && agent.error.status === 404) return <NotFoundView />;
  if (!agent.data) return <PaneSkeleton />;
  return <AgentView detail={agent.data} />;
}
