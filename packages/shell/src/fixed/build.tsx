// Creating an agent, in one window of two parts. At the left, the identity card of the agent being
// made: its face, its name and what it's for, typed in place, and what it can do, following the
// options as they change. At the right, a row of what to start from, then the options in sections:
// its base, each unit with its questions, and the way to add one. Finished, a stack comes to MCP
// exposures and skills.
import {
  BotIcon,
  BoxIcon,
  ChevronRightIcon,
  CpuIcon,
  type LucideIcon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, closeSettings, go, openSettings } from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogClose,
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
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Field, FieldDescription, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useBuilding } from "./building.tsx";
import { useAct } from "./data.ts";
import { Face } from "./face.tsx";
import { FormField } from "./form.tsx";
import { needsOf, useLogin } from "./login.tsx";
import { Rail, type RailSection } from "./rail.tsx";
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
 * A unit's stand-in logo, until a unit's own is in the contract. The shell knows kinds, never a
 * unit by its id, so it is told by what the unit gives: a computer; a connection's slot alone;
 * skills alone; or anything else.
 */
function logoOf(unit: CatalogUnit | undefined): LucideIcon {
  if (!unit) return BoxIcon;
  const { results, slots, skills } = unit.gives;
  if (results.includes("computer")) return CpuIcon;
  if (slots.length > 0 && skills.length === 0) return PlugIcon;
  if (skills.length > 0 && slots.length === 0) return SparklesIcon;
  return BoxIcon;
}

/** A section's logo, as the card and the headings draw it. */
function Tile({ logo: Logo, small = false }: { logo: LucideIcon; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center bg-[var(--selected)] ${small ? "size-5 rounded-md" : "size-7 rounded-lg"}`}
    >
      <Logo className={small ? "size-3" : "size-4"} />
    </span>
  );
}

/**
 * Create, in one window: the card on the left, the options on the right. A click outside closes
 * it, and it opens clean, with the keyboard in the name.
 */
export function BuildDialog() {
  const { open, hide } = useBuilding();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent
        asWindow
        // Its close is in its head, in line with the title and the menu.
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById("build-name")?.focus({ preventScroll: true });
        }}
        className="window flex h-[min(680px,calc(100%-2rem))] gap-0 overflow-hidden rounded-3xl bg-[var(--create)] p-0 ring-0 max-sm:flex-col sm:max-w-[920px]"
      >
        <IdentityCard />
        {/* Narrow, the head isn't drawn: the close is at the corner. */}
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="absolute top-2 right-2 z-10 hidden max-sm:inline-flex"
          >
            <XIcon />
          </Button>
        </DialogClose>
        <Options />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The identity card: a large face, the name under it, one line of what it's for, then what it can
 * do, a row for each unit chosen at the right. The name and the line are typed here, in place, with
 * no box; the card is centred on its height. Narrow, it sits on top, compact.
 */
function IdentityCard() {
  const { catalog, choosing, draft, setText } = useBuilding();
  const offered = useOffered();
  const mode = draft?.mode ?? choosing?.mode ?? "agent";
  // An agent is offered a name no agent has, used if none is typed. A template has to be named.
  const shown = mode === "template" ? "" : offered;
  const name = draft?.name ?? "";
  const named = name.trim() || shown;
  const from = catalog.templates.find((t) => t.id === (draft ?? choosing)?.from?.id);
  // Until something is typed, the line says what the template or the base is.
  const says = from?.description || draft?.base?.description || "";
  // A face of its own: its colour stays while its letters follow the name.
  const face = { id: "a-new-agent", name: named || "?", tone: "idle" as const };
  // Typed in place: no box, only a faint tint under the pointer.
  const inPlace =
    "block w-full min-w-0 rounded-md border-0 bg-transparent p-0 text-center outline-none hover:bg-[var(--hover)] max-sm:text-left";
  return (
    <aside
      aria-label={`${named || "New agent"}, as it will be`}
      className="flex w-[300px] shrink-0 flex-col p-3 max-sm:w-auto max-sm:p-2 max-sm:pb-0"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl bg-[var(--create-card)] px-6 py-6 text-center max-sm:flex-none max-sm:flex-row max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-2.5 max-sm:px-3 max-sm:py-3 max-sm:text-left">
        <span className="max-sm:hidden">
          <Face agent={face} size={96} plain />
        </span>
        <span className="hidden max-sm:block">
          <Face agent={face} size={44} plain />
        </span>
        <div className="mt-4 w-full min-w-0 max-sm:mt-0 max-sm:w-auto max-sm:flex-1">
          {/* The name offered reads as a name until one is typed: Create works at once. */}
          <input
            id="build-name"
            aria-label="Name"
            value={name}
            placeholder={shown || "Name"}
            // Until the stack is drawn there is nothing yet to hold what is typed.
            readOnly={!draft}
            onChange={(e) => setText({ name: e.target.value })}
            className={`${inPlace} h-8 text-[22px] font-semibold tracking-tight max-sm:h-6 max-sm:text-[17px] ${shown ? "placeholder:text-foreground" : "placeholder:text-[var(--faint)]"}`}
          />
          {/* What it's for, in one or two lines. */}
          <textarea
            aria-label="What it's for"
            rows={1}
            value={draft?.purpose ?? ""}
            placeholder={says}
            readOnly={!draft}
            onChange={(e) => setText({ purpose: e.target.value.replace(/\n/g, " ") })}
            className={`${inPlace} mt-1 field-sizing-content max-h-10 resize-none overflow-hidden text-[13px] leading-5 text-muted-foreground placeholder:text-muted-foreground max-sm:mt-0 max-sm:line-clamp-1`}
          />
        </div>
        {/* What it can do: a row for each unit chosen at the right, and nothing said with none. */}
        <ul
          aria-label="What it can do"
          className="mt-9 flex w-full flex-col gap-1 empty:hidden max-sm:mt-0 max-sm:flex-row max-sm:flex-wrap max-sm:gap-1.5"
        >
          {draft?.units.map((unit) => (
            <li
              key={unit.key}
              className="flex h-9 min-w-0 items-center gap-2.5 text-left text-[15px] max-sm:h-7 max-sm:gap-1.5 max-sm:rounded-full max-sm:bg-[var(--selected)] max-sm:pr-2.5 max-sm:pl-1 max-sm:text-[13px]"
            >
              <span className="contents max-sm:hidden">
                <Tile logo={logoOf(unit.unit)} />
              </span>
              <span className="hidden max-sm:contents">
                <Tile logo={logoOf(unit.unit)} small />
              </span>
              <span className="truncate">{unit.unit?.title ?? unit.id}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** What to start from: Empty or a template, a row of small cards that scrolls sideways. */
function StartFrom() {
  const { catalog, choosing, start } = useBuilding();
  const isEmpty = !!choosing && !choosing.from;
  const tile = (on: boolean) =>
    `flex h-[60px] w-[184px] flex-col justify-center rounded-xl px-3 text-left ${on ? "bg-[var(--selected)] ring-1 ring-[var(--line-strong)] ring-inset" : "bg-[var(--create-card)] hover:brightness-110"}`;
  return (
    // No heading: the row says what it is.
    <ul
      aria-label="Start from"
      className="no-bar flex shrink-0 gap-2 overflow-x-auto px-5 pb-4 max-sm:pt-3"
    >
      <li className="shrink-0">
        <button
          type="button"
          aria-current={isEmpty ? "true" : undefined}
          className={tile(isEmpty)}
          onClick={() => start(undefined, choosing?.mode)}
        >
          <span className="text-[15px] font-medium">Empty</span>
        </button>
      </li>
      {catalog.templates.map((t) => (
        <li key={t.id} className="shrink-0">
          <button
            type="button"
            aria-current={choosing?.from?.id === t.id ? "true" : undefined}
            className={tile(choosing?.from?.id === t.id)}
            onClick={() => start(t, choosing?.mode)}
          >
            <span className="truncate text-[15px] font-medium">{t.title}</span>
            <span className="truncate text-[13px] text-muted-foreground">{t.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One section of the options: its heading, a logo and a title, and what it asks. Its heading is
 * where the section is gone to. The last is as tall as the options' view, so its heading can come
 * to the top too.
 */
function Part({
  id,
  title,
  logo,
  after,
  last = false,
  children,
}: {
  id: string;
  title: string;
  logo: LucideIcon;
  after?: React.ReactNode;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`part-${id}`} className={`pb-8 ${last ? "min-h-full" : ""}`}>
      <div data-heading={id} className="flex h-10 items-center gap-2.5">
        <Tile logo={logo} />
        <h3 id={`part-${id}`} className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {title}
        </h3>
        {after}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/**
 * The options: the title, its menu and the close on one line; what to start from; then the
 * sections, each a heading and what it asks; and at the foot, Create and what is still missing.
 */
function Options() {
  const building = useBuilding();
  const { catalog, choosing, draft, hide, refreshUnits, saveTemplate, setProblems } = building;
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
  const isTemplate = (draft?.mode ?? choosing?.mode) === "template";
  const ready = !!draft && isReady(draft, offered);
  const finish = () => {
    if (!draft || !ready) return;
    const name = nameOf(draft, offered);
    const purpose = draft.purpose.trim();
    if (isTemplate) {
      act.run(async () => {
        await saveTemplate(name, purpose);
        hide();
        // Back to the templates, in Settings, whether or not it was opened over it.
        openSettings("templates");
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
      // It closes, and Settings too if it was opened over it: the new agent is shown in Team.
      hide();
      closeSettings();
      go({ screen: "team", agent });
    });
  };
  /** The window's menu: in its head, or at its foot where the head isn't drawn. */
  const options = (align: "start" | "end") =>
    // Not modal: a modal menu dismissed with Escape swallows the next click outside the window.
    draft &&
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
  const overall = draft?.problems.filter((p) => p.unit === undefined) ?? [];
  const refused = act.failed ?? overall.map((p) => p.message).join(" ");
  // The rail's sections, in order, each found by its heading: the base, each unit, the way to add
  // one. What to start from is above the scroll and isn't one.
  const scroller = useRef<HTMLDivElement>(null);
  const sections: RailSection[] = [
    { key: "base", label: "Base", logo: BotIcon },
    ...(draft?.units ?? []).map((unit) => ({
      key: `unit-${unit.key}`,
      label: unit.unit?.title ?? unit.id,
      logo: logoOf(unit.unit),
    })),
    { key: "add", label: "Add", logo: PlusIcon },
  ].map((section) => ({
    ...section,
    heading: () =>
      scroller.current?.querySelector<HTMLElement>(`[data-heading="${CSS.escape(section.key)}"]`),
  }));
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
        {/* The title, the menu and the close in one line, centred on it. */}
        <header className="flex h-14 shrink-0 items-center gap-1 pr-3 pl-5 max-sm:sr-only">
          <DialogTitle className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            {isTemplate ? "New template" : "Create New Agent"}
          </DialogTitle>
          <span className="flex items-center gap-1 max-sm:hidden">
            {options("end")}
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                <XIcon />
              </Button>
            </DialogClose>
          </span>
        </header>
        <DialogDescription className="sr-only">
          An agent's card at the left, and the options that make it at the right
        </DialogDescription>
        <StartFrom />
        {draft && (
          // The options scroll with no scrollbar: the rail of their sections stands at the right.
          <div className="relative min-h-0 flex-1">
            <div ref={scroller} className="no-bar relative h-full overflow-y-auto pt-1 pr-14 pl-5">
              <Part id="base" title="Base" logo={BotIcon}>
                <BaseOptions />
              </Part>
              {draft.units.map((unit, i) => (
                <UnitPart
                  key={unit.key}
                  unit={unit}
                  above={draft.units.slice(0, i)}
                  problems={draft.problems.filter((p) => p.unit === i)}
                />
              ))}
              <Part id="add" title="Add" logo={PlusIcon} last>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-muted-foreground"
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
              </Part>
            </div>
            <Rail scroller={scroller} sections={sections} />
          </div>
        )}
        {draft && (
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
        )}
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

/** The base: one to choose where there are several, or the one there is, with what it asks. */
function BaseOptions() {
  const { catalog, draft, setAnswer, setBase } = useBuilding();
  if (!draft) return null;
  const { base } = draft;
  const choosable = !draft.from && catalog.bases.length > 1;
  // The one there is, asking nothing: its name and what it is.
  const named = (
    <div className="px-3 text-[15px]">
      <div className="font-medium">{base?.title ?? "Not available here"}</div>
      {base?.description && (
        <div className="text-[13px] text-muted-foreground">{base.description}</div>
      )}
    </div>
  );
  if (!choosable && !base?.asks.length) return named;
  return (
    <div className="flex flex-col gap-3 px-0.5">
      {choosable ? (
        <Select
          value={base ? `${base.provider}/${base.id}` : ""}
          onValueChange={(next) => {
            const found = catalog.bases.find((b) => `${b.provider}/${b.id}` === next);
            if (found) setBase(found);
          }}
        >
          <SelectTrigger aria-label="Base" className="w-full">
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
        named
      )}
      {base?.asks.map((ask) => (
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
  );
}

/** A unit's section: its heading with its fold and its remove, and its questions as they were. */
function UnitPart({
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
    <Part
      id={`unit-${key}`}
      title={title}
      logo={logoOf(unit)}
      after={
        <>
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
        </>
      }
    >
      {unfolded && (
        <div className="flex flex-col gap-3 px-0.5 empty:hidden">
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
    </Part>
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
