// The fixed frontend: agents, how each is doing, and what each is made of.
import { BotIcon, MoonIcon, PlugIcon, SettingsIcon, SparklesIcon, SunIcon } from "lucide-react";
import { useLayoutEffect } from "react";
import type { LoginStatus } from "../app.tsx";
import { go, setTheme, useLoad, useRoute, useTheme } from "../data.ts";
import { AgentPage } from "./agent-page.tsx";
import { AgentsPage } from "./agents-page.tsx";
import { ChatPage } from "./chat.tsx";
import { getAgent, listAgents, nowOf, REFRESH_MS, useEvery } from "./data.ts";
import { McpsPage } from "./mcps-page.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";

/** The agents with a problem, for the count beside Agents. */
function useProblems(): number {
  const tick = useEvery(REFRESH_MS);
  return (
    useLoad(
      async () => {
        const agents = await listAgents();
        const details = await Promise.all(agents.map((a) => getAgent(a.agent).catch(() => a)));
        return details.filter(
          (d) => nowOf(d.status, undefined, [], "mcp" in d ? d.mcp : []).tone === "trouble",
        ).length;
      },
      ["actors", "bindings"],
      [tick],
    ).value ?? 0
  );
}

const NAV = [
  { screen: "home", label: "Agents", short: "Agents", Icon: BotIcon },
  { screen: "skills", label: "Skills", short: "Skills", Icon: SparklesIcon },
  { screen: "mcps", label: "MCP connections", short: "MCPs", Icon: PlugIcon },
  { screen: "settings", label: "Settings", short: "Settings", Icon: SettingsIcon },
] as const;

export function FixedShell({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const theme = useTheme();
  const problems = useProblems();
  const here = route.screen === "agent" || route.screen === "chat" ? "home" : route.screen;
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = "fixed";
  }, []);
  const toggle = (
    <button
      type="button"
      aria-label={`Color: ${theme}`}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-[var(--hover)]"
    >
      {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </button>
  );
  const count = problems > 0 && (
    <span
      role="img"
      aria-label={`${problems} with a problem`}
      className="ml-auto grid size-[18px] place-items-center rounded-full bg-[var(--bad)] text-[11px] font-semibold text-black"
    >
      {problems}
    </span>
  );
  return (
    <div className="@container/app relative flex h-full w-full bg-[var(--canvas)] text-foreground">
      <nav
        aria-label="Main"
        className="flex w-[196px] shrink-0 flex-col gap-0.5 px-2.5 py-2.5 phone:hidden"
      >
        {NAV.map(({ screen, label, Icon }, i) => (
          <button
            key={screen}
            type="button"
            aria-current={here === screen ? "page" : undefined}
            onClick={() => go({ screen })}
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-[var(--hover)] ${i === 1 ? "mt-3" : ""} ${here === screen ? "bg-[var(--selected)] font-semibold" : "text-muted-foreground"}`}
          >
            <Icon className="size-4" />
            {label}
            {screen === "home" && count}
          </button>
        ))}
        <div className="mt-auto">{toggle}</div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col pr-2 pb-2 phone:p-0">
        {route.screen === "chat" ? (
          <ChatPage key={route.agent} agent={route.agent} />
        ) : route.screen === "agent" ? (
          <AgentPage key={route.agent} agent={route.agent} />
        ) : route.screen === "skills" ? (
          <SkillsPage focus={route.focus} adding={route.adding} />
        ) : route.screen === "mcps" ? (
          <McpsPage focus={route.focus} adding={route.adding} />
        ) : route.screen === "settings" ? (
          <SettingsPage login={login} toggle={<span className="wide:hidden">{toggle}</span>} />
        ) : (
          <AgentsPage />
        )}
        <nav aria-label="Main" className="grid shrink-0 grid-cols-4 wide:hidden">
          {NAV.map(({ screen, short, Icon }) => (
            <button
              key={screen}
              type="button"
              aria-current={here === screen ? "page" : undefined}
              onClick={() => go({ screen })}
              className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${here === screen ? "font-semibold text-foreground" : "text-muted-foreground"}`}
            >
              <Icon className="size-[18px]" />
              {short}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
