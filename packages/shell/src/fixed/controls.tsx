// What can be done to an agent, wherever it's shown.
import { MoreHorizontalIcon } from "lucide-react";
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

/** What's rarely wanted of an agent, one step away: stopping it, and deleting it after asking. */
export function More({ agent, onFailed }: { agent: AgentEntry; onFailed(why?: string): void }) {
  const [deleting, setDeleting] = useState(false);
  const act = useAct();
  const stop = useAct(onFailed);
  const { state } = agent.status;
  return (
    <>
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
            disabled={state !== "running"}
            onSelect={() => stop.run(() => api.call("agents", "stop", { agent: agent.agent }))}
          >
            Stop
          </DropdownMenuItem>
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
