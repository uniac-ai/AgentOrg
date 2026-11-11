// An agent's computer: one frame with a dock, and one window in front. Its browser, its
// terminals and its files are equal parts of it: each is a surface the computer lists, and each window is
// chosen by its surface's protocol alone, never by which provider or unit offers it. So a
// computer with no browser has no Browser, and a new kind of surface is one more window here.
import { FolderIcon, GlobeIcon, Maximize2Icon, TerminalIcon, XIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { ScreencastView } from "./browser-view.tsx";
import { useComputers } from "./computers.tsx";
import type { AgentDetail, Tone } from "./data.ts";
import { Face, tintOf } from "./face.tsx";
import { FilesView } from "./files-view.tsx";
import type { LiveTarget } from "./live-socket.ts";
import { TerminalsView } from "./terminals.tsx";

/** One surface of one of the agent's units, as its status says. */
export interface OpenSurface {
  instance: string;
  surface: string;
  protocol: string;
  operate: boolean;
  unavailable?: string | undefined;
}
/** What a window is given: the surface to open, and what goes in the corner of its first row. */
export interface ViewerProps {
  target: LiveTarget;
  corner?: ReactNode;
}
export const targetOf = (agent: string, surface: OpenSurface): LiveTarget => ({
  agent,
  instance: surface.instance,
  surface: surface.surface,
  mode: surface.operate ? "operate" : "watch",
});

/** The windows there are, in the dock's order: each draws the surfaces of one protocol. */
const WINDOWS: {
  kind: string;
  title: string;
  icon: typeof GlobeIcon;
  protocol: string;
  View: ComponentType<ViewerProps>;
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
  },
  { kind: "files", title: "Files", icon: FolderIcon, protocol: "files@1", View: FilesView },
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
  overlay = false,
}: {
  agent: { id: string; name: string; tone: Tone };
  surfaces: readonly OpenSurface[];
  /** Starts its agent, which is how a stopped one's computer comes back. */
  onStart(): void;
  overlay?: boolean;
}) {
  const { picked, pick, shown, open, close } = useComputers();
  const windows = windowsOf(surfaces);
  // The window in front is the one picked. Nothing follows the agent: it may be in several at once.
  const front = windows.find((w) => w.kind === picked[agent.id]) ?? windows[0];
  if (!front) return null;
  const stopped = agent.tone === "stopped";
  // One frame of a computer is live at a time: while it is open in the layer, the frame on its
  // page, which lies under it, holds its window's place and opens nothing.
  const under = !overlay && shown === agent.id;
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
          <div className="window relative grid h-full place-items-center rounded-xl bg-background">
            <div className="flex flex-col items-center gap-3 text-[15px]">
              <span className="text-muted-foreground">{agent.name} is stopped</span>
              <Button className="h-9 rounded-full px-4" onClick={onStart}>
                Start
              </Button>
            </div>
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a window of the frame, not a form.
          <div
            role="group"
            aria-label={front.title}
            className="window relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl bg-background shadow-lg"
          >
            {!under && (
              <front.View
                key={`${front.surface.instance}/${front.surface.surface}`}
                target={targetOf(agent.id, front.surface)}
                corner={
                  !overlay && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Expand"
                      onClick={() => open(agent.id)}
                    >
                      <Maximize2Icon />
                    </Button>
                  )
                }
              />
            )}
          </div>
        )}
      </div>
      {/* A stopped computer has no dock; its place stays. */}
      <div className="flex h-[68px] shrink-0 items-center justify-center">
        {!stopped && (
          <nav
            aria-label="Dock"
            className="flex gap-1.5 rounded-2xl bg-background/70 p-1.5 backdrop-blur"
          >
            {windows.map(({ kind, title, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                aria-label={title}
                aria-current={front.kind === kind ? "true" : undefined}
                title={title}
                onClick={() => pick(agent.id, kind)}
                className={`relative grid size-11 place-items-center rounded-xl ${front.kind === kind ? "bg-[var(--selected)] text-foreground" : "text-muted-foreground hover:bg-[var(--hover)]"}`}
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
