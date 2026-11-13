// What the chat shows: collapsed or open, and which of its views: the list, your conversation with
// one agent, or an agent's conversation with another, to read.
import { createContext, useContext, useMemo, useRef, useState } from "react";

export type ChatsView =
  | { kind: "list" }
  /** An agent's conversation: yours with it, or `with` another agent. */
  | { kind: "chat"; agent: string; with?: string };

interface Chats {
  open: boolean;
  view: ChatsView;
  /** Opens the chat on what it showed last. */
  expand(): void;
  close(): void;
  show(view: ChatsView): void;
  /**
   * Opens the chat on your conversation with an agent: empty, with its box, until it begins. With
   * another agent named, on their conversation instead, to read.
   */
  openChat(agent: string, other?: string): void;
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
      openChat: (agent, other) => show({ kind: "chat", agent, ...(other ? { with: other } : {}) }),
      drafts,
    };
  }, [open, view, drafts]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
