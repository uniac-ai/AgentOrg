import { useEffect, useRef, useState } from "react";
import { ASSISTANT } from "./agent-bindings.ts";
import {
  type Actor,
  api,
  type BindingRequest,
  go,
  type Package,
  setTheme,
  useAction,
  useConnection,
  useLoad,
  useRoute,
  useTheme,
} from "./data.ts";
import { Home, PlacedView } from "./home.tsx";
import { ChatGptIcon, GearIcon, HomeIcon, MoonIcon, PlusIcon } from "./icons.tsx";
import { NewAgent } from "./new-agent.tsx";
import { besideAgent, type Placement } from "./rules.ts";
import { Settings } from "./settings.tsx";
import { signIn, useSigningIn } from "./sign-in.ts";
import { ViewFrame } from "./view-frame.tsx";

export interface LoginStatus {
  state: "signed_out" | "signed_in" | "ineligible";
  account?: { email?: string; plan?: string };
}

/** Where ChatGPT shows the person's plan usage. */
export const USAGE = "https://chatgpt.com/settings/usage";
/** The person's store key that says the plan notice was shown. */
const PLAN_NOTICE = "ui/plan-notice";
const COLORS = ["#7dd3fc", "#a7f3d0", "#fcd34d", "#f9a8d4", "#c4b5fd", "#fdba74"];

/** An Actor's square: its initial, in a color of its own. */
export function Avatar({ actor, name }: { actor: string; name: string }) {
  let sum = 0;
  for (const char of actor) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ background: COLORS[sum % COLORS.length] }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The shell: signed out of AgentOrg, ChatGPT's first run, or the person's agents and views. */
export function App() {
  const connection = useConnection();
  if (connection === "signed-out") return <SignedOut />;
  return <SignedIn />;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main id="signin" aria-label="Sign in">
      <section className="signin-card">
        <div className="mark" aria-hidden>
          A
        </div>
        <h1>AgentOrg</h1>
        {children}
      </section>
    </main>
  );
}

/** No live session: only `agentorg open` makes one. */
function SignedOut() {
  return (
    <Card>
      <p className="quiet">Run agentorg open for a new sign-in link.</p>
    </Card>
  );
}

function SignedIn() {
  // A binding made or removed may be the login's: read it again then too.
  const login = useLoad(() => api.call<LoginStatus>("login", "status"), ["login", "bindings"]);
  const connection = useConnection();
  const waited = useWaited(!login.loaded && connection !== "open");
  // Unbound (or unreachable): no ChatGPT screen and no account row.
  const status = login.error ? undefined : login.value;
  const signedIn = status?.state === "signed_in";
  // Ineligible is past the first run: signing in again wouldn't change it.
  const past = signedIn || status?.state === "ineligible";
  const [passed, setPassed] = useState(false);
  const [notice, setNotice] = useState(false);
  const told = useRef(false);
  useEffect(() => {
    if (past) setPassed(true);
  }, [past]);
  useEffect(() => {
    if (!signedIn || told.current) return;
    told.current = true;
    // OpenAI's rule: once, after sign-in, the person is told requests use their plan.
    void api
      .call<{ value?: unknown }>("store", "get", { key: PLAN_NOTICE })
      .then(async ({ value }) => {
        if (value !== undefined) return;
        await api.call("store", "set", { key: PLAN_NOTICE, value: true });
        setNotice(true);
      })
      .catch(() => {});
  }, [signedIn]);
  if (!login.loaded)
    return waited ? (
      <Card>
        <p className="quiet" role="status">
          Reconnecting…
        </p>
      </Card>
    ) : null;
  if (status?.state === "signed_out" && !passed) return <FirstRun />;
  return (
    <>
      <Shell login={status} />
      {notice && (
        <div className="banner" role="status">
          You're using your ChatGPT plan{" "}
          <a href={USAGE} target="_blank" rel="noreferrer">
            Manage usage
          </a>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => setNotice(false)}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/** Whether `on` has held for a moment: a quick connection shows nothing in between. */
function useWaited(on: boolean, ms = 400): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (!on) return;
    const timer = setTimeout(() => setWaited(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return waited;
}

/** The first run: ChatGPT's sign-in, before anything else. */
function FirstRun() {
  const signingIn = useSigningIn();
  const { failed, run } = useAction();
  return (
    <Card>
      <button type="button" className="primary" disabled={signingIn} onClick={() => run(signIn)}>
        {signingIn ? <span className="spin" aria-hidden /> : <ChatGptIcon />}
        {signingIn ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}
      </button>
      <p className="quiet" role={failed ? "alert" : undefined}>
        {signingIn
          ? "Approve AgentOrg on ChatGPT's page, then come back here."
          : failed
            ? "ChatGPT's sign-in didn't start. Try again."
            : "Runs on your ChatGPT plan. Nothing is billed by us."}
      </p>
    </Card>
  );
}

const list =
  <T,>(slot: string, method: string, key: string) =>
  () =>
    api.call<Record<string, T[]>>(slot, method).then((reply) => reply[key] ?? []);

function Shell({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const connection = useConnection();
  const theme = useTheme();
  const actors = useLoad(list<Actor>("actors", "list", "actors"), ["actors"]).value ?? [];
  const packages = useLoad(list<Package>("packages", "list", "packages"), ["packages"]).value ?? [];
  const requests =
    useLoad(list<BindingRequest>("grants", "requests", "requests"), ["grants"]).value ?? [];
  const home = useLoad(list<Placement>("layout", "get", "home"), ["layout"]).value ?? [];
  const [menu, setMenu] = useState<string>();
  const [creating, setCreating] = useState(false);

  const agents = actors.filter(
    (actor) => actor.state !== "closed" && actor.views?.includes("chat"),
  );
  const agent =
    route.screen === "agent" ? actors.find((a) => a.actorId === route.agent) : undefined;
  const assistant = packages.find((pkg) => pkg.name === ASSISTANT);

  // A menu closes on any click outside it, and on a new screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route closes it too.
  useEffect(() => setMenu(undefined), [route.screen, route.screen === "agent" && route.agent]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest?.(".menu, [data-menu]")) setMenu(undefined);
    };
    // Focus moving into a view's frame blurs the window: that's a click elsewhere too.
    const blur = () => setMenu(undefined);
    document.addEventListener("click", close);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("blur", blur);
    };
  }, [menu]);

  const placed = (placement: Placement, kind: "placed" | "container", shown: Placement[]) => (
    <PlacedView
      key={placement.id}
      placement={placement}
      kind={kind}
      home={home}
      shown={shown}
      actors={actors}
      agents={agents}
      menuOpen={menu === placement.id}
      onMenu={() => setMenu(menu === placement.id ? undefined : placement.id)}
    />
  );

  return (
    <div id="app">
      <nav className="sidebar" aria-label="Agents">
        <div className="side-top">
          <button
            type="button"
            className="row home-row"
            aria-current={route.screen === "home" ? "page" : "false"}
            onClick={() => go({ screen: "home" })}
          >
            <HomeIcon />
            Home
            <span className="count" title="Waiting on you" hidden={!requests.length}>
              {requests.length}
            </span>
          </button>
        </div>
        {assistant && (
          <button
            type="button"
            className="row"
            style={{ opacity: 0.7 }}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            New agent
          </button>
        )}
        <div className="side-list scroll">
          <ul>
            {agents.map((a) => (
              <li key={a.actorId}>
                <button
                  type="button"
                  className="row"
                  aria-current={agent?.actorId === a.actorId ? "page" : undefined}
                  onClick={() => go({ screen: "agent", agent: a.actorId })}
                >
                  <Avatar actor={a.actorId} name={a.name} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.name}
                  </span>
                  <span
                    className={`glyph${a.state === "running" ? "" : " idle"}`}
                    role="img"
                    aria-label={a.state}
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="side-foot">
          <span
            className={`dot${connection === "open" ? "" : " off"}`}
            role="img"
            aria-label={connection === "open" ? "Hub running" : "Reconnecting"}
            title={connection === "open" ? "Hub running" : "Reconnecting"}
          />
          <span className="grow" />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Color: ${theme}`}
            title="Color"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <MoonIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={() => go({ screen: "settings" })}
          >
            <GearIcon />
          </button>
        </div>
      </nav>

      <div className="right">
        <header className="topbar">
          <nav className="path" aria-label="Path">
            {route.screen === "home" ? (
              <b>Home</b>
            ) : (
              <>
                <span>Home</span>
                <span className="sep">/</span>
                {route.screen === "settings" ? (
                  <b>Settings</b>
                ) : (
                  agent && (
                    <>
                      <Avatar actor={agent.actorId} name={agent.name} />
                      <b>{agent.name}</b>
                    </>
                  )
                )}
              </>
            )}
          </nav>
          <span className="spacer" />
        </header>
        <div className="stage">
          <section className="container main" aria-label={agent?.name ?? undefined}>
            {route.screen === "home" && (
              <Home requests={requests} home={home} actors={actors} placed={placed} />
            )}
            {route.screen === "settings" && <Settings login={login} />}
            {agent && agent.package !== "external" && agent.package !== "builtin" && (
              <ViewFrame
                key={agent.actorId}
                actor={agent.actorId}
                module="chat"
                hash={agent.package}
              />
            )}
          </section>
          <aside
            className="widgets scroll"
            aria-label="Placed beside this agent"
            hidden={route.screen !== "agent"}
          >
            {agent &&
              besideAgent(home, agent.actorId).map((p, _, beside) =>
                placed(p, "container", beside),
              )}
          </aside>
        </div>
      </div>
      {creating && assistant && (
        <NewAgent assistant={assistant.hash} actors={actors} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
