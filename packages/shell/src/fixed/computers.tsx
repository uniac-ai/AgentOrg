// What the frames of the agents' computers share: the window each computer has in front, the
// one window open in the layer, and which frames are drawn now. The layer's window is an agent's
// computer or its activity, one at a time. It is its agent's, not a chat's: opening or closing it
// leaves the chat as it is, and another takes its place.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { OpenSurface } from "./computer.tsx";

/** A frame of a computer that is drawn now: whose it is, where its window goes, what it lists. */
export interface DrawnFrame {
  agent: string;
  /** In the layer, over the page. */
  overlay: boolean;
  slot: HTMLElement;
  surfaces: readonly OpenSurface[];
}

interface Computers {
  /** The kind of window each computer has in front: the one picked, wherever it is shown. */
  picked: Readonly<Record<string, string>>;
  pick(agent: string, kind: string): void;
  /** The agent whose computer is open in the layer, if one is. */
  shown?: string | undefined;
  open(agent: string): void;
  /** The agent whose activity is open in the layer instead, if one is. */
  activity?: string | undefined;
  openActivity(agent: string): void;
  /** Closes the layer's window. */
  close(): void;
  /** The frames drawn now. A computer's views are one set, shown in one of its frames. */
  frames: readonly DrawnFrame[];
  draw(frame: DrawnFrame): void;
  erase(agent: string, overlay: boolean): void;
}

const Context = createContext<Computers | null>(null);
export const useComputers = () => useContext(Context) as Computers;

export function ComputersProvider({ children }: { children: React.ReactNode }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** What the layer's window shows: whose, and which. */
  const [layered, setLayered] = useState<{ agent: string; activity: boolean }>();
  const [frames, setFrames] = useState<readonly DrawnFrame[]>([]);
  const erase = useCallback(
    (agent: string, overlay: boolean) =>
      setFrames((was) => was.filter((f) => f.agent !== agent || f.overlay !== overlay)),
    [],
  );
  const draw = useCallback(
    (frame: DrawnFrame) =>
      setFrames((was) => [
        ...was.filter((f) => f.agent !== frame.agent || f.overlay !== frame.overlay),
        frame,
      ]),
    [],
  );
  const value = useMemo<Computers>(
    () => ({
      picked,
      pick: (agent, kind) => setPicked((was) => ({ ...was, [agent]: kind })),
      shown: layered && !layered.activity ? layered.agent : undefined,
      open: (agent) => setLayered({ agent, activity: false }),
      activity: layered?.activity ? layered.agent : undefined,
      openActivity: (agent) => setLayered({ agent, activity: true }),
      close: () => setLayered(undefined),
      frames,
      draw,
      erase,
    }),
    [picked, layered, frames, draw, erase],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
