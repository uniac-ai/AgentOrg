// Creating an agent: a template or nothing, then units in a stack on the right, each drawn from
// its form. Finished, a stack comes to MCP exposures and skills.
import {
  BotIcon,
  ChevronRightIcon,
  CpuIcon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { api, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useBuilding } from "./building.tsx";
import { useAct } from "./data.ts";
import { FormField } from "./form.tsx";
import { SidePanel } from "./parts.tsx";
import {
  type CatalogUnit,
  type DraftUnit,
  givesOf,
  isReady,
  isShown,
  missingNeeds,
  type StackProblem,
  toStack,
} from "./stack.ts";

/** The plus: a stack in progress first, then an empty one, then the templates. */
export function CreateMenu() {
  const { catalog, draft, open, show, start } = useBuilding();
  const waiting = draft && !open;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={waiting ? "Create, one in progress" : "Create"}
          className="relative"
        >
          <PlusIcon />
          {waiting && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--unread)]"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {waiting && (
          <>
            <DropdownMenuItem onSelect={show}>
              Continue {draft.name || draft.from?.title || "the one you started"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => start()}>Empty</DropdownMenuItem>
        {catalog.templates.length > 0 && <DropdownMenuSeparator />}
        {catalog.templates.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => start(t)}
            className="flex-col items-start gap-0"
          >
            <span>{t.title}</span>
            <span className="text-xs text-muted-foreground">{t.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BuildPanel() {
  const building = useBuilding();
  const { catalog, draft, open, hide, discard, saveTemplate, setText, setProblems } = building;
  const act = useAct();
  const [saving, setSaving] = useState(false);
  if (!open || !draft) return null;
  const ready = isReady(draft);
  const isTemplate = draft.mode === "template";
  const finish = () => {
    if (!ready) return;
    const purpose = draft.purpose.trim();
    if (isTemplate) {
      act.run(async () => {
        await saveTemplate(draft.name.trim(), purpose);
        discard();
        go({ screen: "settings", tab: "templates" });
      });
      return;
    }
    const stack = toStack(draft);
    act.run(async () => {
      const { problems } = await api.call<{ problems: StackProblem[] }>("agents", "check", {
        stack,
      });
      if (problems.length > 0) {
        setProblems(problems);
        return;
      }
      const { agent } = await api.call<{ agent: string }>("agents", "create", {
        stack,
        name: draft.name.trim(),
        ...(purpose ? { purpose } : {}),
      });
      discard();
      go({ screen: "agent", agent });
    });
  };
  const overall = draft.problems.filter((p) => p.unit === undefined);
  return (
    <SidePanel label="Build">
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <header className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {isTemplate ? "New template" : "New agent"}
            {draft.from && (
              <span className="font-normal text-muted-foreground"> from {draft.from.title}</span>
            )}
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Build options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!isTemplate && (
                <DropdownMenuItem onSelect={() => setSaving(true)}>
                  Save as template…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={discard}>
                Discard
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={hide}>
            <XIcon />
          </Button>
        </header>
        <div className="no-bar min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="build-name">Name</FieldLabel>
              <Input
                id="build-name"
                value={draft.name}
                onChange={(e) => setText({ name: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="build-purpose">What it's for</FieldLabel>
              <Input
                id="build-purpose"
                value={draft.purpose}
                onChange={(e) => setText({ purpose: e.target.value })}
              />
            </Field>
          </FieldGroup>
          <ol aria-label="Units" className="mt-4 flex flex-col gap-2">
            <BaseCard />
            {draft.units.map((unit, i) => (
              <UnitCard
                key={unit.key}
                unit={unit}
                above={draft.units.slice(0, i)}
                problems={draft.problems.filter((p) => p.unit === i)}
              />
            ))}
          </ol>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full justify-start text-muted-foreground"
                disabled={catalog.units.length === 0}
              >
                <PlusIcon />
                Add a unit
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              {catalog.units.map((unit) => (
                <DropdownMenuItem
                  key={`${unit.provider}/${unit.id}`}
                  onSelect={() => building.addUnit(unit)}
                  className="flex-col items-start gap-0"
                >
                  <span>{unit.title}</span>
                  <span className="text-xs text-muted-foreground">{unit.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-3 border-t px-3.5 py-2.5">
          {(act.failed || overall.length > 0) && (
            <p role="alert" className="mr-auto min-w-0 text-[13px] text-[var(--bad)]">
              {act.failed ?? overall.map((p) => p.message).join(" ")}
            </p>
          )}
          <Button type="submit" disabled={!ready || act.busy}>
            {isTemplate ? "Save template" : "Create"}
          </Button>
        </footer>
      </form>
      <SaveTemplate open={saving} onClose={() => setSaving(false)} />
    </SidePanel>
  );
}

/** Keeps the stack as it stands, without its secrets; the stack stays open. */
function SaveTemplate({ open, onClose }: { open: boolean; onClose(): void }) {
  const { draft, saveTemplate } = useBuilding();
  const [typed, setTyped] = useState<string>();
  const act = useAct();
  const title = typed ?? (draft?.from ? `${draft.from.title} copy` : "");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="window ring-0 sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!title.trim()) return;
            act.run(
              () => saveTemplate(title.trim(), draft?.purpose.trim() ?? ""),
              () => {
                setTyped(undefined);
                onClose();
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Template name"
            value={title}
            onChange={(e) => setTyped(e.target.value)}
          />
          {act.failed && (
            <p role="alert" className="text-[13px] text-[var(--bad)]">
              {act.failed}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!title.trim() || act.busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BaseCard() {
  const { catalog, draft, setAnswer, setBase } = useBuilding();
  if (!draft) return null;
  const { base } = draft;
  const choosable = !draft.from && catalog.bases.length > 1;
  return (
    <li aria-label="Base" className="rounded-xl bg-card">
      <div className="flex h-10 items-center gap-1.5 pr-1.5 pl-3 text-[13px]">
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {choosable ? (
          <Select
            value={base ? `${base.provider}/${base.id}` : ""}
            onValueChange={(next) => {
              const found = catalog.bases.find((b) => `${b.provider}/${b.id}` === next);
              if (found) setBase(found);
            }}
          >
            <SelectTrigger aria-label="Base" size="sm" className="min-w-0 flex-1 font-semibold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {catalog.bases.map((b) => (
                <SelectItem key={`${b.provider}/${b.id}`} value={`${b.provider}/${b.id}`}>
                  {b.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate font-semibold">{base?.title ?? "Not available here"}</span>
        )}
      </div>
      {base && base.asks.length > 0 && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {base.asks.map((ask) => (
            <Field key={ask.id} className="gap-1.5">
              <FieldLabel htmlFor={`base-${ask.id}`} className="text-xs">
                {ask.title}
              </FieldLabel>
              <Input
                id={`base-${ask.id}`}
                value={draft.answers[ask.id] ?? ""}
                onChange={(e) => setAnswer(ask.id, e.target.value)}
              />
              {ask.description && (
                <FieldDescription className="text-xs">{ask.description}</FieldDescription>
              )}
            </Field>
          ))}
        </div>
      )}
    </li>
  );
}

function UnitCard({
  unit: entry,
  above,
  problems,
}: {
  unit: DraftUnit;
  above: DraftUnit[];
  problems: StackProblem[];
}) {
  const { catalog, addUnit, removeUnit, setSecret, setValue } = useBuilding();
  const [unfolded, setUnfolded] = useState(true);
  const { unit, key, values, secrets } = entry;
  const title = unit?.title ?? entry.id;
  const gives = unit ? givesOf(unit, values) : { slots: [], skills: [] };
  const lacking = missingNeeds(entry, above)[0];
  const supplier: CatalogUnit | undefined = catalog.units.find((u) =>
    u.gives.results.includes(lacking as string),
  );
  const general = problems.filter((p) => !p.field);
  return (
    <li aria-label={title} className="rounded-xl bg-card">
      <div className="flex h-10 items-center gap-1.5 pr-1.5 pl-3">
        <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={unfolded ? `Fold ${title}` : `Open ${title}`}
          aria-expanded={unfolded}
          onClick={() => setUnfolded(!unfolded)}
        >
          <ChevronRightIcon
            className={`transition-transform motion-reduce:transition-none ${unfolded ? "rotate-90" : ""}`}
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${title}`}
          onClick={() => removeUnit(key)}
        >
          <XIcon />
        </Button>
      </div>
      {unfolded && (
        <div className="flex flex-col gap-3 px-3 pb-3 empty:hidden">
          {!unit && <p className="text-xs text-[var(--bad)]">Not available here.</p>}
          {unit?.form.map(
            (field) =>
              isShown(field, unit.form, values) && (
                <FormField
                  key={field.id}
                  id={`unit-${key}-${field.id}`}
                  field={field}
                  values={values}
                  secret={secrets[field.id] ?? ""}
                  problem={problems.find((p) => p.field === field.id)?.message}
                  onChange={(value) => setValue(key, field.id, value)}
                  onSecret={(value) => setSecret(key, field.id, value)}
                />
              ),
          )}
          {lacking && (
            <p className="flex items-center justify-between gap-2 text-xs text-[var(--warn)]">
              <span>Needs a {lacking} above it</span>
              {supplier && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => addUnit(supplier, key)}
                >
                  Add it
                </Button>
              )}
            </p>
          )}
          {general.map((p) => (
            <p key={p.message} className="text-xs text-[var(--bad)]">
              {p.message}
            </p>
          ))}
          {(gives.slots.length > 0 || gives.skills.length > 0) && (
            <p
              data-gives
              className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px] text-[var(--faint)]"
            >
              {gives.slots.length > 0 && (
                <>
                  <PlugIcon role="img" aria-label="MCP" className="size-3 shrink-0" />
                  <span className="shrink-0">{gives.slots.join(", ")}</span>
                </>
              )}
              {gives.skills.length > 0 && (
                <>
                  <SparklesIcon
                    role="img"
                    aria-label="Skills"
                    className={`size-3 shrink-0 ${gives.slots.length > 0 ? "ml-1.5" : ""}`}
                  />
                  <span>{gives.skills.join(", ")}</span>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
