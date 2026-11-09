// Choosing a folder by walking to it. What's listed comes from the app: folder names, nothing else.
import { ChevronLeftIcon, FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import { reasonOf } from "./data.ts";

interface Listing {
  path: string;
  parent?: string;
  folders: { name: string }[];
}

export function FolderPicker({
  title,
  start,
  onClose,
  onPick,
}: {
  title: string;
  /** Where to begin, if what's typed is a path; a folder that isn't there yet begins at home. */
  start?: string;
  onClose(): void;
  onPick(path: string): void;
}) {
  const [path, setPath] = useState(start);
  const list = useLoad(
    () => api.call<Listing>("folders", "list", path ? { path } : {}),
    [],
    [path],
  );
  useEffect(() => {
    if (list.error && path && path === start) setPath(undefined);
  }, [list.error, path, start]);
  const at = list.value;
  const inside = (name: string) => `${at?.path === "/" ? "" : at?.path}/${name}`;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window flex h-[min(480px,80vh)] flex-col ring-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex h-8 shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Up"
            disabled={!at?.parent}
            onClick={() => setPath(at?.parent)}
          >
            <ChevronLeftIcon />
          </Button>
          <span title={at?.path} className="min-w-0 flex-1 truncate font-mono text-xs">
            {at?.path}
          </span>
        </div>
        <ul aria-label="Folders" className="no-bar -mx-2 min-h-0 flex-1 overflow-y-auto">
          {at?.folders.map(({ name }) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => setPath(inside(name))}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--hover)]"
              >
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{name}</span>
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter className="items-center">
          {list.error && path !== start && (
            <p role="alert" className="mr-auto min-w-0 text-[13px] text-[var(--bad)]">
              {reasonOf(list.error)}
            </p>
          )}
          <Button type="button" disabled={!at} onClick={() => at && onPick(at.path)}>
            Choose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
