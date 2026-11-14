// A unit's form in a window of its own, and one unit put in another's place: how an agent's units
// are changed on its page, from its setup or from a way forward.
import { CpuIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { UnitForm } from "./build.tsx";
import type { AgentDetail } from "./data.ts";
import { type CatalogUnit, isComplete, type Secrets, unitInput, type Values } from "./stack.ts";

/** A unit an agent was built from, as its page reads it. */
export type Applied = AgentDetail["units"][number];

/**
 * One unit taken out and another put in its place, as answered now: at `at`, its index among the
 * agent's units, so it stays where it was. Refused, the one it was goes back there as it was built,
 * all but its secrets, and the refusal is passed on.
 */
export async function replaceUnit(
  agent: string,
  applied: Applied,
  at: number,
  unit: CatalogUnit,
  values: Values,
  secrets: Secrets,
) {
  const place = at >= 0 ? { at } : {};
  await api.call("agents", "removeUnit", { agent, instance: applied.instance });
  try {
    await api.call("agents", "addUnit", {
      agent,
      unit: unitInput(unit, values, secrets),
      ...place,
    });
  } catch (refused) {
    const was = { provider: applied.provider, unit: applied.unit, values: applied.values };
    await api.call("agents", "addUnit", { agent, unit: was, ...place }).catch(() => {});
    throw refused;
  }
}

/**
 * One unit's form in a window of its own, as Create draws it: empty to add one, with what a unit
 * was built from to change it, or with a way forward's answers. A secret is asked again, as it is
 * never read back.
 */
export function UnitWindow({
  agentName,
  unit,
  values: given,
  note,
  onClose,
  onSave,
}: {
  agentName: string;
  unit: CatalogUnit;
  values: Values;
  /** What taking it does, when it is offered as a way forward. */
  note?: string | undefined;
  onClose(): void;
  onSave(values: Values, secrets: Secrets): void;
}) {
  const [values, setValues] = useState<Values>(given);
  const [secrets, setSecrets] = useState<Secrets>({});
  const title = `${agentName}'s ${unit.title.toLowerCase()}`;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window ring-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">What {title} is</DialogDescription>
        </DialogHeader>
        <div className="no-bar flex max-h-[60vh] flex-col overflow-y-auto rounded-xl bg-card">
          <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
            <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{unit.title}</span>
          </div>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <UnitForm
              unit={unit}
              id="setup-unit"
              agentName={agentName}
              values={values}
              secrets={secrets}
              onValue={(field, value) => setValues((was) => ({ ...was, [field]: value }))}
              onSecret={(field, value) => setSecrets((was) => ({ ...was, [field]: value }))}
            />
          </div>
        </div>
        {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!isComplete(unit, values, secrets)}
            onClick={() => onSave(values, secrets)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
