// An agent's own page: who it is and how it stands, then what belongs to it. Its computer comes
// first, where it has one. What it's made of is behind one button, never on the everyday surface.
// Its line follows no chat: a chat's problem is said on that chat's row, and in the chat.
import { MessageCircleIcon, SlidersHorizontalIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";
import { type AgentTab, api, go } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { useAllChats } from "./all-chats.tsx";
import { ChatRow } from "./chat-parts.tsx";
import { useChats } from "./chats.tsx";
import { ComputerLoad, LOAD } from "./computer-load.tsx";
import { More } from "./controls.tsx";
import { useAct, useCreatables } from "./data.ts";
import { Face, MARK } from "./face.tsx";
import { Frames } from "./frames.tsx";
import { targetOf, VIEWERS } from "./live-frames.tsx";
import { Setup } from "./setup.tsx";
import { useAgents } from "./watch.tsx";

const big = "h-10 rounded-full px-4 text-[15px]";

export function AgentPage({
  agent: id,
  tab: asked,
}: {
  agent: string;
  tab?: AgentTab | undefined;
}) {
  const { byId } = useAgents();
  const { chats } = useAllChats();
  const { newChat, openChat } = useChats();
  const creatables = useCreatables();
  const [failed, setFailed] = useState<string>();
  const [setup, setSetup] = useState(false);
  const act = useAct(setFailed);
  const watched = byId.get(id);
  // What it's made of says what the page holds, so nothing is drawn before it is read.
  if (!watched?.detail) return null;
  const { entry, now, detail } = watched;
  const creatable = creatables?.find(
    (c) => c.provider === entry.provider && c.id === entry.creatable,
  );
  const stopped = entry.status.state === "stopped";
  const off = stopped || entry.status.state === "down";
  // Its computer is the unit that offers a window to open live, with that unit's own word on
  // how busy it is.
  const computer = detail.units.find((unit) =>
    unit.status.surfaces?.some((s) => VIEWERS[s.protocol]),
  );
  const load = computer?.status.surfaces?.find((s) => s.protocol === LOAD && !s.unavailable);
  const tabs: { id: AgentTab; title: string }[] = [
    ...(computer ? [{ id: "computer" as const, title: "Computer" }] : []),
    { id: "chats", title: "Chats" },
  ];
  const tab = tabs.find((t) => t.id === asked) ?? tabs[0];
  // Its own page lists its chats while it is stopped too: only one archived by hand is left out.
  const mine = chats.filter((chat) => chat.agent.id === id && !chat.entry.archived);
  // How it stands, and no more. What it did, and what went wrong in a chat, is read in its chats.
  const tone = failed ? "trouble" : now.tone;
  return (
    <div className="no-bar h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-6 pb-28 tight:px-4">
        <header className="flex items-center gap-5 pt-8 tight:flex-wrap tight:gap-x-4 tight:gap-y-5 phone:pt-2">
          <Face agent={{ id, name: entry.name, tone: now.tone }} size={88} plain />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[30px] leading-9 font-semibold tracking-tight">
              {entry.name}
            </h1>
            <p className="truncate text-[15px] text-muted-foreground">
              {entry.purpose ?? creatable?.description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 tight:w-full">
            <Button
              className={`${big} tight:flex-1`}
              disabled={stopped}
              onClick={() => newChat(id)}
            >
              <MessageCircleIcon />
              Message
            </Button>
            <Button
              variant="secondary"
              className={`${big} tight:flex-1`}
              onClick={() => setSetup(true)}
            >
              <SlidersHorizontalIcon />
              Setup
            </Button>
            <More agent={entry} onFailed={setFailed} />
          </div>
        </header>
        <div
          role="status"
          aria-label="State"
          className="mt-5 flex h-8 items-center gap-2.5 text-[15px]"
        >
          <span
            className={`mx-1 inline-block size-2 shrink-0 rounded-full ${MARK[tone] ?? "bg-[var(--faint)]"}`}
          />
          <span className={`min-w-0 truncate ${tone === "trouble" ? "text-[var(--bad)]" : ""}`}>
            {failed ?? now.text}
          </span>
          {/* An agent that isn't running is started where it says so. */}
          {off && (
            <Button
              className="ml-1 h-8 rounded-full px-4"
              disabled={act.busy}
              onClick={() => act.run(() => api.call("agents", "start", { agent: id }))}
            >
              Start
            </Button>
          )}
        </div>
        {/* One thing to show needs no tabs. */}
        {tabs.length > 1 ? (
          <div role="tablist" aria-label={entry.name} className="mt-4 flex gap-6 border-b">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => go({ screen: "agent", agent: id, tab: t.id })}
                className={`-mb-px h-11 border-b-2 text-[15px] ${tab === t ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t.title}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-4 h-11 border-b" />
        )}
        <div
          {...(tabs.length > 1 ? { role: "tabpanel", "aria-label": tab?.title } : {})}
          className="pt-5"
        >
          {tab?.id === "computer" && computer && (
            <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-8 tight:grid-cols-1">
              <Frames
                agent={id}
                {...(watched.slot ? { slot: watched.slot } : {})}
                running={entry.status.state === "running"}
                surfaces={detail.units.flatMap((unit) =>
                  (unit.status.surfaces ?? []).map((surface) => ({
                    ...surface,
                    instance: unit.instance,
                  })),
                )}
              />
              {load && (
                <ComputerLoad target={targetOf(id, { ...load, instance: computer.instance })} />
              )}
            </div>
          )}
          {tab?.id === "chats" && (
            <div className="mx-auto max-w-[720px]">
              <div className="flex h-10 items-center justify-end">
                <Button variant="ghost" size="sm" disabled={stopped} onClick={() => newChat(id)}>
                  <SquarePenIcon />
                  New chat
                </Button>
              </div>
              <ul aria-label={`Chats with ${entry.name}`}>
                {mine.map((chat) => (
                  <li key={chat.entry.id}>
                    <ChatRow chat={chat} onOpen={() => openChat(id, chat.entry.id)} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <Setup agent={entry} open={setup} onClose={() => setSetup(false)} />
    </div>
  );
}
