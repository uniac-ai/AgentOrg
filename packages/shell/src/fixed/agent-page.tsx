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
import { Computer, surfacesOf, targetOf, windowsOf } from "./computer.tsx";
import { ComputerLoad, LOAD } from "./computer-load.tsx";
import { More } from "./controls.tsx";
import { useAct, useCreatables } from "./data.ts";
import { Face, MARK } from "./face.tsx";
import { needsOf, useLogin } from "./login.tsx";
import { Overview } from "./overview.tsx";
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
  const { byId, list, unread, reads } = useAgents();
  // The list as it was when the page opened may not have an agent just made: only a read since says.
  const [opened] = useState(reads);
  const { chats } = useAllChats();
  const { newChat, openChat } = useChats();
  const creatables = useCreatables();
  const [failed, setFailed] = useState<string>();
  const [setup, setSetup] = useState(false);
  const act = useAct(setFailed);
  const login = useLogin();
  const watched = byId.get(id);
  // An agent the list read since doesn't have: one deleted elsewhere, or a wrong address. A list
  // that couldn't be read says nothing of it.
  if (reads > opened && !unread && !list.some((entry) => entry.agent === id)) return <Missing />;
  // What it's made of says what the page holds, so nothing is drawn before it is read.
  if (!watched?.detail) return null;
  const { entry, now, detail } = watched;
  const creatable = creatables?.find(
    (c) => c.provider === entry.provider && c.id === entry.creatable,
  );
  const stopped = entry.status.state === "stopped";
  const off = stopped || entry.status.state === "down";
  // Its computer is what its units can show live: its windows, and its own word on how busy it is.
  const surfaces = surfacesOf(detail);
  const computer = windowsOf(surfaces).length > 0;
  const load = surfaces.find((s) => s.protocol === LOAD && !s.unavailable);
  const start = () => act.run(() => api.call("agents", "start", { agent: id }));
  // Overview comes last, so the page opens as it did.
  const tabs: { id: AgentTab; title: string }[] = [
    ...(computer ? [{ id: "computer" as const, title: "Computer" }] : []),
    { id: "chats", title: "Chats" },
    { id: "overview", title: "Overview" },
  ];
  const tab = tabs.find((t) => t.id === asked) ?? tabs[0];
  // Its own page lists its chats while it is stopped too: only one archived by hand is left out.
  const mine = chats.filter((chat) => chat.agent.id === id && !chat.entry.archived);
  // How it stands, and no more. What it did, and what went wrong in a chat, is read in its chats.
  const tone = failed ? "trouble" : now.tone;
  // Signed out of the model account, a running agent can't work: that comes before how it stands.
  const needs = off || failed ? undefined : needsOf(login);
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
            className={`mx-1 inline-block size-2 shrink-0 rounded-full ${needs ? "bg-[var(--warn)]" : (MARK[tone] ?? "bg-[var(--faint)]")}`}
          />
          <span
            className={`min-w-0 truncate ${!needs && tone === "trouble" ? "text-[var(--bad)]" : ""}`}
          >
            {needs ?? failed ?? now.text}
          </span>
          {/* The way in is on Home, where everything left to set up is. */}
          {needs && (
            <Button
              variant="secondary"
              className="ml-1 h-8 rounded-full px-4"
              onClick={() => go({ screen: "home" })}
            >
              Set up
            </Button>
          )}
          {/* An agent that isn't running is started where it says so. */}
          {off && (
            <Button className="ml-1 h-8 rounded-full px-4" disabled={act.busy} onClick={start}>
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
          {tab?.id === "computer" && (
            <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-8 tight:grid-cols-1">
              <Computer
                agent={{ id, name: entry.name, tone: now.tone }}
                surfaces={surfaces}
                onStart={() => api.call("agents", "start", { agent: id })}
              />
              {load && !stopped && <ComputerLoad target={targetOf(id, load)} />}
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
          {tab?.id === "overview" && <Overview entry={entry} detail={detail} />}
        </div>
      </div>
      <Setup agent={entry} open={setup} onClose={() => setSetup(false)} />
    </div>
  );
}

/** An agent that isn't here says so, with the way back. */
function Missing() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-[15px]">
        <span className="text-muted-foreground">This agent isn't here</span>
        <Button
          variant="secondary"
          className="h-9 rounded-full px-4"
          onClick={() => go({ screen: "home" })}
        >
          Home
        </Button>
      </div>
    </div>
  );
}
