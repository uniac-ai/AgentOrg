// Creating an agent, in a popup: a template or nothing, then units in a stack, each drawn from its
// form. Finished, a stack comes to MCP exposures and skills.
import {
  BotIcon,
  ChevronRightIcon,
  CpuIcon,
  PlugIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Field, FieldDescription, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useBuilding } from "./building.tsx";
import { useAct } from "./data.ts";
import { FormField } from "./form.tsx";
import {
  type CatalogUnit,
  type DraftUnit,
  givesOf,
  isReady,
  isShown,
  missingNeeds,
  nameOf,
  type StackProblem,
  toStack,
} from "./stack.ts";

/** The plus: the Create window, clean each time. */
export function CreateButton() {
  const { show } = useBuilding();
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Create" onClick={show}>
      <PlusIcon />
    </Button>
  );
}

/**
 * Create, in one window: what to start from on the left, and once that's chosen a panel opening on
 * its right. A click outside closes it, and closing it clears it.
 */
export function BuildDialog() {
  const { clear, draft, open, hide } = useBuilding();
  const size = draft
    ? "h-[min(720px,calc(100dvh-2rem))] sm:w-[min(60rem,calc(100vw-2rem))]"
    : "h-[min(26rem,calc(100dvh-2rem))] sm:w-80";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent
        className={`window flex flex-col gap-0 overflow-hidden p-0 ring-0 transition-[width,height] duration-300 ease-out motion-reduce:transition-none sm:max-w-none sm:flex-row ${size}`}
        onCloseAutoFocus={clear}
        aria-describedby={undefined}
      >
        <Choose />
        {draft && (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden sm:border-l">
            {/* Its own width, so nothing reflows while the window opens around it. */}
            <div className="h-full w-full sm:w-[40rem] sm:max-w-[calc(100vw-22rem)]">
              <Stack />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Choose() {
  const { catalog, draft, start } = useBuilding();
  const mode = draft?.mode ?? "agent";
  const row = (on: boolean) =>
    `flex min-h-12 w-full shrink-0 flex-col justify-center rounded-xl px-3 py-1.5 text-left hover:bg-[var(--hover)] ${on ? "bg-[var(--selected)]" : ""}`;
  return (
    <div
      className={`flex flex-col sm:h-full sm:w-80 sm:shrink-0 ${draft ? "shrink-0" : "min-h-0 flex-1"}`}
    >
      <div className="flex h-11 shrink-0 items-center pr-10 pl-4">
        <DialogTitle className="text-[13px] font-semibold">
          {mode === "template" ? "New template" : "Create"}
        </DialogTitle>
      </div>
      <ul
        aria-label="Start from"
        className={`no-bar px-2 pb-2 ${draft ? "flex gap-1 overflow-x-auto sm:block sm:min-h-0 sm:flex-1 sm:overflow-y-auto" : "min-h-0 flex-1 overflow-y-auto"}`}
      >
        <li className="shrink-0">
          <button
            type="button"
            aria-pressed={!!draft && !draft.from}
            className={row(!!draft && !draft.from)}
            onClick={() => start(undefined, mode)}
          >
            <span className="text-sm font-medium">Empty</span>
          </button>
        </li>
        {catalog.templates.map((t) => (
          <li key={t.id} className="shrink-0">
            <button
              type="button"
              aria-pressed={draft?.from?.id === t.id}
              className={row(draft?.from?.id === t.id)}
              onClick={() => start(t, mode)}
            >
              <span className="text-sm font-medium">{t.title}</span>
              <span
                className={`truncate text-[13px] text-muted-foreground ${draft ? "hidden sm:block" : ""}`}
              >
                {t.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stack() {
  const building = useBuilding();
  const { catalog, draft, hide, saveTemplate, setText, setProblems } = building;
  const nameField = useRef<HTMLInputElement>(null);
  // Typing can start at once.
  useEffect(() => nameField.current?.focus(), []);
  const act = useAct();
  const [saving, setSaving] = useState(false);
  if (!draft) return null;
  const ready = isReady(draft);
  const isTemplate = draft.mode === "template";
  const finish = () => {
    if (!ready) return;
    const purpose = draft.purpose.trim();
    if (isTemplate) {
      act.run(async () => {
        await saveTemplate(nameOf(draft), purpose);
        hide();
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
        name: nameOf(draft),
        ...(purpose ? { purpose } : {}),
      });
      hide();
      go({ screen: "agent", agent });
    });
  };
  const overall = draft.problems.filter((p) => p.unit === undefined);
  return (
    <>
      <form
        className="flex h-full min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <div className="grid shrink-0 gap-3 border-b px-3.5 pt-3 pb-3 sm:grid-cols-2 sm:pt-5 sm:pr-12">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="build-name">Name</FieldLabel>
            <Input
              id="build-name"
              ref={nameField}
              placeholder={draft.suggested}
              value={draft.name}
              onChange={(e) => setText({ name: e.target.value })}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="build-purpose">What it's for</FieldLabel>
            <Input
              id="build-purpose"
              value={draft.purpose}
              onChange={(e) => setText({ purpose: e.target.value })}
            />
          </Field>
        </div>
        <div className="no-bar min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <ol aria-label="Units" className="flex flex-col gap-2">
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
          {/* Not modal: a modal menu dismissed with Escape swallows the next click outside the window. */}
          <DropdownMenu modal={false}>
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
          {!isTemplate && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground"
              onClick={() => setSaving(true)}
            >
              Save as template…
            </Button>
          )}
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
    </>
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
