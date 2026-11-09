import { type LoginStatus, USAGE } from "../app.tsx";
import { api, useLoad } from "../data.ts";
import { signIn, useSigningIn } from "../sign-in.ts";
import { Button } from "../ui/button.tsx";
import { type Creatable, listAgents, listConnections, listMcpProviders, useAct } from "./data.ts";
import { Jump, Page, Scroll, Section, UsedBy } from "./parts.tsx";
import { rowClass } from "./skills-page.tsx";

const countOf = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
const THREE = "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] phone:grid-cols-1";

export function SettingsPage({ login, toggle }: { login?: LoginStatus; toggle: React.ReactNode }) {
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
  const creatables =
    useLoad(
      () => api.call<{ creatables: Creatable[] }>("agents", "creatable").then((r) => r.creatables),
      ["actors"],
    ).value ?? [];
  return (
    <Page crumbs={[{ label: "Settings" }]} action={toggle}>
      <Scroll>
        <div className="mx-auto flex max-w-5xl flex-col gap-7">
          {login && (
            <Section title="ChatGPT">
              <Account login={login} />
            </Section>
          )}
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
        </div>
      </Scroll>
    </Page>
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
