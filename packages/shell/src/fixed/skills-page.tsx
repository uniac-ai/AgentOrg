import { useEffect, useState } from "react";
import { api, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { listDetails, listSkills, useAct } from "./data.ts";
import { DeleteButton } from "./delete-dialog.tsx";
import { rowClass, Scroll, UsedBy } from "./parts.tsx";
import { useOffer } from "./settings-page.tsx";

export function SkillsPage({ focus, adding }: { focus?: string; adding?: boolean }) {
  const [changed, setChanged] = useState(0);
  const skills = useLoad(listSkills, [], [changed]);
  const details = useLoad(listDetails, ["actors", "bindings"], [changed]).value ?? [];
  const [open, setOpen] = useState(!!adding);
  useEffect(() => setOpen(!!adding), [adding]);
  const list = skills.value ?? [];
  const using = (name: string) => details.filter((a) => a.skills.some((s) => s.name === name));
  useOffer("Add skill", () => setOpen(true));
  return (
    <>
      <Scroll>
        <ul className="mx-auto max-w-5xl">
          {list.map((skill) => (
            <li
              key={skill.name}
              className={`${rowClass(focus === skill.name)} grid-cols-[minmax(0,2fr)_minmax(0,1fr)_24px] tight:grid-cols-[minmax(0,1fr)_24px]`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{skill.name}</div>
                <div className="truncate text-[13px] text-muted-foreground">
                  {skill.description}
                </div>
              </div>
              <span className="flex min-w-0 tight:col-start-1 tight:row-start-2">
                <UsedBy agents={using(skill.name)} />
              </span>
              <span className="tight:col-start-2 tight:row-start-1">
                <DeleteButton
                  name={skill.name}
                  agents={using(skill.name).map((a) => a.name)}
                  onDelete={() => api.call("skills", "remove", { name: skill.name })}
                  onDeleted={() => setChanged((was) => was + 1)}
                />
              </span>
            </li>
          ))}
        </ul>
      </Scroll>
      <AddSkill
        open={open}
        onClose={() => setOpen(false)}
        onAdded={() => setChanged((was) => was + 1)}
      />
    </>
  );
}

function AddSkill({ open, onClose, onAdded }: { open: boolean; onClose(): void; onAdded(): void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window ring-0 sm:max-w-md">
        <AddForm onClose={onClose} onAdded={onAdded} />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the dialog, so what was typed and what was refused go when it closes. */
function AddForm({ onClose, onAdded }: { onClose(): void; onAdded(): void }) {
  const [path, setPath] = useState("");
  const act = useAct();
  const ready = path.trim() !== "";
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        act.run(
          () => api.call("skills", "add", { path: path.trim() }),
          () => {
            onAdded();
            onClose();
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>Add skill</DialogTitle>
      </DialogHeader>
      <Input
        aria-label="Folder with a SKILL.md"
        placeholder="~/skills/changelog"
        className="font-mono text-xs"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <DialogFooter className="sm:items-center">
        {act.failed && (
          <p role="alert" className="mr-auto min-w-0 text-[13px] text-[var(--bad)]">
            {act.failed}
          </p>
        )}
        <Button type="submit" disabled={!ready || act.busy}>
          Add
        </Button>
      </DialogFooter>
    </form>
  );
}
