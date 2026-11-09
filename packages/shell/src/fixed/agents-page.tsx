import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Item } from "../ui/item.tsx";
import { useChats } from "./chats.tsx";
import { More, Power, Tip } from "./controls.tsx";
import { type AgentEntry, ago, useCreatables } from "./data.ts";
import { Nothing, Scroll, StateDot } from "./parts.tsx";
import { useAgents } from "./watch.tsx";

/** The main page: the agents, and the controls for each. */
export function AgentsPage() {
  const { list, loaded, failed } = useAgents();
  // The order is the order made; a row never jumps while it's being read.
  return (
    <Scroll>
      <ul aria-label="Your agents" className="mx-auto flex max-w-5xl flex-col">
        {list.map((agent) => (
          <li key={agent.agent}>
            <AgentRow agent={agent} />
          </li>
        ))}
        {loaded && list.length === 0 && (
          <li>
            <Nothing>{failed ? "Agents can't be read right now." : "No agents yet."}</Nothing>
          </li>
        )}
      </ul>
    </Scroll>
  );
}

function AgentRow({ agent }: { agent: AgentEntry }) {
  const watched = useAgents().byId.get(agent.agent);
  const { chatWith } = useChats();
  const creatables = useCreatables();
  const [failed, setFailed] = useState<string>();
  const now = watched?.now;
  const purpose = creatables?.find(
    (c) => c.provider === agent.provider && c.id === agent.creatable,
  )?.description;
  const text = failed ?? now?.text ?? "";
  const open = () => go({ screen: "agent", agent: agent.agent });
  return (
    <Item className="min-h-16 flex-nowrap gap-3 rounded-xl py-2 hover:bg-[var(--hover)] tight:flex-wrap tight:gap-y-1">
      <StateDot tone={now?.tone ?? "idle"} />
      <button
        type="button"
        onClick={open}
        className="w-56 shrink-0 text-left tight:w-auto tight:min-w-0 tight:flex-1"
      >
        <span className="block truncate font-medium">{agent.name}</span>
        <span className="block truncate text-[13px] text-muted-foreground">{purpose}</span>
      </button>
      <span
        className={`min-w-0 flex-1 truncate text-[13px] tight:order-last tight:basis-full tight:pl-6 ${failed || now?.tone === "trouble" ? "text-[var(--bad)]" : "text-muted-foreground"}`}
      >
        {text}
      </span>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground tight:hidden">
        {ago(now?.at)}
      </span>
      <span className="flex shrink-0 items-center">
        <Tip label="Chat">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Chat with ${agent.name}`}
            onClick={() => chatWith(agent.agent)}
          >
            <MessageCircleIcon />
          </Button>
        </Tip>
        <Power agent={agent} onFailed={setFailed} />
        <More agent={agent} />
      </span>
    </Item>
  );
}
