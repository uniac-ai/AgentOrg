// What can be done to an agent, wherever it's shown.
import { MoreHorizontalIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { api, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
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

/** Start or Stop, whichever applies: the two share a place, so nothing moves. */
export function Power({ agent, onFailed }: { agent: AgentEntry; onFailed(why?: string): void }) {
  const act = useAct((why) => onFailed(why));
  const off = agent.status.state === "stopped" || agent.status.state === "down";
  const word = off ? "Start" : "Stop";
  return (
    <Tip label={word}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${word} ${agent.name}`}
        disabled={act.busy || agent.status.state === "starting"}
        onClick={() =>
          act.run(() => api.call("agents", off ? "start" : "stop", { agent: agent.agent }))
        }
      >
        {off ? <PlayIcon /> : <SquareIcon />}
      </Button>
    </Tip>
  );
}

/** Its menu: Delete, after asking. */
export function More({ agent }: { agent: AgentEntry }) {
  const [deleting, setDeleting] = useState(false);
  const act = useAct();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`${agent.name} options`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent showCloseButton={false} className="window ring-0 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {agent.name}?</DialogTitle>
            <DialogDescription>
              Its chat and what was created for it go with it. Connections you made and your skills
              stay. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          {act.failed && (
            <p role="alert" className="text-[13px] text-[var(--bad)]">
              {act.failed}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={act.busy}
              onClick={() =>
                act.run(
                  () => api.call("agents", "remove", { agent: agent.agent }),
                  () => {
                    setDeleting(false);
                    go({ screen: "home" });
                  },
                )
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
