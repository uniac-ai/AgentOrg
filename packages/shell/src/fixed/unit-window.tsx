// A unit's form in a window of its own, and one unit put in another's place: how an agent's units
// are changed on its page, from its setup or from a way forward.
import { Refused } from "@agentorg/sdk";
import { ChevronRightIcon, CpuIcon } from "lucide-react";
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
import { UnitForm, UnitLine } from "./build.tsx";
import type { AgentDetail } from "./data.ts";
import {
  type CatalogUnit,
  isComplete,
  type Secrets,
  type StackProblem,
  unitInput,
  type Values,
} from "./stack.ts";

/** A unit an agent was built from, as its page reads it. */
export type Applied = AgentDetail["units"][number];
/** An agent as it stands: its base, and its units as management reads them back, in order. */
export interface Standing {
  base: { provider: string; creatable: string };
  units: Applied[];
}

/**
 * What management finds at `at` in the stack the agent would be after the change: its base and
 * its units, the one changed as answered now in its place. Each other unit's problems are its own.
 * Nothing when management can't say.
 */
async function problemsAt(standing: Standing, at: number, changed: ReturnType<typeof unitInput>) {
  const place = new Map(standing.units.map((one, i) => [one.instance, i]));
  const units = standing.units.map((one, i) => {
    if (i === at) return changed;
    // What it takes from another, by that one's place in the stack.
    const needs = Object.fromEntries(
      Object.entries(one.needs).flatMap(([kind, from]) =>
        place.has(from) ? [[kind, place.get(from)]] : [],
      ),
    );
    return {
      provider: one.provider,
      unit: one.unit,
      values: one.values,
      ...(Object.keys(needs).length > 0 ? { needs } : {}),
    };
  });
  try {
    const { problems } = await api.call<{ problems: StackProblem[] }>("agents", "check", {
      stack: { base: standing.base, units },
    });
    return problems.filter((problem) => problem.unit === at);
  } catch {
    return [];
  }
}

/**
 * One unit taken out and another put in its place, as answered now: at `at`, its index among the
 * agent's units, so it stays where it was. First the agent as it would be is checked: refused at
 * that place, nothing is taken out, and the refusal is passed on. Refused when it is added, the one
 * it was goes back there as it was built, all but its secrets, and the refusal is passed on. It
 * goes back as its form takes it today: a value for a field the form no longer has, or one it
 * doesn't show now, would be refused, and the agent left without it.
 */
export async function replaceUnit(
  agent: string,
  applied: Applied,
  at: number,
  unit: CatalogUnit,
  values: Values,
  secrets: Secrets,
  standing: Standing,
) {
  const place = at >= 0 ? { at } : {};
  const changed = unitInput(unit, values, secrets);
  const found = at >= 0 ? await problemsAt(standing, at, changed) : [];
  if (found.length > 0)
    throw new Refused("invalid", found.map((problem) => problem.message).join(" "));
  await api.call("agents", "removeUnit", { agent, instance: applied.instance });
  try {
    await api.call("agents", "addUnit", { agent, unit: changed, ...place });
  } catch (refused) {
    // `unit` is today's form when it is the unit taken out; a way forward may put in another.
    const same = unit.provider === applied.provider && unit.id === applied.unit;
    const was = same
      ? unitInput(unit, applied.values)
      : { provider: applied.provider, unit: applied.unit, values: applied.values };
    await api.call("agents", "addUnit", { agent, unit: was, ...place }).catch(() => {});
    throw refused;
  }
}

/**
 * One unit in a window of its own, as Create draws it: its own line under its title, then its form,
 * empty to add one, with what a unit was built from to change it, or with a way forward's answers.
 * A way forward's note, what taking it does, is below. A secret is asked again, as it is never read
 * back. The card folds to its head, and is drawn whole: the window is as tall as what it holds, and
 * scrolls only where that is taller than the screen.
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
  const [open, setOpen] = useState(true);
  const title = `${agentName}'s ${unit.title.toLowerCase()}`;
  // A card with nothing under its head has nothing to fold.
  const hasBody = !!unit.description || unit.form.length > 0;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window no-bar max-h-[calc(100%-2rem)] overflow-y-auto ring-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">What {title} is</DialogDescription>
        </DialogHeader>
        {/* One unit, as a list's one item named for it, as Create lists its units. Its long last row
            stays inside the window: the card is as narrow as the window lets it be. */}
        <ul className="flex min-w-0 flex-col">
          <li aria-label={unit.title} className="flex min-w-0 flex-col rounded-xl bg-card">
            <div className="flex h-10 shrink-0 items-center gap-1.5 pr-1.5 pl-3">
              <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                {unit.title}
              </span>
              {hasBody && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={open ? `Fold ${unit.title}` : `Open ${unit.title}`}
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                >
                  <ChevronRightIcon
                    className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                  />
                </Button>
              )}
            </div>
            {/* Folded, it is its head alone. What was typed in it is kept above, for when it opens. */}
            {open && (
              <div className="flex flex-col gap-3 px-3 pb-3">
                <UnitLine unit={unit} />
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
            )}
          </li>
        </ul>
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
