// What the chat shows: collapsed or open, and the list or one agent's thread.
import { createContext, useContext, useRef, useState } from "react";

interface Chats {
  open: boolean;
  /** The agent whose thread is shown; none is the list. */
  thread?: string;
  toggle(): void;
  close(): void;
  show(thread: string | undefined): void;
  chatWith(agent: string): void;
  /** What's half typed to each agent, in this session. */
  drafts: Map<string, string>;
}

const Context = createContext<Chats | null>(null);
export const useChats = () => useContext(Context) as Chats;

export function ChatsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<string>();
  const drafts = useRef(new Map<string, string>()).current;
  const value: Chats = {
    open,
    ...(thread ? { thread } : {}),
    // Always the list: that's where what's new shows.
    toggle: () => {
      setThread(undefined);
      setOpen(!open);
    },
    close: () => setOpen(false),
    show: setThread,
    chatWith: (agent) => {
      setThread(agent);
      setOpen(true);
    },
    drafts,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
