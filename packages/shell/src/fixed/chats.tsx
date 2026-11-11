// What the chat shows: collapsed or open, and which of its views: the list, the archived ones, one
// chat, or a chat about to be started.
import { createContext, useContext, useMemo, useRef, useState } from "react";

export type ChatsView =
  | { kind: "list" }
  | { kind: "archived" }
  | { kind: "chat"; agent: string; id: string }
  | { kind: "new"; agent?: string };

interface Chats {
  open: boolean;
  view: ChatsView;
  /** Opens the chat on what it showed last. */
  expand(): void;
  close(): void;
  show(view: ChatsView): void;
  /** Opens the chat on one chat of an agent's. */
  openChat(agent: string, id: string): void;
  /** Opens the chat on one about to be started, with this agent if one is named. */
  newChat(agent?: string): void;
  /** What's half typed in each chat, in this session. */
  drafts: Map<string, string>;
}

const Context = createContext<Chats | null>(null);
export const useChats = () => useContext(Context) as Chats;

export function ChatsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatsView>({ kind: "list" });
  const drafts = useRef(new Map<string, string>()).current;
  const value = useMemo<Chats>(() => {
    const show = (next: ChatsView) => {
      setView(next);
      setOpen(true);
    };
    return {
      open,
      view,
      expand: () => setOpen(true),
      close: () => setOpen(false),
      show,
      openChat: (agent, id) => show({ kind: "chat", agent, id }),
      newChat: (agent) => show({ kind: "new", ...(agent ? { agent } : {}) }),
      drafts,
    };
  }, [open, view, drafts]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
