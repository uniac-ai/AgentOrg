// Who is acting on an agent's computer now, as its presence surface says it: the whole list each
// time it changes, the most recent first. One reading for a computer, however many of its parts
// show it: "In use" beside it, and the head of each of its frames.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { REFRESH_MS } from "./data.ts";
import { type LiveTarget, useLive } from "./live-socket.ts";

/** The protocol a computer says who is acting on it in. */
export const PRESENCE = "presence@1";
export interface Acting {
  who: "person" | "agent";
  name?: string;
  /** The kind of window acted on. */
  capability: string;
}

interface Readings {
  /** What each reading says now: nothing before it first says, or while it can't be watched. */
  said: Readonly<Record<string, readonly Acting[] | undefined>>;
  /** A part wants a computer's reading, until what this gives back is called. */
  want(target: LiveTarget): () => void;
}
const Context = createContext<Readings | null>(null);
const keyOf = (target: LiveTarget) => `${target.agent} ${target.instance} ${target.surface}`;

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  // The readings wanted now, each with how many parts want it.
  const [wanted, setWanted] = useState<ReadonlyMap<string, { target: LiveTarget; parts: number }>>(
    new Map(),
  );
  const [said, setSaid] = useState<Record<string, readonly Acting[] | undefined>>({});
  const want = useCallback((target: LiveTarget) => {
    const key = keyOf(target);
    const count = (by: number) =>
      setWanted((was) => {
        const next = new Map(was);
        const parts = (was.get(key)?.parts ?? 0) + by;
        if (parts > 0) next.set(key, { target, parts });
        else next.delete(key);
        return next;
      });
    count(1);
    return () => count(-1);
  }, []);
  const say = useCallback(
    (key: string, acting: readonly Acting[] | undefined) =>
      setSaid((was) => ({ ...was, [key]: acting })),
    [],
  );
  const value = useMemo(() => ({ said, want }), [said, want]);
  return (
    <Context.Provider value={value}>
      {children}
      {[...wanted].map(([key, { target }]) => (
        <Reading key={key} id={key} target={target} say={say} />
      ))}
    </Context.Provider>
  );
}

/** One socket to one computer's presence, opened again after it closes. */
function Reading({
  id,
  target,
  say,
}: {
  id: string;
  target: LiveTarget;
  say(key: string, acting: readonly Acting[] | undefined): void;
}) {
  const live = useLive(
    { ...target, mode: "watch" },
    (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { type?: string; acting?: Acting[] };
      if (frame.type === "presence" && Array.isArray(frame.acting)) say(id, frame.acting);
    },
    () => say(id, undefined),
  );
  // Closed, it says nothing, and is opened again as often as what has no event is read again.
  const closed = live.state.phase === "closed";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is this socket's own.
  useEffect(() => {
    if (!closed) return;
    say(id, undefined);
    const timer = setTimeout(live.again, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [closed, id, say]);
  // No longer wanted, what it said is forgotten.
  useEffect(() => () => say(id, undefined), [id, say]);
  return null;
}

/**
 * Who is acting on a computer now, as its presence surface says, while a part shows it. Nothing
 * before the surface first says, or while it can't be watched.
 */
export function usePresence(target: LiveTarget | undefined): readonly Acting[] | undefined {
  const { said, want } = useContext(Context) as Readings;
  const key = target ? keyOf(target) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is its key.
  useEffect(() => (target ? want(target) : undefined), [key, want]);
  return key ? said[key] : undefined;
}
