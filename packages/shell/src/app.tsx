import {
  ChatGptIcon,
  GearIcon,
  HomeIcon,
  MoonIcon,
  PlusIcon,
  ResizableGroup,
  ResizablePanel,
  ResizeHandle,
} from "@agentorg/kit";
import { NotConnected, Refused } from "@agentorg/sdk";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FIRST_RUN } from "./agent-bindings.ts";
import {
  type Actor,
  api,
  type BindingRequest,
  go,
  setTheme,
  useAction,
  useConnection,
  useLoad,
  useRoute,
  useTheme,
} from "./data.ts";
import { AgentMenu } from "./delete-agent.tsx";
import { listAgents } from "./fixed/data.ts";
import { FixedShell } from "./fixed/shell.tsx";
import { Home, PlacedView } from "./home.tsx";
import { NewAgent } from "./new-agent.tsx";
import { besideAgent, type Placement } from "./rules.ts";
import { Settings } from "./settings.tsx";
import { signIn, useChatGpt, useSigningIn } from "./sign-in.ts";
import { ViewFrame } from "./view-frame.tsx";
import { keepWidth, storedWidth, WIDGETS } from "./widths.ts";

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
  // A binding made or removed may be the login's, and ChatGPT's process may have connected since:
  // read it again then too.
  const login = useLoad(
    () => api.call<LoginStatus>("login", "status"),
    ["login", "bindings", "actors"],
  );
  // A gateway with no `agents` slot refuses this, and one with no management bound can't answer:
  // the older pages, until they go.
  const management = useLoad(listAgents, ["actors", "bindings"]);
  const older =
    management.error instanceof NotConnected ||
    (management.error instanceof Refused && management.error.code === "invalid");
  const connection = useConnection();
  const waited = useWaited(!login.loaded && connection !== "open");
  // Unbound (or unreachable): no ChatGPT screen and no account row.
  const status = login.error ? undefined : login.value;
  const signedIn = status?.state === "signed_in";
  // Ineligible is past the first run: signing in again wouldn't change it.
  const past = signedIn || status?.state === "ineligible";
  const chatgpt = useChatGpt();
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
  if (!login.loaded || !management.loaded)
    return waited ? (
      <Card>
        <p className="quiet" role="status">
          Reconnecting…
        </p>
      </Card>
    ) : null;
  // Signed out, or not known yet because ChatGPT's process is still starting: its first run.
  if (!passed && (status?.state === "signed_out" || (!status && chatgpt === "starting")))
    return <FirstRun ready={chatgpt === "ready"} />;
  return (
    <>
      {older ? <Shell login={status} /> : <FixedShell login={status} />}
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
function FirstRun({ ready }: { ready: boolean }) {
  const signingIn = useSigningIn();
  const { failed, run } = useAction();
  return (
    <Card>
      <button
        type="button"
        className="primary"
        // ChatGPT's process connects a moment after it starts: until then, signing in can't start.
        disabled={signingIn || !ready}
        onClick={() => run(signIn)}
      >
        {signingIn ? <span className="spin" aria-hidden /> : <ChatGptIcon />}
        {signingIn ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}
      </button>
      <p className="quiet" role={failed ? "alert" : undefined}>
        {signingIn
          ? "Approve AgentOrg on ChatGPT's page, then come back here."
          : !ready
            ? "ChatGPT is starting…"
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

/** Whether the screen is wide enough for the widgets beside an agent: 1,100 px and more. */
const WIDE = "(min-width: 1100px)";
function useWide(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = matchMedia(WIDE);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => matchMedia(WIDE).matches,
  );
}

function Shell({ login }: { login?: LoginStatus }) {
  const route = useRoute();
  const connection = useConnection();
  const theme = useTheme();
  const actors = useLoad(list<Actor>("actors", "list", "actors"), ["actors"]).value ?? [];
  const requests =
    useLoad(list<BindingRequest>("grants", "requests", "requests"), ["grants"]).value ?? [];
  const home = useLoad(list<Placement>("layout", "get", "home"), ["layout"]).value ?? [];
  const [menu, setMenu] = useState<string>();
  const [creating, setCreating] = useState(false);
  const wide = useWide();

  const agents = actors.filter(
    (actor) => actor.state !== "closed" && actor.views?.includes("chat"),
  );
  const agent =
    route.screen === "agent" ? actors.find((a) => a.actorId === route.agent) : undefined;
  // The app's own assistant, as its first run recorded it; it adds the package first.
  const assistant = useLoad(
    () =>
      api
        .call<{ value?: { assistant?: unknown } }>("store", "get", { key: FIRST_RUN })
        .then(({ value }) => (typeof value?.assistant === "string" ? value.assistant : undefined)),
    ["packages"],
  ).value;
  // An agent with nothing beside it: no column, and the chat takes the width.
  const beside = agent ? besideAgent(home, agent.actorId) : [];

  // A menu closes on a click outside it (the kit's), on a new screen, and when focus moves into a
  // view's frame, which blurs the window: a click there reaches no listener of this document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route closes it too.
  useEffect(() => setMenu(undefined), [route.screen, route.screen === "agent" && route.agent]);
  useEffect(() => {
    if (!menu) return;
    const blur = () => setMenu(undefined);
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
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
      onMenu={(open) => setMenu(open ? placement.id : undefined)}
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
          {agent && agents.includes(agent) && <AgentMenu key={agent.actorId} agent={agent} />}
        </header>
        {/* The chat, and beside it the column its width is the person's to drag: 280–640 px, never
            more than half the stage. The column is there only with something in it, on a screen
            wide enough. */}
        <ResizableGroup className="stage" orientation="horizontal">
          <ResizablePanel id="main" minSize="50%" className="panel">
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
          </ResizablePanel>
          {beside.length > 0 && wide && (
            <>
              <ResizeHandle label="Resize the widgets" />
              <ResizablePanel
                id="widgets"
                defaultSize={storedWidth()}
                minSize={WIDGETS.min}
                maxSize={WIDGETS.max}
                className="panel"
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size, _id, before) => before && keepWidth(size.inPixels)}
              >
                <aside className="widgets scroll" aria-label="Placed beside this agent">
                  {beside.map((p) => placed(p, "container", beside))}
                </aside>
              </ResizablePanel>
            </>
          )}
        </ResizableGroup>
      </div>
      {creating && assistant && (
        <NewAgent assistant={assistant} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
