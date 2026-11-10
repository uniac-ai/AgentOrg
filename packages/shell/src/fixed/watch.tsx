// One watch on each agent, shared by everything that shows how agents are doing.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useLoad } from "../data.ts";
import {
  type AgentDetail,
  type AgentEntry,
  type ChatMessage,
  type ChatStatus,
  getAgent,
  listAgents,
  type Now,
  nowOf,
  REFRESH_MS,
  useChatRecord,
  useChatSlots,
  useEvery,
} from "./data.ts";

export interface Watched {
  entry: AgentEntry;
  slot?: string;
  /** The chat shown for it, once it has one. */
  chat?: string;
  detail?: AgentDetail;
  status?: ChatStatus;
  messages: readonly ChatMessage[];
  now: Now;
}

interface Agents {
  list: AgentEntry[];
  loaded: boolean;
  failed: boolean;
  byId: ReadonlyMap<string, Watched>;
}

const Context = createContext<Agents>({ list: [], loaded: false, failed: false, byId: new Map() });
export const useAgents = () => useContext(Context);

/** How many of the latest messages each watch keeps. */
const LATEST = 5;

function Watch({
  entry,
  slot,
  tick,
  report,
}: {
  entry: AgentEntry;
  slot?: string;
  tick: number;
  report(id: string, watched: Watched): void;
}) {
  const { status, messages, chat } = useChatRecord(slot, entry.status.state === "running", LATEST);
  // Whether a connection of its is down: nothing tells, so it's read again.
  const detail = useLoad(
    () => getAgent(entry.agent),
    ["actors", "bindings"],
    [entry.agent, tick],
  ).value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `report` is the provider's own setter.
  useEffect(() => {
    report(entry.agent, {
      entry,
      ...(slot ? { slot } : {}),
      ...(chat ? { chat } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      messages,
      now: nowOf(entry.status, status, messages, detail?.mcp),
    });
  }, [entry, slot, chat, detail, status, messages]);
  return null;
}

export function AgentsProvider({ children }: { children: React.ReactNode }) {
  const tick = useEvery(REFRESH_MS);
  const agents = useLoad(listAgents, ["actors"], [tick]);
  const slots = useChatSlots();
  const [watched, setWatched] = useState<ReadonlyMap<string, Watched>>(new Map());
  const list = useMemo(() => agents.value ?? [], [agents.value]);
  const report = (id: string, next: Watched) => setWatched((was) => new Map(was).set(id, next));
  const value = useMemo(
    () => ({
      list,
      loaded: agents.loaded,
      failed: !!agents.error,
      byId: new Map(
        list.flatMap((a) =>
          watched.has(a.agent) ? [[a.agent, watched.get(a.agent) as Watched]] : [],
        ),
      ),
    }),
    [list, agents.loaded, agents.error, watched],
  );
  return (
    <Context.Provider value={value}>
      {list.map((entry) => (
        <Watch
          key={entry.agent}
          entry={entry}
          slot={slots.get(entry.agent)}
          tick={tick}
          report={report}
        />
      ))}
      {children}
    </Context.Provider>
  );
}
