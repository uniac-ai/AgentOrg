// An agent's live surfaces on its page. What draws each is chosen by its protocol alone, never by
// which provider or unit offers it, so any unit can offer a surface in a protocol the page knows.
import type { ComponentType } from "react";
import { ScreencastView } from "./browser-view.tsx";
import type { LiveTarget } from "./live-socket.ts";
import { CommandsView, PtyView } from "./terminal-views.tsx";
import { TerminalsView } from "./terminals.tsx";

/** One surface of one of the agent's units, as its status says. */
export interface OpenSurface {
  instance: string;
  surface: string;
  protocol: string;
  operate: boolean;
  unavailable?: string | undefined;
}

/** The viewers there are, by protocol, and which frame each sits in. */
export const VIEWERS: Record<
  string,
  { frame: "terminal" | "browser"; View: ComponentType<ViewerProps> }
> = {
  "commands@1": { frame: "terminal", View: CommandsView },
  "pty@1": { frame: "terminal", View: PtyView },
  "terminal@1": { frame: "terminal", View: TerminalsView },
  "screencast@1": { frame: "browser", View: ScreencastView },
};

export interface ViewerProps {
  target: LiveTarget;
}

export const targetOf = (agent: string, surface: OpenSurface): LiveTarget => ({
  agent,
  instance: surface.instance,
  surface: surface.surface,
  // A surface you can operate is opened to be; one you can't, to watch.
  mode: surface.operate && surface.protocol !== "commands@1" ? "operate" : "watch",
});

function Unavailable({ surface, frame }: { surface: OpenSurface; frame?: boolean }) {
  if (frame)
    return (
      <section
        aria-label={surface.surface}
        className="flex h-[440px] min-w-0 flex-col rounded-xl border"
      >
        <div className="h-9 shrink-0" />
        <p className="px-3 text-[13px] text-muted-foreground">{surface.unavailable}</p>
      </section>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pane of the frame, not a form.
    <div role="group" aria-label={surface.surface} className="flex min-h-0 min-w-0 flex-col">
      <div className="h-9 shrink-0" />
      <p className="px-3 text-[13px] text-muted-foreground">{surface.unavailable}</p>
    </div>
  );
}

/** One pane per surface, side by side, on a window's surface. */
export function TerminalFrame({ agent, surfaces }: { agent: string; surfaces: OpenSurface[] }) {
  return (
    <section
      aria-label="Terminal"
      className="grid h-[320px] auto-cols-fr grid-flow-col divide-x overflow-hidden rounded-xl border bg-background tight:h-[440px] tight:grid-flow-row tight:divide-x-0 tight:divide-y"
    >
      {surfaces.map((surface) => {
        const viewer = VIEWERS[surface.protocol];
        if (!viewer) return null;
        const key = `${surface.instance}/${surface.surface}`;
        return surface.unavailable ? (
          <Unavailable key={key} surface={surface} />
        ) : (
          <viewer.View key={key} target={targetOf(agent, surface)} />
        );
      })}
    </section>
  );
}

/** A browser surface, in a frame of its own. */
export function BrowserLive({ agent, surface }: { agent: string; surface: OpenSurface }) {
  const viewer = VIEWERS[surface.protocol];
  if (!viewer) return null;
  if (surface.unavailable) return <Unavailable surface={surface} frame />;
  return <viewer.View target={targetOf(agent, surface)} />;
}
