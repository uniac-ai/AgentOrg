// Settings' Providers and Account sections, drawn in the Settings window.
import { USAGE } from "../app.tsx";
import { api, pickSection, setTheme, type ThemeName, useLoad, useTheme } from "../data.ts";
import { Button } from "../ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { listAgents, listConnections, listMcpProviders, useAct, useCreatables } from "./data.ts";
import { type LoginStatus, needsOf, SignInButton, useLogin, useLoginStatus } from "./login.tsx";
import { Jump, rowClass, Scroll, Section, UsedBy } from "./parts.tsx";

const countOf = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
const THREE = "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] tight:grid-cols-1";

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
              <Jump to={() => pickSection("mcps")}>
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
        // Signed out, it says so, with the same way in the banner has.
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
