import { CirclePlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, useAction, useConnection, useLoad } from "./data.ts";
import { FixedShell } from "./fixed/shell.tsx";
import { signIn, useChatGpt, useSigningIn } from "./sign-in.ts";

export interface LoginStatus {
  state: "signed_out" | "signed_in" | "ineligible";
  account?: { email?: string; plan?: string };
}

/** Where ChatGPT shows the person's plan usage. */
export const USAGE = "https://chatgpt.com/settings/usage";
/** The person's store key that says the plan notice was shown. */
const PLAN_NOTICE = "ui/plan-notice";

/** The shell: signed out of AgentOrg, ChatGPT's first run, or the person's agents. */
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
  if (!login.loaded)
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
      <FixedShell login={status} />
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
        {signingIn ? <span className="spin" aria-hidden /> : <CirclePlusIcon className="size-4" />}
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
