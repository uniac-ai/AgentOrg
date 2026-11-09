import { TrashIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { useAct } from "./data.ts";

/** Who loses something if it goes, in a sentence. */
function losers(names: readonly string[]): string {
  if (names.length === 0) return "Nothing uses it.";
  if (names.length === 1) return `${names[0]} loses it.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} lose it.`;
}

/** A row's Delete: it asks first, and says which agents lose the thing. */
export function DeleteButton({
  name,
  agents,
  onDelete,
  onDeleted,
}: {
  name: string;
  agents: readonly string[];
  onDelete(): Promise<unknown>;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(false);
  const act = useAct();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete ${name}`}
        className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={() => setOpen(true)}
      >
        <TrashIcon />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="window ring-0 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>{losers(agents)} This can't be undone.</DialogDescription>
          </DialogHeader>
          {act.failed && (
            <p role="alert" className="text-[13px] text-[var(--bad)]">
              {act.failed}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={act.busy}
              onClick={() =>
                act.run(onDelete, () => {
                  setOpen(false);
                  onDeleted();
                })
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
