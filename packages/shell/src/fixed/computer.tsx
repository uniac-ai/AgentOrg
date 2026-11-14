// An agent's computer: one frame with a dock, and one window in front. Its browser, its
// terminals and its files are equal parts of it: each is a surface the computer lists, and each window is
// chosen by its surface's protocol alone, never by which provider or unit offers it. So a
// computer with no browser has no Browser, and a new kind of surface is one more window here.
//
// A computer's views are one set, however many of its frames are drawn: they are held above the
// frames and put in the one that shows them. So a window keeps what it had when the computer is
// opened in the layer, and only one view of a surface is ever open. A window with something of
// its own to lose (the folder it was in, where it was scrolled to, a file on its way, the
// terminal in front) also keeps it while another is in front: it stays under that one, unseen.
import { FolderIcon, GlobeIcon, Maximize2Icon, TerminalIcon, XIcon } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button.tsx";
import { ScreencastView } from "./browser-view.tsx";
import { useComputers } from "./computers.tsx";
import { type AgentDetail, reasonOf, type Tone } from "./data.ts";
import { Face, tintOf } from "./face.tsx";
import { FilesView } from "./files-view.tsx";
import type { LiveTarget } from "./live-socket.ts";
import { Refusal } from "./parts.tsx";
import { TerminalsView } from "./terminals.tsx";
import { clause } from "./words.ts";

/** One surface of one of the agent's units, as its status says. */
export interface OpenSurface {
  instance: string;
  surface: string;
  protocol: string;
  operate: boolean;
  unavailable?: string | undefined;
}
/**
 * What a window is given: the surface to open, what goes in the corner of its first row, and
 * whether it is the one in front. One kept behind another isn't seen, so it reads nothing again.
 */
export interface ViewerProps {
  target: LiveTarget;
  corner?: ReactNode;
  front: boolean;
}
export const targetOf = (agent: string, surface: OpenSurface): LiveTarget => ({
  agent,
  instance: surface.instance,
  surface: surface.surface,
  mode: surface.operate ? "operate" : "watch",
});

/**
 * The windows there are, in the dock's order: each draws the surfaces of one protocol. One that
 * `keeps` has something of its own to lose, so its view stays open behind another window. What a
 * browser shows is all on the computer: behind, its view is closed, and it is opened again.
 */
const WINDOWS: {
  kind: string;
  title: string;
  icon: typeof GlobeIcon;
  protocol: string;
  View: ComponentType<ViewerProps>;
  keeps?: true;
}[] = [
  {
    kind: "browser",
    title: "Browser",
    icon: GlobeIcon,
    protocol: "screencast@1",
    View: ScreencastView,
  },
  {
    kind: "terminal",
    title: "Terminal",
    icon: TerminalIcon,
    protocol: "terminal@1",
    View: TerminalsView,
    keeps: true,
  },
  {
    kind: "files",
    title: "Files",
    icon: FolderIcon,
    protocol: "files@1",
    View: FilesView,
    keeps: true,
  },
];

/** What an agent's units can show live, each with the unit it is of. */
export const surfacesOf = (detail: AgentDetail | undefined): OpenSurface[] =>
  (detail?.units ?? []).flatMap((unit) =>
    (unit.status.surfaces ?? []).map((surface) => ({ ...surface, instance: unit.instance })),
  );

/** The windows a computer has now: one for each kind of surface it lists that can be opened. */
export const windowsOf = (surfaces: readonly OpenSurface[]) =>
  WINDOWS.flatMap((window) => {
    const surface = surfaces.find((s) => !s.unavailable && s.protocol === window.protocol);
    return surface ? [{ ...window, surface }] : [];
  });

/**
 * The frame: the computer's name, the window in front, and the dock. In the layer it stands
 * apart from any page, so it also says whose it is and closes by its own Close; there it is as
 * large as it gets, so its windows have no Expand.
 */
export function Computer({
  agent,
  surfaces,
  onStart,
  down,
  mend,
  overlay = false,
}: {
  agent: { id: string; name: string; tone: Tone };
  surfaces: readonly OpenSurface[];
  /** Starts its agent, which is how a stopped one's computer comes back. */
  onStart(): Promise<unknown>;
  /** Down, why, as the computer says it: its windows can't be opened until it is back. */
  down?: string | undefined;
  /** Down, the ways to mend it its provider offers, under what to call it. */
  mend?: { heading: string; ways: { title: string; take(): void }[] } | undefined;
  overlay?: boolean;
}) {
  const { picked, pick, close, draw, erase } = useComputers();
  // A Start pressed here and refused says why at this window's foot, until it is pressed again or
  // the agent is no longer stopped. One press at a time.
  const [refused, setRefused] = useState<string>();
  const [starting, setStarting] = useState(false);
  const stopped = agent.tone === "stopped";
  useEffect(() => {
    if (!stopped) setRefused(undefined);
  }, [stopped]);
  const start = () => {
    if (starting) return;
    setRefused(undefined);
    setStarting(true);
    onStart()
      .catch((error: unknown) => setRefused(reasonOf(error)))
      .finally(() => setStarting(false));
  };
  const windows = windowsOf(surfaces);
  // The window in front is the one picked. Nothing follows the agent: it may be in several at once.
  const front = windows.find((w) => w.kind === picked[agent.id]) ?? windows[0];
  // Where this frame's window goes. The views are put there by what holds them: while the
  // computer is open in the layer, the frame on its page holds the window's place, empty.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const listed = JSON.stringify(surfaces);
  // Both before anything is painted: a frame is never seen without its views, nor a view in a
  // frame that has gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listed` says when `surfaces` changed.
  useLayoutEffect(() => {
    if (slot) draw({ agent: agent.id, overlay, slot, surfaces });
    else erase(agent.id, overlay);
  }, [agent.id, overlay, slot, listed, draw, erase]);
  useLayoutEffect(() => () => erase(agent.id, overlay), [agent.id, overlay, erase]);
  if (!front && down === undefined) return null;
  return (
    <section
      aria-label={`${agent.name}'s computer`}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--canvas)] ${overlay ? "h-full w-full rounded-3xl shadow-2xl phone:rounded-none" : "h-[620px] rounded-2xl tight:h-[560px]"}`}
      style={{
        backgroundImage: `linear-gradient(155deg, ${tintOf(agent.id).soft}, transparent 62%)`,
      }}
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
        <h3 className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          {overlay && <Face agent={agent} size={20} plain />}
          <span className="truncate">{agent.name}'s computer</span>
        </h3>
        {overlay && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Close ${agent.name}'s computer`}
            onClick={close}
          >
            <XIcon />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 px-2.5">
        {stopped ? (
          <div
            key="stopped"
            className="window relative grid h-full place-items-center rounded-xl bg-background"
          >
            <div className="flex flex-col items-center gap-3 text-[15px]">
              <span className="text-muted-foreground">{agent.name} is stopped</span>
              <Button className="h-9 rounded-full px-4" disabled={starting} onClick={start}>
                Start
              </Button>
            </div>
            {refused && <Refusal>{`It couldn't be started: ${clause(refused)}`}</Refusal>}
          </div>
        ) : down !== undefined ? (
          <div
            key="down"
            className="window relative grid h-full place-items-center rounded-xl bg-background"
          >
            {mend ? (
              // With ways to mend it: what it is, the provider's words, and a button for each way,
              // the first as the one to take.
              <div className="flex w-[min(420px,86%)] flex-col gap-3 text-[15px]">
                <span>{mend.heading}</span>
                {down && (
                  <p className="text-[13px] leading-5 text-muted-foreground">
                    {`${down.charAt(0).toUpperCase()}${down.slice(1)}`}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {mend.ways.map((way, i) => (
                    <Button
                      key={way.title}
                      variant={i === 0 ? "default" : "secondary"}
                      className="h-9 rounded-full px-4"
                      onClick={way.take}
                    >
                      {way.title}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <span className="max-w-[440px] px-6 text-center text-[15px] text-muted-foreground">
                {down
                  ? `${down.charAt(0).toUpperCase()}${down.slice(1)}`
                  : `${agent.name}'s computer is down`}
              </span>
            )}
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a window of the frame, not a form.
          <div
            key="window"
            ref={setSlot}
            role="group"
            aria-label={front?.title}
            className="window relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl bg-background shadow-lg"
          />
        )}
      </div>
      {/* A stopped computer has no dock; its place stays. */}
      <div className="flex h-[68px] shrink-0 items-center justify-center">
        {!stopped && down === undefined && (
          <nav
            aria-label="Dock"
            className="flex gap-1.5 rounded-2xl bg-background/70 p-1.5 backdrop-blur"
          >
            {windows.map(({ kind, title, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                aria-label={title}
                aria-current={front?.kind === kind ? "true" : undefined}
                title={title}
                onClick={() => pick(agent.id, kind)}
                className={`relative grid size-11 place-items-center rounded-xl ${front?.kind === kind ? "bg-[var(--selected)] text-foreground" : "text-muted-foreground hover:bg-[var(--hover)]"}`}
              >
                <Icon className="size-5" />
              </button>
            ))}
          </nav>
        )}
      </div>
    </section>
  );
}

/**
 * Every computer that has a frame drawn, with its one set of views. It is drawn once, above the
 * page and the layer, so a view outlives the frame it is shown in.
 */
export function ComputerViews() {
  const { frames } = useComputers();
  return [...new Set(frames.map((frame) => frame.agent))].map((agent) => (
    <Views key={agent} agent={agent} />
  ));
}

/** Where a window's view is drawn, and where each thing that scrolls in it is. */
interface Kept {
  host: HTMLElement;
  places: Map<Element, readonly [top: number, left: number]>;
}
function keep(): Kept {
  const host = document.createElement("div");
  const places: Kept["places"] = new Map();
  // What is moved to another frame forgets where it was scrolled to, so that is noted as it changes.
  host.addEventListener(
    "scroll",
    ({ target }) => {
      if (!(target instanceof Element)) return;
      places.set(target, [target.scrollTop, target.scrollLeft]);
      for (const part of places.keys()) if (!part.isConnected) places.delete(part);
    },
    { capture: true, passive: true },
  );
  return { host, places };
}

/** One computer's views: the window in front, and those kept behind it as they were left. */
function Views({ agent }: { agent: string }) {
  const { frames, picked, open } = useComputers();
  // Its window in the layer shows them while it is open; else the frame on its page.
  const mine = frames.filter((frame) => frame.agent === agent);
  const live = mine.find((frame) => frame.overlay) ?? mine[0];
  const windows = windowsOf(live?.surfaces ?? []);
  const front = windows.find((w) => w.kind === picked[agent]) ?? windows[0];
  /** The windows it has had in front, and where each one's view is drawn. */
  const kept = useRef(new Map<string, Kept>());
  if (front && !kept.current.has(front.kind)) kept.current.set(front.kind, keep());
  // They are all in the frame that shows them, each filling it: the one in front seen, the others
  // under it unseen. Being seen is all that changes, so each stays the size it was and nothing in
  // it moves. What is moved to another frame is scrolled to where it was.
  useLayoutEffect(() => {
    for (const [kind, { host, places }] of kept.current) {
      // Unseen at once: a part that eases every change would otherwise ease out of sight.
      host.className = `absolute inset-0 flex min-w-0 flex-col ${kind === front?.kind ? "" : "invisible **:transition-none!"}`;
      if (!live || host.parentElement === live.slot) continue;
      live.slot.append(host);
      for (const [part, [top, left]] of places)
        if (host.contains(part)) part.scrollTo({ top, left, behavior: "instant" });
    }
  });
  useLayoutEffect(() => {
    const all = kept.current;
    return () => {
      for (const { host } of all.values()) host.remove();
    };
  }, []);
  return windows.flatMap((window) => {
    const host = kept.current.get(window.kind)?.host;
    const inFront = window.kind === front?.kind;
    if (!host || !(inFront || window.keeps)) return [];
    return [
      createPortal(
        <window.View
          key={`${window.surface.instance}/${window.surface.surface}`}
          target={targetOf(agent, window.surface)}
          front={inFront}
          // In the layer it is as large as it gets, so its windows have no Expand.
          corner={
            !live?.overlay && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Expand"
                onClick={() => open(agent)}
              >
                <Maximize2Icon />
              </Button>
            )
          }
        />,
        host,
        window.kind,
      ),
    ];
  });
}
