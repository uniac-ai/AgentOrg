// The team page: your agents, with the chosen one's details in a card beside them. Each row says
// how its agent stands, in the words its page says under its head. Where there is no room for
// both, the list comes first and an agent's details take its place, with a way back.
import { ChevronLeftIcon } from "lucide-react";
import { type AgentTab, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { AgentPage } from "./agent-page.tsx";
import { useBuilding } from "./building.tsx";
import type { AgentEntry } from "./data.ts";
import { Face } from "./face.tsx";
import { needsOf, useLogin } from "./login.tsx";
import { ListHead, ListPanel, PAGE_CARD } from "./page-frame.tsx";
import { Nothing, UNREAD } from "./parts.tsx";
import { useSplit } from "./split.ts";
import { useAgents } from "./watch.tsx";

/** One agent in the list: its face with its state's mark, its name, and how it stands. */
function AgentRow({
  entry,
  current,
  onOpen,
}: {
  entry: AgentEntry;
  current: boolean;
  onOpen(): void;
}) {
  const { byId } = useAgents();
  const login = useLogin();
  const now = byId.get(entry.agent)?.now;
  const tone = now?.tone ?? "idle";
  // Signed out of the model account, a running agent can't work: that comes before how it stands.
  const off = entry.status.state === "stopped" || entry.status.state === "down";
  const needs = off ? undefined : needsOf(login);
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex h-14 w-full items-center gap-3 rounded-xl px-2.5 text-left ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Face agent={{ id: entry.agent, name: entry.name, tone }} size={36} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{entry.name}</span>
        <span
          className={`block truncate text-[13px] ${!needs && tone === "trouble" ? "text-[var(--bad)]" : "text-muted-foreground"}`}
        >
          {/* Of several sentences, the first: the page shows each. */}
          {needs ?? now?.text.split("\n")[0]}
        </span>
      </span>
    </button>
  );
}

export function TeamPage({
  agent,
  tab,
}: {
  agent?: string | undefined;
  tab?: AgentTab | undefined;
}) {
  const agents = useAgents();
  const building = useBuilding();
  const [ref, split] = useSplit<HTMLDivElement>();
  // Wide, it opens on the first agent; narrower, on the list until one is chosen.
  const chosen = agent ?? (split ? agents.list[0]?.agent : undefined);
  // Where there is room for both, the list is there whether or not it is put away: put away, it
  // is off the window's edge until it is looked at.
  const listing = split || !chosen;
  // With nothing to list, it says which nothing it is.
  const nothing = agents.unread
    ? UNREAD
    : agents.loaded && agents.list.length === 0
      ? "No agents"
      : undefined;
  return (
    <div ref={ref} className="flex h-full min-h-0">
      {listing && (
        <ListPanel label="Team" beside={!!chosen}>
          <ListHead label="Agents" add="Create" onAdd={building.show} />
          {nothing ? (
            <div className="flex items-center gap-4 px-[18px]">
              <Nothing>{nothing}</Nothing>
              {nothing === "No agents" && (
                <Button className="h-8 rounded-full px-4" onClick={building.show}>
                  Create
                </Button>
              )}
            </div>
          ) : (
            <ul
              aria-label="Agents"
              className="no-bar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-24"
            >
              {agents.list.map((entry) => (
                <li key={entry.agent}>
                  <AgentRow
                    entry={entry}
                    current={split && entry.agent === chosen}
                    onOpen={() => go({ screen: "team", agent: entry.agent })}
                  />
                </li>
              ))}
            </ul>
          )}
        </ListPanel>
      )}
      {chosen && (
        <div className={`@container/main relative flex flex-1 flex-col ${PAGE_CARD}`}>
          {!split && (
            <header className="flex h-12 shrink-0 items-center px-2">
              <Button
                variant="ghost"
                className="h-9 gap-0.5 rounded-full pr-3 pl-1.5 text-[15px]"
                onClick={() => go({ screen: "team" })}
              >
                <ChevronLeftIcon className="size-5" />
                Team
              </Button>
            </header>
          )}
          <div className="min-h-0 flex-1">
            <AgentPage key={chosen} agent={chosen} tab={tab} />
          </div>
        </div>
      )}
    </div>
  );
}
