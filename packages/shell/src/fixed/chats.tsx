// What the chat shows: collapsed or open, and which of its views: the list, or your conversation
// with one agent.
import { createContext, useContext, useMemo, useRef, useState } from "react";

export type ChatsView = { kind: "list" } | { kind: "chat"; agent: string };

interface Chats {
  open: boolean;
  view: ChatsView;
  /** Opens the chat on what it showed last. */
  expand(): void;
  close(): void;
  show(view: ChatsView): void;
  /** Opens the chat on your conversation with an agent: empty, with its box, until it begins. */
  openChat(agent: string): void;
  /** What's half typed in each conversation, in this session. */
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
      openChat: (agent) => show({ kind: "chat", agent }),
      drafts,
    };
  }, [open, view, drafts]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
