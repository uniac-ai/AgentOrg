// The AgentOrg app's window, as the design draws it: whether AgentOrg has connected, then "Agent
// Control", each part of this Mac a card of its own with the person's switch. Screen lists its two
// grants, each with its own Grant, while one is missing. Your browser opens and closes, listing
// Chrome and Edge, each with its own Set up. macOS's own requests, its System Settings and the
// browser's inspect page are the system's: the page asks for them through the app, and reads again.
import { ChevronDownIcon, FolderIcon, GlobeIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Acting,
  type AppState,
  type Capability,
  type Computer,
  type Connection,
  isRefusal,
  type Mac,
  type Need,
  type NeedName,
  type NeedState,
  type Setup,
} from "./mac.ts";
import { Button } from "./ui/button.tsx";
import { Switch } from "./ui/switch.tsx";

/** What the page has read, all at once. */
interface Reading {
  app: AppState;
  setup?: Setup | undefined;
  connection?: Connection | undefined;
  computers: Computer[];
  acting: Acting[];
}
type Phase = "starting" | "waiting" | "connected" | "restarting";
/**
 * Until the first reading, the window shows only its title bar; if none has come after a while,
 * it says it is starting again, as when the app brings the service back, so it is never blank.
 */
const phaseOf = (reading: Reading, late: boolean): Phase =>
  !reading.setup
    ? late
      ? "restarting"
      : "starting"
    : reading.app === "starting again"
      ? "restarting"
      : reading.connection?.connected
        ? "connected"
        : "waiting";

const GRANTS: NeedName[] = ["screen-recording", "accessibility"];
const NAMES: Partial<Record<NeedName, string>> = {
  "screen-recording": "Screen Recording",
  accessibility: "Accessibility",
  chrome: "Chrome",
  edge: "Edge",
};
const nameOf = (need: Need) => need.name ?? NAMES[need.need] ?? need.need;
const WORD: Record<NeedState, string> = {
  granted: "Granted",
  "not-granted": "Not granted",
  unknown: "Unknown",
  off: "Off",
  on: "On",
  missing: "Not installed",
};
const DOT: Record<NeedState, string> = {
  granted: "bg-[var(--ok)]",
  on: "bg-[var(--ok)]",
  "not-granted": "bg-[var(--warn)]",
  off: "bg-[var(--warn)]",
  missing: "bg-[var(--faint)]",
  unknown: "bg-[var(--faint)]",
};

/** "10:42": when AgentOrg's first connection began, in this Mac's time. */
const clock = (at: string) => {
  const time = new Date(at);
  return `${time.getHours()}:${String(time.getMinutes()).padStart(2, "0")}`;
};

/** Who this Mac is lent to: each computer's name, the earliest first. */
const lent = (computers: Computer[]) =>
  computers
    .toSorted((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
    .map((c) => c.name)
    .join(", ");

/** The grants seen granted, kept so that one turned off later reads as turned off, not never granted. */
const KEPT = "agentorg.mac.granted";
const keptGrants = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEPT) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
/** Forget them: for the stand-in, which is a fresh Mac each time the page opens. */
export const forgetGrants = () => {
  try {
    localStorage.removeItem(KEPT);
  } catch {
    // Nothing kept.
  }
};
const keepGrants = (grants: Set<string>) => {
  try {
    localStorage.setItem(KEPT, JSON.stringify([...grants]));
  } catch {
    // Without storage, a grant turned off reads as not granted.
  }
};

/** An agent's colours, from its id, onto one of 24 hues, as the shell works them out. */
const hueOf = (id: string) =>
  (([...id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261) >>> 23) %
    24) *
  15;
/** Someone acting: the person as "You", an agent by name, with its id for its face. */
interface Actor {
  name: string;
  person?: boolean;
  agent?: string | undefined;
}
const Face = ({ name, agent }: Actor) => {
  const h = hueOf(agent ?? name);
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white"
      style={{
        background: `linear-gradient(140deg, oklch(0.8 0.11 ${h}), oklch(0.6 0.14 ${(h + 48) % 360}))`,
      }}
    >
      {[...name][0]}
    </span>
  );
};

/** A state with its dot, for a table's second column: every dot starts in one line. */
const Standing = ({ state }: { state: NeedState }) => (
  <span className="flex items-center gap-1.5 text-muted-foreground">
    <span className={`inline-block size-1.5 shrink-0 rounded-full ${DOT[state]}`} />
    {WORD[state]}
  </span>
);

const small = "h-7 shrink-0 rounded-full px-3 text-[13px]";

/** One card: an icon, a title, a line only where the title alone would mislead, and its switch. */
function Card({
  icon: Icon,
  title,
  line,
  warn,
  acting,
  on,
  disabled,
  onSwitch,
  chevron,
  children,
}: {
  icon: typeof TerminalIcon;
  title: string;
  line?: string | undefined;
  warn?: boolean;
  acting?: Actor[] | undefined;
  on: boolean;
  disabled: boolean;
  onSwitch(on: boolean): void;
  /** A card that opens and closes: whether it is open, and the way to change it. */
  chevron?: { open: boolean; toggle(): void };
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`rounded-2xl bg-[rgb(35,35,35)] ring-1 ring-[var(--line)] ${disabled ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[rgb(50,50,50)]">
          <Icon className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-medium">{title}</span>
          {line && (
            <span
              className={`text-[13px] ${warn ? "text-[var(--warn)]" : "text-muted-foreground"}`}
            >
              {line}
            </span>
          )}
          {on && acting && acting.length > 0 && (
            <span className="mt-0.5 flex items-center gap-1.5 text-[13px]">
              <span className="pulse inline-block size-1.5 shrink-0 rounded-full bg-[var(--ok)]" />
              {acting
                .filter((actor) => !actor.person)
                .map((actor) => (
                  <Face key={actor.name} {...actor} />
                ))}
              {acting.map((actor) => actor.name).join(", ")}, now
            </span>
          )}
        </div>
        {chevron && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={chevron.open ? `Close ${title}` : `Open ${title}`}
            aria-expanded={chevron.open}
            className="text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground"
            disabled={disabled}
            onClick={chevron.toggle}
          >
            <ChevronDownIcon
              className={`transition-transform motion-reduce:transition-none ${chevron.open ? "rotate-180" : ""}`}
            />
          </Button>
        )}
        <Switch aria-label={title} checked={on} disabled={disabled} onCheckedChange={onSwitch} />
      </div>
      {children && <div className="border-t border-[var(--line)] px-4 py-2 pl-16">{children}</div>}
    </section>
  );
}

/** A table of what a card lists: the name, how it stands, and its own button where it has one. */
function Rows({
  label,
  rows,
}: {
  label: string;
  rows: {
    name: string;
    state: NeedState;
    button?: { title: string; press(): void } | undefined;
  }[];
}) {
  return (
    <table aria-label={label} className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="h-9">
            <th scope="row" className="pr-6 text-left font-normal whitespace-nowrap">
              {row.name}
            </th>
            <td className="w-full">
              <Standing state={row.state} />
            </td>
            <td className="text-right">
              {row.button && (
                <Button variant="secondary" className={small} onClick={row.button.press}>
                  {row.button.title}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The window's header, under macOS's own buttons: its name, centred, and where it is dragged by. */
const Header = () => (
  <header
    data-tauri-drag-region
    className="sticky top-0 z-10 flex h-9 shrink-0 items-center justify-center bg-[rgb(25,25,25)]"
  >
    <span data-tauri-drag-region className="text-[13px] font-medium text-muted-foreground">
      AgentOrg
    </span>
  </header>
);

/** How often the page reads again while the window shows. */
const EVERY = 2000;
/** How long the window waits for its first reading with only its title bar. */
const FIRST = 5000;

export function Window({ mac }: { mac: Mac }) {
  const [reading, setReading] = useState<Reading>({ app: "starting", computers: [], acting: [] });
  /** What the service said when it refused a card's switch or ask, until that card next goes well. */
  const [refused, setRefused] = useState<Partial<Record<Capability, string>>>({});
  const [browserOpen, setBrowserOpen] = useState<boolean>();
  const [granted, setGranted] = useState(keptGrants);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), FIRST);
    return () => clearTimeout(timer);
  }, []);
  const busy = useRef<Promise<void> | undefined>(undefined);
  const readAgain = useRef(false);

  /** A setup the service answered with: kept, and each grant it shows granted remembered. */
  const took = useCallback((setup: Setup) => {
    setReading((was) => ({ ...was, setup }));
    const now = setup.capabilities
      .flatMap((c) => c.needs)
      .filter((n) => GRANTS.includes(n.need) && n.state === "granted")
      .map((n) => n.need);
    setGranted((was) => {
      if (now.every((n) => was.has(n))) return was;
      const next = new Set([...was, ...now]);
      keepGrants(next);
      return next;
    });
    setRefused((was) => {
      const ready = setup.capabilities.filter((c) => c.ready && was[c.capability]);
      if (ready.length === 0) return was;
      const next = { ...was };
      for (const c of ready) delete next[c.capability];
      return next;
    });
  }, []);

  const read = useCallback(async (): Promise<void> => {
    if (busy.current) {
      readAgain.current = true;
      return busy.current;
    }
    busy.current = (async () => {
      try {
        // What doesn't answer this time, as while the app starts the service again, keeps its
        // last reading.
        const [app, setup, connection, computers, acting] = await Promise.allSettled([
          mac.appState(),
          mac.setup(),
          mac.connection(),
          mac.computers(),
          mac.acting(),
        ]);
        // While the app starts the driver again, the grants can't be read: the cards keep theirs.
        const unread = app.status === "fulfilled" && app.value === "starting again";
        if (setup.status === "fulfilled" && !unread) took(setup.value);
        setReading((was) => ({
          ...was,
          ...(app.status === "fulfilled" && { app: app.value }),
          ...(connection.status === "fulfilled" && { connection: connection.value }),
          ...(computers.status === "fulfilled" && { computers: computers.value }),
          ...(acting.status === "fulfilled" && { acting: acting.value }),
        }));
      } finally {
        busy.current = undefined;
        if (readAgain.current) {
          readAgain.current = false;
          void read();
        }
      }
    })();
    return busy.current;
  }, [mac, took]);

  useEffect(() => {
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, EVERY);
    const now = () => void read();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    const stop = mac.onChanged(now);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
      stop();
    };
  }, [mac, read]);

  /** A card's switch or a row's button: what the service answers is the new setup, or its words. */
  const act = async (capability: Capability, run: () => Promise<Setup>) => {
    try {
      const setup = await run();
      setRefused(({ [capability]: _, ...rest }) => rest);
      took(setup);
      return setup;
    } catch (error) {
      if (isRefusal(error)) setRefused((was) => ({ ...was, [capability]: error.message }));
      void read();
      return undefined;
    }
  };

  const page = useRef<HTMLDivElement>(null);
  const phase = phaseOf(reading, late);
  // The window fits the page, as the design's does; while the app starts it keeps its size.
  useLayoutEffect(() => {
    const el = page.current;
    if (!el || phase === "starting") return;
    const fit = () => mac.fit(Math.ceil(el.getBoundingClientRect().height));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [mac, phase]);

  const { setup } = reading;
  const part = (capability: Capability) =>
    setup?.capabilities.find((c) => c.capability === capability);
  const screen = part("screen");
  const browser = part("browser");
  const grants = (screen?.needs ?? []).filter((n) => GRANTS.includes(n.need));
  const browsers = browser?.needs ?? [];
  const browserOn = browsers.find((n) => n.state === "on");
  const screenShort = !!screen?.on && !screen.ready;
  const browserShort = !!browser?.on && !browser.ready;
  const open = browserOpen ?? browserShort;
  const withdrawn = grants.find((n) => n.state === "not-granted" && granted.has(n.need));
  const restarting = phase === "restarting";

  /** Who is acting on a part now: "You" for the person, each agent by name, once each. */
  const now = (capability: Capability): Actor[] | undefined => {
    if (phase !== "connected") return undefined;
    const actors = new Map<string, Actor>();
    for (const a of reading.acting.filter((a) => a.capability === capability)) {
      if (a.who === "person") actors.set("You", { name: "You", person: true });
      else if (a.name) {
        const agent = reading.computers.find((c) => c.name === a.name)?.metadata?.agent;
        actors.set(a.name, { name: a.name, agent });
      }
    }
    return [...actors.values()];
  };
  const onSwitch = async (capability: Capability, on: boolean) => {
    const answered = await act(capability, () => mac.setSwitch(capability, on));
    const after = answered?.capabilities.find((c) => c.capability === capability);
    if (capability === "browser" && on && after && !after.needs.some((n) => n.state === "on"))
      setBrowserOpen(true);
  };

  if (phase === "starting")
    return (
      <div ref={page}>
        <Header />
      </div>
    );

  const first = reading.connection?.clients[0];
  const says =
    phase === "connected" && first
      ? [`Since ${clock(first.since)}`, lent(reading.computers)].filter(Boolean).join(" · ")
      : "";
  const title =
    phase === "connected"
      ? "Connected to AgentOrg"
      : restarting
        ? "Starting again"
        : "Waiting for AgentOrg to connect";
  const holder = grants.find((n) => n.holder)?.holder;

  return (
    <div ref={page} className="flex flex-col">
      <Header />
      <div className="flex flex-col gap-5 px-5 pt-4 pb-5">
        <div className="flex flex-col items-center gap-1.5 px-6 text-center">
          <span className="relative grid size-11 place-items-center">
            {/* Waiting only: a pulse from the circle, behind it, every few seconds. Connected: a steady green ring. */}
            {phase === "waiting" && (
              <span
                aria-hidden
                data-pulse
                className="ripple absolute inset-0 rounded-full bg-[rgb(50,50,50)]"
              />
            )}
            <span
              data-circle
              className={`relative grid size-11 place-items-center rounded-full ${phase === "connected" ? "bg-[rgb(50,50,50)] ring-[1.5px] ring-[var(--ok)]" : "bg-[rgb(35,35,35)]"}`}
            >
              <MonitorIcon
                className={`size-5 ${phase === "connected" ? "" : "text-muted-foreground"}`}
              />
            </span>
          </span>
          <h1 className="relative text-[17px] font-semibold">{title}</h1>
          {says && <p className="relative text-[13px] text-muted-foreground">{says}</p>}
        </div>
        <div className="flex flex-col gap-2.5">
          <h2 className="text-[14px] font-medium">Agent Control</h2>
          <Card
            icon={TerminalIcon}
            title="Terminal"
            line={refused.terminal}
            warn
            acting={now("terminal")}
            on={!!part("terminal")?.on}
            disabled={restarting}
            onSwitch={(on) => void onSwitch("terminal", on)}
          />
          <Card
            icon={FolderIcon}
            title="Files"
            line={refused.files}
            warn
            acting={now("files")}
            on={!!part("files")?.on}
            disabled={restarting}
            onSwitch={(on) => void onSwitch("files", on)}
          />
          <Card
            icon={MonitorIcon}
            title="Screen"
            line={
              refused.screen ??
              (withdrawn ? `${nameOf(withdrawn)} turned off` : "Sees and controls it")
            }
            warn={!!refused.screen || !!withdrawn}
            acting={now("screen")}
            on={!!screen?.on}
            disabled={restarting}
            onSwitch={(on) => void onSwitch("screen", on)}
          >
            {screenShort && grants.length > 0 && (
              <>
                {holder && <div className="pt-1 text-xs text-[var(--faint)]">{holder}</div>}
                <Rows
                  label="What Screen needs"
                  rows={grants.map((n) => ({
                    name: nameOf(n),
                    state: n.state,
                    button:
                      n.state === "granted"
                        ? undefined
                        : {
                            title: "Grant",
                            press: () => void act("screen", () => mac.ask("screen", n.need)),
                          },
                  }))}
                />
              </>
            )}
          </Card>
          <Card
            icon={GlobeIcon}
            title="Your browser"
            line={
              refused.browser ??
              (browserOn
                ? `${nameOf(browserOn)}, signed in as you`
                : browser?.on
                  ? "No browser set up"
                  : "Signed in as you")
            }
            warn={!!refused.browser || browserShort}
            acting={now("browser")}
            on={!!browser?.on}
            disabled={restarting}
            onSwitch={(on) => void onSwitch("browser", on)}
            chevron={{ open, toggle: () => setBrowserOpen(!open) }}
          >
            {open && browsers.length > 0 && (
              <Rows
                label="Browsers"
                rows={browsers.map((n) => ({
                  name: nameOf(n),
                  state: n.state,
                  button:
                    n.state === "off"
                      ? {
                          title: "Set up",
                          press: () => void act("browser", () => mac.ask("browser", n.need)),
                        }
                      : undefined,
                }))}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
