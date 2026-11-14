// One watch on each agent, shared by everything that shows how agents are doing.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLoad } from "../data.ts";
import {
  type AgentDetail,
  type AgentEntry,
  type ChatStatus,
  type DownCapability,
  getAgent,
  listAgents,
  type Now,
  nowOf,
  REFRESH_MS,
  useChatSlots,
  useEvery,
  useHeldDown,
  useWorking,
} from "./data.ts";

export interface Watched {
  entry: AgentEntry;
  slot?: string;
  /** What it's made of, as last read. */
  detail?: AgentDetail;
  /** Whether it works, in any chat. */
  status?: ChatStatus;
  /** Something it holds that is down, if one is. */
  held?: DownCapability;
  now: Now;
}

interface Agents {
  list: AgentEntry[];
  loaded: boolean;
  /** The last read of the list was refused, or didn't answer: none can be shown. */
  unread: boolean;
  /** How many times the list has been read: a page knows whether it has been read since it opened. */
  reads: number;
  byId: ReadonlyMap<string, Watched>;
}

const Context = createContext<Agents>({
  list: [],
  loaded: false,
  unread: false,
  reads: 0,
  byId: new Map(),
});
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
  const status = useWorking(slot, entry.status.state === "running");
  // Whether a connection of its is down: nothing tells, so it's read again. A read that fails
  // keeps what the last one said, so what hangs on it stays as it was. Something it holds going
  // down or coming back says so at once: it is read again then, so its windows follow.
  const [flips, setFlips] = useState(0);
  const read = useLoad(
    () => getAgent(entry.agent),
    ["actors", "bindings"],
    [entry.agent, tick, flips],
  ).value;
  const last = useRef(read);
  if (read) last.current = read;
  const detail = last.current;
  const held = useHeldDown(detail);
  const down = held?.title;
  const was = useRef(down);
  useEffect(() => {
    if (was.current === down) return;
    was.current = down;
    setFlips((n) => n + 1);
  }, [down]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `report` is the provider's own setter.
  useEffect(() => {
    report(entry.agent, {
      entry,
      ...(slot ? { slot } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      ...(held ? { held } : {}),
      now: nowOf(entry.status, status, detail?.mcp, held),
    });
  }, [entry, slot, detail, status, held]);
  return null;
}

export function AgentsProvider({ children }: { children: React.ReactNode }) {
  const tick = useEvery(REFRESH_MS);
  const agents = useLoad(listAgents, ["actors"], [tick]);
  const slots = useChatSlots();
  const [watched, setWatched] = useState<ReadonlyMap<string, Watched>>(new Map());
  const list = useMemo(() => agents.value ?? [], [agents.value]);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (agents.value) setReads((was) => was + 1);
  }, [agents.value]);
  const report = (id: string, next: Watched) => setWatched((was) => new Map(was).set(id, next));
  const value = useMemo(
    () => ({
      list,
      loaded: agents.loaded,
      unread: !!agents.error,
      reads,
      byId: new Map(
        list.flatMap((a) =>
          watched.has(a.agent) ? [[a.agent, watched.get(a.agent) as Watched]] : [],
        ),
      ),
    }),
    [list, agents.loaded, agents.error, reads, watched],
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
