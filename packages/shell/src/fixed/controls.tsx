// What can be done to an agent, wherever it's shown.
import { MoreHorizontalIcon } from "lucide-react";
import { api } from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { type AgentEntry, useAct } from "./data.ts";

/**
 * What's rarely wanted of an agent, one step away: stopping it, or, while it isn't running,
 * starting it in Stop's place.
 */
export function More({ agent, onFailed }: { agent: AgentEntry; onFailed(why?: string): void }) {
  const act = useAct(onFailed);
  const off = agent.status.state === "stopped" || agent.status.state === "down";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          className="size-10 rounded-full"
          aria-label={`More for ${agent.name}`}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {off ? (
          <DropdownMenuItem
            disabled={act.busy}
            onSelect={() => act.run(() => api.call("agents", "start", { agent: agent.agent }))}
          >
            Start
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={agent.status.state !== "running"}
            onSelect={() => act.run(() => api.call("agents", "stop", { agent: agent.agent }))}
          >
            Stop
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
