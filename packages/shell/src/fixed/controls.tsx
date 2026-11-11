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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { type AgentEntry, useAct } from "./data.ts";

export function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** What's rarely wanted of an agent, one step away: stopping it. */
export function More({ agent, onFailed }: { agent: AgentEntry; onFailed(why?: string): void }) {
  const stop = useAct(onFailed);
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
        <DropdownMenuItem
          disabled={agent.status.state !== "running"}
          onSelect={() => stop.run(() => api.call("agents", "stop", { agent: agent.agent }))}
        >
          Stop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
