import { PlusIcon } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { USAGE } from "../app.tsx";
import { api, go, type Route, setTheme, type ThemeName, useLoad, useTheme } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { listAgents, listConnections, listMcpProviders, useAct, useCreatables } from "./data.ts";
import { type LoginStatus, needsOf, SignInButton, useLogin, useLoginStatus } from "./login.tsx";
import { Jump, rowClass, Scroll, Section, UsedBy } from "./parts.tsx";

const countOf = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
const THREE = "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] tight:grid-cols-1";

type Tab = "templates" | "skills" | "mcps" | "providers" | "account";
const ROUTES: Record<Tab, Route> = {
  templates: { screen: "settings", tab: "templates" },
  skills: { screen: "skills" },
  mcps: { screen: "mcps" },
  providers: { screen: "settings", tab: "providers" },
  account: { screen: "settings", tab: "account" },
};

/** What a section offers, by its name. */
interface Offer {
  label: string;
  run(): void;
}
const Offered = createContext<(offer?: Offer) => void>(() => {});
/** The section drawn under the frame offers this at the end of the row of sections. */
export function useOffer(label: string, run: () => void) {
  const offer = useContext(Offered);
  const latest = useRef(run);
  latest.current = run;
  // Before anything is painted, so a section and what it offers change as one.
  useLayoutEffect(() => {
    offer({ label, run: () => latest.current() });
    return () => offer(undefined);
  }, [offer, label]);
}

/** The section a route is, if it is one of Settings'. */
export const sectionOf = (route: Route): Tab | undefined =>
  route.screen === "settings"
    ? route.tab
    : route.screen === "skills" || route.screen === "mcps"
      ? route.screen
      : undefined;

/**
 * Settings' sections across the top, with what the section offers at their end, over its page.
 * Where there is little room what it offers is its mark alone. It is one frame for every section,
 * so the row keeps the keyboard and its place as the section under it changes.
 */
export function SettingsFrame({ tab, children }: { tab: Tab; children: React.ReactNode }) {
  const [action, setAction] = useState<Offer>();
  return (
    // The row and the page under it are 1080 wide and centred; what scrolls is as wide as the
    // page area, so the wheel works beside the page as well as over it.
    <div className="flex h-full flex-col pt-2">
      <div className="mx-auto w-full max-w-[1080px] shrink-0">
        <div className="no-bar flex items-center justify-between gap-2 overflow-x-auto px-5 pt-4 tight:px-3.5">
          <Tabs value={tab} onValueChange={(next) => go(ROUTES[next as Tab])}>
            <TabsList>
              <TabsTrigger value="templates">Templates</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="mcps">
                <span className="tight:hidden">MCP connections</span>
                <span className="hidden tight:inline">MCPs</span>
              </TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
              <TabsTrigger value="account">Account</TabsTrigger>
            </TabsList>
          </Tabs>
          {action && (
            <Button size="sm" aria-label={action.label} onClick={action.run}>
              <PlusIcon />
              <span className="tight:hidden">{action.label}</span>
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Offered.Provider value={setAction}>{children}</Offered.Provider>
      </div>
    </div>
  );
}

export function SettingsPage({ tab }: { tab: "providers" | "account" }) {
  return (
    <Scroll>
      <div className="mx-auto flex max-w-5xl flex-col gap-7">
        {tab === "providers" ? <Providers /> : <AccountTab />}
      </div>
    </Scroll>
  );
}

function Providers() {
  const agents = useLoad(listAgents, ["actors"]).value ?? [];
  const connections = useLoad(listConnections, ["actors"]).value ?? [];
  const mcpProviders = useLoad(listMcpProviders, ["actors"]).value ?? [];
  const agentProviders =
    useLoad(
      () =>
        api
          .call<{ providers: { provider: string; name: string }[] }>("agents", "providers")
          .then((reply) => reply.providers),
      ["actors"],
    ).value ?? [];
  const creatables = useCreatables() ?? [];
  return (
    <>
      <Section title="Agent providers">
        {agentProviders.map((provider) => (
          <div key={provider.provider} className={`${rowClass(false)} ${THREE}`}>
            <div className="truncate font-medium">{provider.name}</div>
            <span className="truncate text-[13px] text-muted-foreground">
              {creatables
                .filter((c) => c.provider === provider.provider)
                .map((c) => c.title)
                .join(", ")}
            </span>
            <UsedBy agents={agents.filter((a) => a.provider === provider.provider)} />
          </div>
        ))}
      </Section>
      <Section title="MCP providers">
        {mcpProviders.map((provider) => (
          <div key={provider.provider} className={`${rowClass(false)} ${THREE}`}>
            <div className="truncate font-medium">{provider.name}</div>
            <span className="truncate text-[13px] text-muted-foreground">
              {provider.kinds.map((k) => k.title).join(", ")}
            </span>
            <span className="text-[13px] text-muted-foreground">
              <Jump to={{ screen: "mcps" }}>
                {countOf(
                  connections.filter((c) => c.origin?.provider === provider.provider).length,
                )}
              </Jump>
            </span>
          </div>
        ))}
      </Section>
    </>
  );
}

function AccountTab() {
  const theme = useTheme();
  const login = useLoginStatus();
  const needs = needsOf(useLogin());
  return (
    <>
      {login?.state === "signed_in" ? (
        <Section title="ChatGPT">
          <Account login={login} />
        </Section>
      ) : (
        // Signed out, it says so, with the same way in Home has.
        needs && (
          <Section title="ChatGPT">
            <div
              className={`${rowClass(false)} grid-cols-[minmax(0,1fr)_auto] tight:grid-cols-1 tight:gap-y-3`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">Signed out</div>
                <div className="truncate text-[13px] text-muted-foreground">{needs}</div>
              </div>
              <SignInButton className="tight:w-full" />
            </div>
          </Section>
        )
      )}
      <Section title="Color">
        <Select value={theme} onValueChange={(next) => setTheme(next as ThemeName)}>
          <SelectTrigger aria-label="Color" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="light">Light</SelectItem>
          </SelectContent>
        </Select>
      </Section>
    </>
  );
}

/** Who's signed in to ChatGPT, and the way out. */
function Account({ login }: { login: LoginStatus }) {
  const act = useAct();
  return (
    <div className={`${rowClass(false)} grid-cols-[minmax(0,1fr)_auto]`}>
      <div className="min-w-0">
        <div className="truncate font-medium">{login.account?.email ?? "Signed in"}</div>
        <div
          className={`truncate text-[13px] ${act.failed ? "text-[var(--bad)]" : "text-muted-foreground"}`}
          role={act.failed ? "alert" : undefined}
        >
          {act.failed ?? login.account?.plan}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <a
          href={USAGE}
          target="_blank"
          rel="noreferrer"
          className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Manage usage
        </a>
        <Button
          variant="ghost"
          size="sm"
          disabled={act.busy}
          onClick={() => act.run(() => api.call("login", "logout"))}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
