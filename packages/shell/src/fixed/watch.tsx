// One watch on each agent, shared by everything that shows how agents are doing.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLoad } from "../data.ts";
import {
  type AgentDetail,
  type AgentEntry,
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
  /** What it's made of, as last read. */
  detail?: AgentDetail;
  /** Whether it works, in any chat. */
  status?: ChatStatus;
  now: Now;
}

interface Agents {
  list: AgentEntry[];
  loaded: boolean;
  byId: ReadonlyMap<string, Watched>;
}

const Context = createContext<Agents>({ list: [], loaded: false, byId: new Map() });
export const useAgents = () => useContext(Context);

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
  // Only whether it works is wanted here: the least of its record is asked for.
  const { status } = useChatRecord(slot, entry.status.state === "running", 1);
  // Whether a connection of its is down: nothing tells, so it's read again. A read that fails
  // keeps what the last one said, so what hangs on it stays as it was.
  const read = useLoad(
    () => getAgent(entry.agent),
    ["actors", "bindings"],
    [entry.agent, tick],
  ).value;
  const last = useRef(read);
  if (read) last.current = read;
  const detail = last.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `report` is the provider's own setter.
  useEffect(() => {
    report(entry.agent, {
      entry,
      ...(slot ? { slot } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      now: nowOf(entry.status, status, detail?.mcp),
    });
  }, [entry, slot, detail, status]);
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
      byId: new Map(
        list.flatMap((a) =>
          watched.has(a.agent) ? [[a.agent, watched.get(a.agent) as Watched]] : [],
        ),
      ),
    }),
    [list, agents.loaded, watched],
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
