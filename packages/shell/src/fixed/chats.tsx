// The async chats: which agents have a session in the panel, and what's been seen of each. A turn
// runs whether or not anyone is looking; what the person has read is kept in the app's notes, so
// it survives restarts and is shared across tabs.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, useConnection } from "../data.ts";
import type { ChatMessage } from "./data.ts";
import { lineOf } from "./data.ts";
import { useAgents } from "./watch.tsx";

/** The note in the app's store: the sessions in the panel, each with its last-read message. */
const NOTE = "ui/chats";
/** From this wide the panel sits beside the page; below it, over the page. */
export const DOCKED = 1100;

interface Kept {
  agent: string;
  read?: string;
}

export interface Session {
  agent: string;
  name: string;
  fresh: boolean;
  working: boolean;
  preview: string;
  at?: string;
}

interface Chats {
  open: boolean;
  thread?: string;
  sessions: Session[];
  fresh: number;
  toggle(): void;
  close(): void;
  show(thread: string | undefined): void;
  chatWith(agent: string): void;
  drop(agent: string): void;
  drafts: Map<string, string>;
}

const Context = createContext<Chats | null>(null);
export const useChats = () => useContext(Context) as Chats;

const newest = (messages: readonly ChatMessage[]) =>
  messages.findLast((m) => m.role === "assistant");

export function ChatsProvider({ children }: { children: React.ReactNode }) {
  const { list, loaded, byId } = useAgents();
  const connection = useConnection();
  const [kept, setKept] = useState<Kept[]>([]);
  const [read, setRead] = useState(false);
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<string>();
  const drafts = useRef(new Map<string, string>()).current;

  useEffect(() => {
    if (connection !== "open" || read) return;
    api.call<{ value?: { sessions?: Kept[] } }>("store", "get", { key: NOTE }).then(
      ({ value }) => {
        setKept(value?.sessions ?? []);
        setRead(true);
      },
      () => setRead(true),
    );
  }, [connection, read]);

  const save = (next: Kept[]) => {
    setKept(next);
    void api.call("store", "set", { key: NOTE, value: { sessions: next } }).catch(() => {});
  };

  // A deleted agent's session goes with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` writes what this reads.
  useEffect(() => {
    if (!read || !loaded) return;
    const live = kept.filter((k) => list.some((a) => a.agent === k.agent));
    if (live.length !== kept.length) save(live);
  }, [read, loaded, list, kept]);

  // What's on screen is read, as it arrives.
  const viewing = open && thread ? byId.get(thread) : undefined;
  const seen = viewing ? newest(viewing.messages)?.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` writes what this reads.
  useEffect(() => {
    if (!thread || !seen) return;
    const session = kept.find((k) => k.agent === thread);
    if (session && session.read !== seen)
      save(kept.map((k) => (k.agent === thread ? { ...k, read: seen } : k)));
  }, [thread, seen, kept]);

  const sessions = useMemo(() => {
    const shown = kept.flatMap((k): (Session & { order: number })[] => {
      const watched = byId.get(k.agent);
      if (!watched) return [];
      const { messages, status, entry } = watched;
      const last = messages.at(-1);
      const latest = newest(messages);
      return [
        {
          agent: k.agent,
          name: entry.name,
          fresh: !!latest && latest.id !== k.read && !(open && thread === k.agent),
          working: status?.state === "thinking" || status?.state === "tool",
          preview: last ? lineOf(last) : "",
          ...(last ? { at: last.at } : {}),
          order: last ? Date.parse(last.at) : 0,
        },
      ];
    });
    // What just happened comes first, as in Messages.
    return shown.sort((a, b) => b.order - a.order);
  }, [kept, byId, open, thread]);

  const value: Chats = {
    open,
    ...(thread ? { thread } : {}),
    sessions,
    fresh: sessions.filter((s) => s.fresh).length,
    // Always the list: that's where what's new shows.
    toggle: () => {
      setThread(undefined);
      setOpen(!open);
    },
    close: () => setOpen(false),
    show: setThread,
    chatWith: (agent) => {
      if (!kept.some((k) => k.agent === agent)) {
        const latest = newest(byId.get(agent)?.messages ?? []);
        save([...kept, { agent, ...(latest ? { read: latest.id } : {}) }]);
      }
      setThread(agent);
      setOpen(true);
    },
    drop: (agent) => {
      save(kept.filter((k) => k.agent !== agent));
      setThread(undefined);
    },
    drafts,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
