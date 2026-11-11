import { useEffect, useRef, useState } from "react";
import { api, useConnection, useLoad } from "./data.ts";
import type { LoginStatus } from "./fixed/login.tsx";
import { CopyCommand } from "./fixed/parts.tsx";
import { FixedShell } from "./fixed/shell.tsx";

/** Where ChatGPT shows the person's plan usage. */
export const USAGE = "https://chatgpt.com/settings/usage";
/** The person's store key that says the plan notice was shown. */
const PLAN_NOTICE = "ui/plan-notice";

/** The shell: this tab signed out of AgentOrg, or the person's agents. */
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

/**
 * This tab's own sign-in ended. Rare, since a tab stays signed in across restarts: it says what
 * happened and hands over the one command that gives a new link.
 */
function SignedOut() {
  return (
    <div
      data-shell
      data-ui="fixed"
      className="grid h-full min-h-0 w-full place-items-center bg-[var(--canvas)] text-[15px] leading-[1.5] text-foreground"
    >
      <main
        aria-label="Signed out"
        className="flex max-w-[420px] flex-col items-center gap-4 px-6 text-center"
      >
        <h1 className="text-[22px] font-semibold tracking-tight">AgentOrg</h1>
        <p className="text-[15px] text-muted-foreground">
          This tab is no longer signed in. Run this for a new sign-in link.
        </p>
        <CopyCommand command="agentorg open" />
      </main>
    </div>
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
  // Unbound (or unreachable): nothing to sign in to, and no account row.
  const status = login.error ? undefined : login.value;
  const signedIn = status?.state === "signed_in";
  const [notice, setNotice] = useState(false);
  const told = useRef(false);
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
