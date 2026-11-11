// What the frames of the agents' computers share: the window each computer has in front, and the
// one computer that is open as a window in the layer. That window is its agent's, not a chat's:
// opening or closing it leaves the chat as it is, and another agent's takes its place.
import { createContext, useContext, useMemo, useState } from "react";

interface Computers {
  /** The kind of window each computer has in front: the one picked, wherever it is shown. */
  picked: Readonly<Record<string, string>>;
  pick(agent: string, kind: string): void;
  /** The agent whose computer is open in the layer, if one is. */
  shown?: string | undefined;
  open(agent: string): void;
  close(): void;
}

const Context = createContext<Computers | null>(null);
export const useComputers = () => useContext(Context) as Computers;

export function ComputersProvider({ children }: { children: React.ReactNode }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string>();
  const value = useMemo<Computers>(
    () => ({
      picked,
      pick: (agent, kind) => setPicked((was) => ({ ...was, [agent]: kind })),
      shown,
      open: setShown,
      close: () => setShown(undefined),
    }),
    [picked, shown],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
