import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { go, useLoad } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Item } from "../ui/item.tsx";
import { CreateDialog } from "./create.tsx";
import {
  type AgentEntry,
  ago,
  getAgent,
  listAgents,
  nowOf,
  REFRESH_MS,
  type Tone,
  useChatRecord,
  useChatSlots,
  useEvery,
} from "./data.ts";
import { Nothing, Page, Scroll, StateDot } from "./parts.tsx";

export function AgentsPage() {
  const tick = useEvery(REFRESH_MS);
  const [creating, setCreating] = useState(false);
  const list = useLoad(listAgents, ["actors"], [tick]);
  const slots = useChatSlots();
  const agents = list.value ?? [];
  // The order is the order made; a row never jumps while it's being read.
  return (
    <Page
      crumbs={[{ label: "Agents" }]}
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon />
          Create
        </Button>
      }
    >
      <Scroll>
        <ul className="mx-auto flex max-w-5xl flex-col">
          {agents.map((agent) => (
            <li key={agent.agent}>
              <AgentRow agent={agent} slot={slots.get(agent.agent)} tick={tick} />
            </li>
          ))}
          {list.loaded && agents.length === 0 && (
            <li>
              <Nothing>{list.error ? "Agents can't be read right now." : "No agents yet."}</Nothing>
            </li>
          )}
        </ul>
      </Scroll>
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

const TEXT: Partial<Record<Tone, string>> = { trouble: "text-[var(--bad)]" };

function AgentRow({ agent, slot, tick }: { agent: AgentEntry; slot?: string; tick: number }) {
  const running = agent.status.state === "running";
  const { status, messages } = useChatRecord(slot, running, 5);
  // Whether a connection of its is down: nothing tells, so it's read with the list.
  const detail = useLoad(() => getAgent(agent.agent), ["actors", "bindings"], [agent.agent, tick]);
  const now = nowOf(agent.status, status, messages, detail.value?.mcp);
  return (
    <Item
      asChild
      className="h-14 flex-nowrap gap-3 rounded-xl hover:bg-[var(--hover)] phone:h-16 phone:flex-wrap phone:content-center phone:gap-y-0.5"
    >
      <button type="button" onClick={() => go({ screen: "agent", agent: agent.agent })}>
        <StateDot tone={now.tone} />
        <span className="w-44 shrink-0 truncate text-left font-medium phone:w-auto phone:min-w-0 phone:flex-1">
          {agent.name}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-left text-[13px] phone:order-last phone:basis-full phone:pl-6 ${TEXT[now.tone] ?? "text-muted-foreground"}`}
        >
          {now.text}
        </span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {ago(now.at)}
        </span>
      </button>
    </Item>
  );
}
