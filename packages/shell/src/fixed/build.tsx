// Creating an agent, and building a template. An agent is made on one card: the template it starts
// from, as a badge; its avatar, chosen from a row of them, each with a name; its name and what it's
// for, typed in place; and Create. What the template gives it is opened beside the card from the
// card's right edge, shown and not asked: an agent's details are built in a chat. A template is
// built in one window of two parts. At the left, the identity card: its face, its name and what
// it's for, typed in place, and what it can do, following the options as they change. At the
// right, a row of what to start from, then the options in sections: its base, each unit with its
// questions, and the way to add one. Finished, a stack comes to MCP exposures and skills.
import {
  BotIcon,
  BoxIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CpuIcon,
  LayersIcon,
  type LucideIcon,
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
  DialogTitle,
} from "../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Field, FieldDescription, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import type { Pair } from "./avatar-ring.ts";
import { AvatarRow } from "./avatar-row.tsx";
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
  type Secrets,
  type StackProblem,
  toStack,
  type Values,
} from "./stack.ts";
import { useAgents } from "./watch.tsx";

/**
 * The names agents have, which a new agent isn't offered, and whether they have been read. A name
 * read while the window is open stays taken, so a read that fails, which lists none, doesn't offer
 * one an agent has.
 */
function useTaken() {
  const { list, loaded } = useAgents();
  const taken = useRef(new Set<string>());
  for (const agent of list) taken.current.add(agent.name);
  return { taken: taken.current, loaded };
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
 * How an agent's create window is laid out, by the page's width: every width and size it goes by
 * is here, as the window's own variables and the two widths its classes turn on.
 *
 *   page's width   what it can do    the card         what it can do is
 *   under 480      under the card    the page less 32  as wide as the card
 *   480 to 767     under the card    440               440
 *   768 to 831     beside the card   440               the page less 472: 296 to 359
 *   832 and more   beside the card   440               360
 *
 * `md` (768) is where what it can do has room beside the card: narrower than 296 it would be
 * cramped. Under 480 (`max-[30rem]`) the card is narrower than 440, and its avatars are 88 where
 * they are 104. The window is in the page's middle in every layout, and never wider or taller
 * than the page less its margins.
 */
const CREATE = {
  /**
   * The window: the name card, and beside it what it can do while that is open. It has no ground
   * of its own beside the card, where its two cards are each drawn whole; under the card it is
   * one column on the window's other ground, which scrolls where the page is short.
   */
  window:
    "flex max-h-[calc(100%-2rem)] w-(--card) max-w-none gap-0 overflow-visible rounded-3xl bg-transparent p-0 ring-0 [--bar:14px] [--card:min(440px,100vw_-_2rem)] [--detail:min(360px,100vw_-_2rem_-_440px)] [--face:104px] [--row-blur:56px] [--tuck:32px] max-md:flex-col max-md:overflow-x-hidden max-md:overflow-y-auto max-md:bg-[var(--create)] max-[30rem]:[--face:88px] max-[30rem]:[--row-blur:40px] sm:max-w-none",
  /** Open beside the card, the window is wider by what it can do. */
  open: "md:w-[calc(var(--card)_+_var(--detail))]",
  /** Its width takes the time a window opens in, only as what it can do opens or closes. */
  moving: "md:motion-safe:transition-[width] md:motion-safe:ease-out",
  /**
   * The name card, over what it can do: its head and its foot stay, and its middle scrolls where
   * the page is shorter than the card, so Create is always in view.
   */
  card: "window relative z-10 flex max-h-[calc(100dvh-2rem)] w-(--card) shrink-0 flex-col rounded-3xl bg-[var(--create-card)] max-md:max-h-[calc(100dvh-3.5rem)] max-md:w-full max-md:rounded-none",
  /** The room kept for the row of avatars. */
  row: "h-[calc(var(--face)_+_16px)] shrink-0",
  /**
   * What it can do, a card of its own under the name card: `--tuck` of it stays under the name
   * card's edge, the rest is at the card's right. Under the card it is part of the column.
   */
  detail:
    "window absolute inset-y-0 right-0 z-0 w-[calc(var(--detail)_+_var(--tuck))] rounded-3xl bg-[var(--create)] max-md:static max-md:order-2 max-md:w-full max-md:shrink-0 max-md:rounded-none max-md:bg-transparent",
  /** What it holds, clear of the part under the name card. */
  detailInner:
    "no-bar flex h-full flex-col gap-3 overflow-y-auto pt-4 pr-5 pb-5 pl-[calc(var(--tuck)_+_20px)] max-md:pl-5",
  /** The name card's shadow on it: to the right of the card's edge, or downward under the card. */
  shade:
    "pointer-events-none absolute z-10 from-black/4 to-transparent max-md:inset-x-0 max-md:top-0 max-md:h-5 max-md:bg-linear-to-b md:inset-y-0 md:left-(--tuck) md:w-5 md:bg-linear-to-r dark:from-black/14",
  /**
   * What is pressed to open and close what it can do: 24 into the name card's right edge below
   * its head row, and 14 more, to the bar's end, while the bar is out; its left edge stays. Under
   * the card it is a row along the card's foot.
   */
  edge: "peer/edge absolute top-14 bottom-0 left-[calc(var(--card)_-_24px)] z-20 w-6 text-muted-foreground outline-none max-md:relative max-md:inset-auto max-md:order-1 max-md:h-6 max-md:w-full max-md:shrink-0 max-md:bg-[var(--create-card)] md:hover:w-[38px] md:focus-visible:w-[38px] md:[@media(hover:none)]:w-[38px]",
  /**
   * The bar, a tab of the window's other ground lying under the name card with the card's
   * corners at its outer side: with the pointer or the keyboard on the edge it slides `--bar`
   * out from under the card's right edge, and where nothing hovers it stands out.
   */
  tab: "window absolute inset-y-0 left-[calc(var(--card)_-_56px)] z-[5] w-14 rounded-r-3xl bg-[var(--create)] text-muted-foreground shadow-[2px_0_6px_rgb(0_0_0/0.05)] transition-transform duration-200 ease-out peer-hover/edge:translate-x-(--bar) peer-focus-visible/edge:translate-x-(--bar) motion-reduce:transition-none max-md:hidden dark:shadow-[2px_0_6px_rgb(0_0_0/0.3)] [@media(hover:none)]:translate-x-(--bar)",
  /** The part of the bar that comes out, with its arrow and the name card's shadow on it. */
  tabOut: "absolute inset-y-0 right-0 flex w-(--bar) items-center justify-center",
  tabShade:
    "pointer-events-none absolute inset-y-0 right-0 w-(--bar) bg-linear-to-r from-black/4 to-transparent dark:from-black/14",
  /** The bar under the card: along the card's foot, always there. */
  foot: "absolute inset-x-0 bottom-0 flex h-(--bar) items-center justify-center bg-[var(--create)] md:hidden",
};

/**
 * Create, in one window. A click outside closes it, and it opens clean, with the keyboard in the
 * name. An agent's opens as its card alone, in the page's middle; with what it can do open it is
 * the card over a second card, the two in the page's middle together. A template's is the card
 * on the left and the options on the right.
 */
export function BuildDialog() {
  const { open, hide, draft, choosing } = useBuilding();
  const template = (draft?.mode ?? choosing?.mode) === "template";
  // Whether what an agent can do is open: closed each time the window opens. `moving` is the
  // moment after it opens or closes, in which the window's width takes time; a page that is
  // resized changes the window's width at once.
  const [detail, setDetail] = useState(false);
  const [moving, setMoving] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDetail(false);
      setMoving(false);
    }
  }
  useEffect(() => () => clearTimeout(settle.current), []);
  const toggle = (next: boolean) => {
    setMoving(true);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setMoving(false), 400);
    setDetail(next);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()}>
      <DialogContent
        asWindow
        // Its close is in its head, in line with the title.
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById("build-name")?.focus({ preventScroll: true });
        }}
        className={
          template
            ? "window flex h-[min(680px,calc(100%-2rem))] gap-0 overflow-hidden rounded-3xl bg-[var(--create)] p-0 ring-0 max-sm:flex-col sm:max-w-[920px]"
            : `${CREATE.window} ${detail ? CREATE.open : ""} ${moving ? CREATE.moving : ""}`
        }
      >
        {template ? (
          <>
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
          </>
        ) : (
          <>
            <CreateCard />
            <Edge detail={detail} toggle={toggle} />
            <Detail shown={detail} drawn={detail || moving} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What is typed on the card: its name, and what it's for, which until one is typed says what the
 * template or the base is. An agent is offered a name, `offered`, used if none is typed; a
 * template has to be named. The face's letters follow the name.
 */
function useCardWords(offered = "") {
  const { catalog, choosing, draft, setText } = useBuilding();
  const name = draft?.name ?? "";
  const named = name.trim() || offered;
  const from = catalog.templates.find((t) => t.id === (draft ?? choosing)?.from?.id);
  const says = from?.description || draft?.base?.description || "";
  // A face of its own: its colour stays while its letters follow the name.
  const face = { id: "a-new-agent", name: named || "?", tone: "idle" as const };
  return { draft, setText, name, named, says, face };
}

/**
 * The name and what it's for, typed in place: no box, only a faint tint under the pointer. The
 * name `offered` reads as a name until one is typed. On a template's card, narrow, they sit at the
 * left of a smaller face, compact.
 */
function TypedInPlace({
  offered: shown = "",
  compact = false,
}: {
  offered?: string;
  compact?: boolean;
}) {
  const { draft, setText, name, says } = useCardWords(shown);
  const inPlace = `block w-full min-w-0 rounded-md border-0 bg-transparent p-0 text-center outline-none hover:bg-[var(--hover)] ${compact ? "max-sm:text-left" : ""}`;
  return (
    <>
      {/* The name offered reads as a name until one is typed: Create works at once. On a phone the
          shell sets every typed field at 16, which an agent's name, larger, is kept from. */}
      <input
        id="build-name"
        aria-label="Name"
        value={name}
        placeholder={shown || "Name"}
        // Until the stack is drawn there is nothing yet to hold what is typed.
        readOnly={!draft}
        onChange={(e) => setText({ name: e.target.value })}
        className={`${inPlace} h-8 text-[22px] font-semibold tracking-tight text-ellipsis ${compact ? "max-sm:h-6 max-sm:text-[17px]" : "max-sm:text-[22px]!"} ${shown ? "placeholder:text-foreground" : "placeholder:text-[var(--faint)]"}`}
      />
      {/* What it's for, in one or two lines. */}
      <textarea
        aria-label="What it's for"
        rows={1}
        value={draft?.purpose ?? ""}
        placeholder={says}
        readOnly={!draft}
        onChange={(e) => setText({ purpose: e.target.value.replace(/\n/g, " ") })}
        className={`${inPlace} mt-1 field-sizing-content max-h-10 resize-none overflow-hidden text-[13px] leading-5 text-muted-foreground placeholder:text-muted-foreground ${compact ? "max-sm:mt-0 max-sm:line-clamp-1" : ""}`}
      />
    </>
  );
}

/**
 * The identity card: a large face, the name under it, one line of what it's for, then what it can
 * do, a row for each unit chosen at the right. The name and the line are typed here, in place, with
 * no box; the card is centred on its height. Narrow, it sits on top, compact.
 */
function IdentityCard() {
  const { draft, named, face } = useCardWords();
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
          <TypedInPlace compact />
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

/**
 * What a template starts from: Empty or a template, small cards of a title and what it is, in a
 * row that scrolls sideways.
 */
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
 * The template an agent starts from, a small badge at the card's top left: its sign and its title,
 * a shade darker under the pointer. Pressed, a card opens over it with Empty and the templates,
 * each with what it is; choosing one starts the agent from it and keeps what was typed.
 */
function TemplateBadge() {
  const { catalog, choosing, start } = useBuilding();
  const from = choosing?.from;
  const Sign = from ? LayersIcon : CircleDashedIcon;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Template: ${from?.title ?? "Empty"}`}
          className="flex h-7 max-w-[60%] min-w-0 items-center gap-1.5 rounded-full bg-[var(--hover)] pr-3 pl-2 text-[13px] text-muted-foreground outline-none hover:bg-[var(--selected)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-[var(--selected)] aria-expanded:text-foreground"
        >
          <Sign aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{from?.title ?? "Empty"}</span>
        </button>
      </DropdownMenuTrigger>
      {/* In place: its top left on the badge's, and its heading where the badge is, so the press
          that opens it lets go on the heading and chooses nothing. */}
      <DropdownMenuContent align="start" sideOffset={-28} className="w-64 rounded-xl p-0 pb-1.5">
        <DropdownMenuLabel className="flex h-7 items-center px-3 text-xs font-normal text-muted-foreground">
          Start from
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={from?.id ?? ""}
          onValueChange={(id) =>
            start(
              catalog.templates.find((t) => t.id === id),
              "agent",
            )
          }
        >
          <DropdownMenuRadioItem value="" className="mx-1.5 flex-col items-start gap-0 rounded-lg">
            <span>Empty</span>
            <span className="text-xs text-muted-foreground">Nothing to start with</span>
          </DropdownMenuRadioItem>
          {catalog.templates.map((t) => (
            <DropdownMenuRadioItem
              key={t.id}
              value={t.id}
              className="mx-1.5 flex-col items-start gap-0 rounded-lg"
            >
              <span>{t.title}</span>
              <span className="text-xs text-muted-foreground">{t.description}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Create for an agent, one card. At its top left, the template it starts from; then its avatar,
 * chosen from a row of them, each with a name, the one in the middle being the choice; its name
 * and what it's for, typed in place, the name offered being the avatar's until one is typed; and
 * Create, which sends the template's stack as saved with the name, what it's for and the avatar.
 * What Create's check refuses, of the whole stack or of a unit, is said above Create in the
 * service's words: the only place a unit's state shows.
 */
function CreateCard() {
  const { draft, hide, refreshUnits, setProblems } = useBuilding();
  const { taken, loaded } = useTaken();
  // The avatar in the middle of the row, with its name: none until the agents are read.
  const [chosen, setChosen] = useState<Pair>();
  const { named } = useCardWords(chosen?.name);
  const act = useAct();
  // Made while signed out of the model account, an agent can't work yet: the foot says so.
  const needs = needsOf(useLogin());
  // What its units still need isn't asked here: Create's check says what can't be made.
  const ready = !!draft?.base && !!named && draft.units.every((u) => u.unit);
  const finish = () => {
    if (!draft || !ready) return;
    const name = nameOf(draft, chosen?.name ?? "");
    const purpose = draft.purpose.trim();
    const stack = toStack(draft);
    act.run(async () => {
      // A form can change while it's open: what it gives is shown as it now is before it's used.
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
        ...(chosen ? { avatar: chosen.avatar } : {}),
      });
      // It closes, and Settings too if it was opened over it: the new agent is shown in Team.
      hide();
      closeSettings();
      go({ screen: "team", agent });
    });
  };
  const refused = act.failed ?? draft?.problems.map((p) => p.message).join(" ");
  return (
    <form
      aria-label="Create"
      className={CREATE.card}
      onSubmit={(event) => {
        event.preventDefault();
        finish();
      }}
    >
      <DialogTitle className="sr-only">Create New Agent</DialogTitle>
      <DialogDescription className="sr-only">
        The template it starts from, its avatar and name, and what it's for
      </DialogDescription>
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-3">
        <TemplateBadge />
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
            <XIcon />
          </Button>
        </DialogClose>
      </header>
      {/* Between its head and its foot, the card scrolls where the page is shorter than it. */}
      <div className="no-bar flex min-h-0 flex-col overflow-y-auto">
        {/* The row's height is kept while the agents, whose names it must not offer, are read. */}
        <div className={CREATE.row}>
          {loaded && <AvatarRow taken={taken} onChoose={setChosen} />}
        </div>
        <div className="mt-3 w-full min-w-0 shrink-0 px-10 text-center max-[30rem]:px-6">
          <TypedInPlace offered={chosen?.name} />
        </div>
        {refused && (
          <p
            role="alert"
            className="mt-4 shrink-0 px-10 text-center text-[13px] text-[var(--bad)] max-[30rem]:px-6"
          >
            {refused}
          </p>
        )}
      </div>
      <footer className="flex min-h-[92px] shrink-0 flex-col items-center gap-3 px-10 pt-6 pb-7">
        {draft && needs && (
          <span className="text-center text-[13px] text-muted-foreground">{needs}</span>
        )}
        {draft && (
          <Button
            type="submit"
            disabled={!ready || act.busy}
            className="h-10 rounded-full px-6 text-[15px]"
          >
            Create
          </Button>
        )}
      </footer>
    </form>
  );
}

/**
 * What opens and closes what the agent can do, at the name card's right edge whether it is open
 * or not. The bar is a second card's edge under the name card: with the pointer or the keyboard
 * on the edge it slides out to the right, 14 of it, with an arrow and the name card's light
 * shadow on it, and the name card keeps its outline over it. Closed, the arrow points out; open,
 * the bar comes out over the start of what it can do and its arrow points back. Where nothing
 * hovers, as on a touch screen, the bar stands out. Where what it can do opens under the card, it
 * is a thin bar along the card's foot.
 */
function Edge({ detail, toggle }: { detail: boolean; toggle(next: boolean): void }) {
  return (
    <>
      <button
        type="button"
        data-edge
        aria-label="What it can do"
        aria-expanded={detail}
        aria-controls="create-detail"
        onClick={() => toggle(!detail)}
        className={CREATE.edge}
      >
        <span aria-hidden className={CREATE.foot}>
          <ChevronRightIcon className={`size-3 shrink-0 ${detail ? "-rotate-90" : "rotate-90"}`} />
        </span>
      </button>
      <span aria-hidden data-edge-bar className={CREATE.tab}>
        <span className={CREATE.tabShade} />
        <span className={CREATE.tabOut}>
          <ChevronRightIcon className={`size-3 shrink-0 ${detail ? "rotate-180" : ""}`} />
        </span>
      </span>
    </>
  );
}

/**
 * What the agent will be able to do, as the template gives it, on the window's other ground:
 * each unit with its logo, its title, its own line and what it gives. Shown, not asked. It is a
 * card of its own under the name card, out at the card's right, or under the card where the page
 * has no room there; the name card's shadow falls on it, very light, strongest at the card and
 * gone 20 from it. Closed, it is behind the name card, not drawn and out of reach; under the
 * card, it isn't there.
 */
function Detail({ shown, drawn }: { shown: boolean; drawn: boolean }) {
  const { draft } = useBuilding();
  return (
    <section
      id="create-detail"
      aria-label="What it can do"
      aria-hidden={!shown}
      inert={!shown}
      className={`${CREATE.detail} ${shown ? "" : "max-md:hidden"} ${drawn ? "" : "md:invisible"}`}
    >
      {/* The name card's shadow, while this is open. */}
      {shown && <span aria-hidden className={CREATE.shade} />}
      <div className={CREATE.detailInner}>
        <h3 className="flex h-6 shrink-0 items-center text-[13px] font-medium text-muted-foreground">
          What it can do
        </h3>
        {draft?.units.length === 0 && (
          <p className="text-[13px] text-muted-foreground">Nothing yet.</p>
        )}
        <ul className="flex flex-col gap-4 empty:hidden">
          {draft?.units.map((entry) => (
            <li key={entry.key} className="flex min-w-0 gap-3">
              <Tile logo={logoOf(entry.unit)} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex h-7 items-center truncate text-[15px] font-medium">
                  {entry.unit?.title ?? entry.id}
                </span>
                {entry.unit ? (
                  <>
                    <UnitLine unit={entry.unit} />
                    <Gives unit={entry.unit} values={entry.values} />
                  </>
                ) : (
                  <p className="text-xs text-[var(--bad)]">Not available here.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
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
 * A template's options: the title and the close on one line; what to start from; then the
 * sections, each a heading and what it asks; and at the foot, Save template.
 */
function Options() {
  const building = useBuilding();
  const { catalog, draft, hide, saveTemplate } = building;
  // What can be added: a unit a stack holds once isn't offered while the stack has it.
  const addable = catalog.units.filter(
    (unit) =>
      !unit.once ||
      !draft?.units.some((held) => held.unit?.provider === unit.provider && held.id === unit.id),
  );
  const act = useAct();
  const ready = !!draft && isReady(draft);
  const finish = () => {
    if (!draft || !ready) return;
    const name = nameOf(draft, "");
    const purpose = draft.purpose.trim();
    act.run(async () => {
      await saveTemplate(name, purpose);
      hide();
      // Back to the templates, in Settings, whether or not it was opened over it.
      openSettings("templates");
    });
  };
  const refused = act.failed;
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
    <form
      aria-label="Build"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        finish();
      }}
    >
      {/* The title and the close in one line, centred on it. */}
      <header className="flex h-14 shrink-0 items-center gap-1 pr-3 pl-5 max-sm:sr-only">
        <DialogTitle className="min-w-0 flex-1 truncate text-[17px] font-semibold">
          New template
        </DialogTitle>
        <span className="flex items-center gap-1 max-sm:hidden">
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
          {refused && (
            <p role="alert" className="min-w-0 flex-1 text-[13px] text-[var(--bad)]">
              {refused}
            </p>
          )}
          <Button
            type="submit"
            disabled={!ready || act.busy}
            className="h-10 rounded-full px-5 text-[15px]"
          >
            Save template
          </Button>
        </footer>
      )}
    </form>
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

/**
 * A unit's own line, what it says it is, as the base's line is drawn: whole, as long as it is.
 * `inset` lines it up with questions set in by their section.
 */
export function UnitLine({
  unit,
  inset = false,
}: {
  unit: CatalogUnit | undefined;
  inset?: boolean;
}) {
  if (!unit?.description) return null;
  return (
    <p className={`${inset ? "px-0.5 " : ""}text-[13px] text-muted-foreground`}>
      {unit.description}
    </p>
  );
}

/**
 * A unit's section: its heading with its fold and its remove; under it the unit's own line; then
 * its questions as they were. Folded, it is its heading alone.
 */
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
  // The section's own: those on no field, and on a field its form doesn't have, which no question
  // would show, such as an answer a template kept that the unit no longer asks.
  const general = problems.filter((p) => !p.field || !unit?.form.some((f) => f.id === p.field));
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
        <div className="flex flex-col gap-3">
          <UnitLine unit={unit} inset />
          <div className="flex flex-col gap-3 px-0.5 empty:hidden">
            {!unit && <p className="text-xs text-[var(--bad)]">Not available here.</p>}
            {unit && (
              <UnitForm
                unit={unit}
                id={`unit-${key}`}
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
      <Gives unit={unit} values={values} />
    </>
  );
}

/** What a unit gives with these answers: the slots of its connections, and its skills. */
function Gives({ unit, values }: { unit: CatalogUnit; values: Values }) {
  const gives = givesOf(unit, values);
  if (gives.slots.length === 0 && gives.skills.length === 0) return null;
  return (
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
  );
}
