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

/** Asking before something is deleted: what goes with it, then the call, and why if it failed. */
export function ConfirmDelete({
  name,
  open,
  onOpenChange,
  ...asking
}: {
  name: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onDelete(): Promise<unknown>;
  onDeleted(): void;
  /** What is lost with it. */
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="window ring-0 sm:max-w-sm">
        <Asking name={name} onClose={() => onOpenChange(false)} {...asking} />
      </DialogContent>
    </Dialog>
  );
}

/** What the confirm holds while it is open: each time it is asked anew. */
function Asking({
  name,
  onClose,
  onDelete,
  onDeleted,
  children,
}: {
  name: string;
  onClose(): void;
  onDelete(): Promise<unknown>;
  onDeleted(): void;
  children: React.ReactNode;
}) {
  const act = useAct();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete {name}?</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
      </DialogHeader>
      {act.failed && (
        <p role="alert" className="text-[13px] text-[var(--bad)]">
          {act.failed}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={act.busy}
          onClick={() =>
            act.run(onDelete, () => {
              onClose();
              onDeleted();
            })
          }
        >
          Delete
        </Button>
      </DialogFooter>
    </>
  );
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
      <ConfirmDelete
        name={name}
        open={open}
        onOpenChange={setOpen}
        onDelete={onDelete}
        onDeleted={onDeleted}
      >
        {losers(agents)} This can't be undone.
      </ConfirmDelete>
    </>
  );
}
