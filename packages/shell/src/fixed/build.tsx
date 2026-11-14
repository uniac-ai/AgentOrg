// Creating an agent, in one window: a template or nothing on the left, the stack on the right, each
// unit drawn from its form. Finished, a stack comes to MCP exposures and skills.
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
import { useEffect, useRef, useState } from "react";
import { api, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useBuilding } from "./building.tsx";
import { useAct } from "./data.ts";
import { FormField } from "./form.tsx";
import { needsOf, useLogin } from "./login.tsx";
import {
  type CatalogUnit,
  type DraftUnit,
  givesOf,
  isReady,
  isShown,
  missingNeeds,
  nameOf,
  offeredName,
  type Secrets,
  type StackProblem,
  toStack,
  type Values,
} from "./stack.ts";
import { useAgents } from "./watch.tsx";

/**
 * The name an agent is offered: the first of the shell's names that no agent has. None is offered
 * until the agents are read, and a name read while the window is open stays taken, so a read that
 * fails, which lists none, doesn't offer one an agent has.
 */
function useOffered() {
  const { list, loaded } = useAgents();
  const taken = useRef(new Set<string>());
  for (const agent of list) taken.current.add(agent.name);
  return loaded ? offeredName([...taken.current]) : "";
}

/**
 * Create, in one window: what to start from on the left, the stack on the right. A click outside
 * closes it, and it opens clean.
 */
export function BuildDialog() {
  const { draft, open, hide } = useBuilding();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent
        className="window flex h-[min(700px,calc(100%-2rem))] gap-0 overflow-hidden rounded-3xl bg-background p-0 ring-0 max-sm:flex-col sm:max-w-[840px]"
        aria-describedby={undefined}
      >
        <Choose />
        {draft && <Stack />}
      </DialogContent>
    </Dialog>
  );
}

function Choose() {
  const { catalog, draft, start } = useBuilding();
  const row = (on: boolean) =>
    `flex min-h-[52px] w-full shrink-0 flex-col justify-center rounded-xl px-3 text-left max-sm:w-auto ${on ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`;
  const isEmpty = !!draft && !draft.from;
  return (
    <nav
      aria-label="Start from"
      className="no-bar flex w-[250px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-[var(--canvas)] p-2 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:pr-12"
    >
      <DialogTitle className="flex h-12 shrink-0 items-center px-3 text-[17px] font-semibold">
        {draft?.mode === "template" ? "New template" : "Create"}
      </DialogTitle>
      <button
        type="button"
        aria-current={isEmpty ? "true" : undefined}
        className={row(isEmpty)}
        onClick={() => start(undefined, draft?.mode)}
      >
        <span className="text-[15px] font-medium">Empty</span>
      </button>
      {catalog.templates.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={draft?.from?.id === t.id ? "true" : undefined}
          className={row(draft?.from?.id === t.id)}
          onClick={() => start(t, draft?.mode)}
        >
          <span className="truncate text-[15px] font-medium">{t.title}</span>
          <span className="truncate text-[13px] text-muted-foreground max-sm:hidden">
            {t.description}
          </span>
        </button>
      ))}
    </nav>
  );
}

function Stack() {
  const building = useBuilding();
  const { catalog, draft, hide, refreshUnits, saveTemplate, setText, setProblems } = building;
  // What can be added: a unit a stack holds once isn't offered while the stack has it.
  const addable = catalog.units.filter(
    (unit) =>
      !unit.once ||
      !draft?.units.some((held) => held.unit?.provider === unit.provider && held.id === unit.id),
  );
  const act = useAct();
  // Made while signed out of the model account, an agent can't work yet: the foot says so.
  const needs = needsOf(useLogin());
  const [saving, setSaving] = useState(false);
  const offered = useOffered();
  if (!draft) return null;
  const ready = isReady(draft, offered);
  const isTemplate = draft.mode === "template";
  const finish = () => {
    if (!ready) return;
    const name = nameOf(draft, offered);
    const purpose = draft.purpose.trim();
    if (isTemplate) {
      act.run(async () => {
        await saveTemplate(name, purpose);
        hide();
        go({ screen: "settings", tab: "templates" });
      });
      return;
    }
    const stack = toStack(draft);
    act.run(async () => {
      // A form can change while it's open. What's chosen, and what it grants, show before it's used.
      if (await refreshUnits()) return;
      const { problems } = await api.call<{ problems: StackProblem[] }>("agents", "check", {
        stack,
      });
      if (problems.length > 0) {
        setProblems(problems);
        return;
      }
      const { agent } = await api.call<{ agent: string }>("agents", "create", {
        stack,
        name,
        ...(purpose ? { purpose } : {}),
      });
      hide();
      go({ screen: "agent", agent });
    });
  };
  /** The window's menu: in its head, or at its foot where the head isn't drawn. */
  const options = (align: "start" | "end") =>
    // Not modal: a modal menu dismissed with Escape swallows the next click outside the window.
    !isTemplate && (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Build options">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {/* A stack with no base, or a unit nobody offers, can't be kept. */}
          <DropdownMenuItem
            disabled={!draft.base || draft.units.some((u) => !u.unit)}
            onSelect={() => setSaving(true)}
          >
            Save as template…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  const overall = draft.problems.filter((p) => p.unit === undefined);
  const refused = act.failed ?? overall.map((p) => p.message).join(" ");
  return (
    <>
      <form
        aria-label="Build"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 pr-11 pl-5 max-sm:hidden">
          <span className="min-w-0 flex-1" />
          {options("end")}
        </header>
        <div className="no-bar min-h-0 flex-1 overflow-y-auto px-5 pb-3 max-sm:pt-3">
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="build-name">Name</FieldLabel>
              {/* The keyboard starts here, and an agent is offered a name: Create works at once. */}
              <Input
                id="build-name"
                // biome-ignore lint/a11y/noAutofocus: the window opens to be filled in, name first.
                autoFocus
                placeholder={isTemplate ? undefined : offered}
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
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full justify-start text-muted-foreground"
                disabled={addable.length === 0}
              >
                <PlusIcon />
                Add a unit
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel className="sr-only">Units</DropdownMenuLabel>
              {addable.map((unit) => (
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
        <footer className="flex shrink-0 items-center justify-end gap-4 px-5 py-3">
          {/* Where the window's head isn't drawn, its menu is at the foot. */}
          <span className="mr-auto sm:hidden">{options("start")}</span>
          {refused ? (
            <p role="alert" className="min-w-0 flex-1 text-[13px] text-[var(--bad)]">
              {refused}
            </p>
          ) : (
            !isTemplate &&
            needs && (
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                {needs}
              </span>
            )
          )}
          <Button
            type="submit"
            disabled={!ready || act.busy}
            className="h-10 rounded-full px-5 text-[15px]"
          >
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
  if (!choosable && !base?.asks.length)
    return (
      <li
        aria-label="Base"
        className="flex h-10 items-center gap-1.5 rounded-xl bg-card pl-3 text-[13px]"
      >
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-semibold">{base?.title ?? "Not available here"}</span>
      </li>
    );
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
  const { catalog, draft, addUnit, removeUnit, setSecret, setValue } = useBuilding();
  const offered = useOffered();
  const [unfolded, setUnfolded] = useState(true);
  // Something found wrong with it opens it, each time the stack is checked.
  const found = problems.length > 0;
  const checked = draft?.problems;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `checked` is a new list per check.
  useEffect(() => {
    if (found) setUnfolded(true);
  }, [found, checked]);
  const { unit, key, values, secrets } = entry;
  const title = unit?.title ?? entry.id;
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
          {unit && (
            <UnitForm
              unit={unit}
              id={`unit-${key}`}
              agentName={draft?.mode === "agent" ? nameOf(draft, offered) : undefined}
              values={values}
              secrets={secrets}
              problems={problems}
              onValue={(field, value) => setValue(key, field, value)}
              onSecret={(field, value) => setSecret(key, field, value)}
            >
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
            </UnitForm>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A unit's form as it is filled in, wherever a unit is chosen: each field that is shown, what is
 * said of the unit as a whole, then what the unit will give with these answers.
 */
export function UnitForm({
  unit,
  id,
  agentName,
  values,
  secrets,
  problems = [],
  onValue,
  onSecret,
  children,
}: {
  unit: CatalogUnit;
  id: string;
  agentName?: string | undefined;
  values: Values;
  secrets: Secrets;
  problems?: StackProblem[];
  onValue(field: string, value: Values[string]): void;
  onSecret(field: string, value: string): void;
  children?: React.ReactNode;
}) {
  const gives = givesOf(unit, values);
  return (
    <>
      {unit.form.map(
        (field) =>
          isShown(field, unit.form, values) && (
            <FormField
              key={field.id}
              id={`${id}-${field.id}`}
              agentName={agentName}
              field={field}
              values={values}
              secret={secrets[field.id] ?? ""}
              problem={problems.find((p) => p.field === field.id)?.message}
              onChange={(value) => onValue(field.id, value)}
              onSecret={(value) => onSecret(field.id, value)}
            />
          ),
      )}
      {children}
      {(gives.slots.length > 0 || gives.skills.length > 0) && (
        <p
          data-gives
          className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-[var(--faint)]"
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
              <span className="truncate">{gives.skills.join(", ")}</span>
            </>
          )}
        </p>
      )}
    </>
  );
}
