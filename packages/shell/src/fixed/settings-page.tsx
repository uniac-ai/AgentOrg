import { type LoginStatus, USAGE } from "../app.tsx";
import { api, go, type Route, setTheme, type ThemeName, useLoad, useTheme } from "../data.ts";
import { signIn, useSigningIn } from "../sign-in.ts";
import { Button } from "../ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { listAgents, listConnections, listMcpProviders, useAct, useCreatables } from "./data.ts";
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

/** Settings' tabs, and what the tab offers beside them. */
export function SettingsFrame({
  tab,
  action,
  children,
}: {
  tab: Tab;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="no-bar flex shrink-0 items-center justify-between gap-2 overflow-x-auto px-5 pt-4 tight:px-3.5">
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
        {action}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function SettingsPage({
  tab,
  login,
}: {
  tab: "providers" | "account";
  login?: LoginStatus;
}) {
  return (
    <SettingsFrame tab={tab}>
      <Scroll>
        <div className="mx-auto flex max-w-5xl flex-col gap-7">
          {tab === "providers" ? <Providers /> : <AccountTab login={login} />}
        </div>
      </Scroll>
    </SettingsFrame>
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

function AccountTab({ login }: { login?: LoginStatus }) {
  const theme = useTheme();
  return (
    <>
      {login && (
        <Section title="ChatGPT">
          <Account login={login} />
        </Section>
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

/** Who's signed in to ChatGPT, and the way out or in. */
function Account({ login }: { login: LoginStatus }) {
  const act = useAct();
  const signingIn = useSigningIn();
  const signedIn = login.state === "signed_in";
  return (
    <div className={`${rowClass(false)} grid-cols-[minmax(0,1fr)_auto]`}>
      <div className="min-w-0">
        <div className="truncate font-medium">
          {signedIn ? (login.account?.email ?? "Signed in") : "Signed out"}
        </div>
        <div
          className={`truncate text-[13px] ${act.failed ? "text-[var(--bad)]" : "text-muted-foreground"}`}
          role={act.failed ? "alert" : undefined}
        >
          {act.failed ??
            (login.state === "ineligible"
              ? "This ChatGPT plan isn't eligible."
              : login.account?.plan)}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {signedIn && (
          <>
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
          </>
        )}
        {login.state === "signed_out" && (
          <Button size="sm" disabled={signingIn || act.busy} onClick={() => act.run(signIn)}>
            {signingIn ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}
          </Button>
        )}
      </div>
    </div>
  );
}
