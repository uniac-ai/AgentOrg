// What is left to set up, which is the model account. Being signed out of it never keeps a
// person out of the app. They see their agents and chats, Home says what is
// missing and holds the way to fix it, and every place it bites says the same sentence.
import { LoaderCircleIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { endSigningIn, signIn, useChatGpt, useSigningIn } from "../sign-in.ts";
import { Button } from "../ui/button.tsx";

/** What the model account says of itself. */
export interface LoginStatus {
  state: "signed_out" | "signed_in" | "ineligible";
  account?: { email?: string; plan?: string };
}
/**
 * Where the model account stands: signed in, signed out, waiting for ChatGPT's page to be
 * approved, ChatGPT's own process still starting, or an account that can't be used here.
 */
export type Login = "in" | "out" | "waiting" | "starting" | "ineligible";

const Context = createContext<{ login: Login; status?: LoginStatus | undefined }>({ login: "in" });
export const useLogin = () => useContext(Context).login;
/** What the account says of itself; nothing when there is no model account to sign in to. */
export const useLoginStatus = () => useContext(Context).status;

export function LoginProvider({
  status,
  children,
}: {
  status?: LoginStatus | undefined;
  children: React.ReactNode;
}) {
  const chatgpt = useChatGpt();
  const signingIn = useSigningIn();
  // The wait for ChatGPT's page is over once the account says where it stands now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: again each time its state changes.
  useEffect(endSigningIn, [status?.state]);
  // Signed in, by this tab or another, a sign-in that didn't start before is nothing to say.
  useEffect(() => {
    if (status?.state === "signed_in") setFailed(false);
  }, [status?.state]);
  /** Where it stood when the account last said: it holds while the account can't be asked. */
  const said = useRef<Login>(undefined);
  const login = ((): Login => {
    if (status) {
      if (status.state === "signed_in") return "in";
      if (signingIn) return "waiting";
      return status.state === "ineligible" ? "ineligible" : "out";
    }
    // With no account to sign in to, nothing is left to set up.
    if (chatgpt === "unbound") return "in";
    // ChatGPT's process isn't connected, so a sign-in can't start; someone signed in stays so.
    if (chatgpt === "starting") return said.current === "in" ? "in" : "starting";
    // Not read yet, or being read again.
    return said.current ?? "in";
  })();
  if (status) said.current = login;
  const value = useMemo(() => ({ login, status }), [login, status]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The one sentence, wherever an agent would have worked. */
export const needsOf = (login: Login): string | undefined =>
  login === "in"
    ? undefined
    : login === "ineligible"
      ? "This ChatGPT account isn't eligible to use its plan in this app."
      : "Agents can't work until you sign in with ChatGPT.";

/** Whether the last press of the way in failed to start a sign-in: ChatGPT's page didn't open. */
let failed = false;
const told = new Set<() => void>();
const setFailed = (next: boolean) => {
  if (failed === next) return;
  failed = next;
  for (const tell of [...told]) tell();
};
const useFailed = () =>
  useSyncExternalStore(
    (tell) => {
      told.add(tell);
      return () => void told.delete(tell);
    },
    () => failed,
  );

/** The way in. It keeps its size through every state, so pressing it moves nothing. */
export function SignInButton({ className = "" }: { className?: string }) {
  const login = useLogin();
  const waiting = login === "waiting" || login === "starting";
  return (
    <Button
      className={`h-10 w-[232px] shrink-0 rounded-full text-[15px] ${className}`}
      disabled={waiting}
      // A sign-in that doesn't start leaves the button as it was, to be pressed again, and Home's
      // place says so.
      onClick={() => {
        setFailed(false);
        signIn().catch(() => setFailed(true));
      }}
    >
      {waiting && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />}
      {login === "waiting"
        ? "Waiting for ChatGPT…"
        : login === "starting"
          ? "ChatGPT is starting…"
          : login === "ineligible"
            ? "Use another account"
            : "Continue with ChatGPT"}
    </Button>
  );
}

const STATES = ["out", "waiting", "ineligible"] as const;
const TITLES = {
  out: "Sign in with ChatGPT",
  ineligible: "This ChatGPT account can't be used",
};
const WORDS = {
  out: "Your agents can't work until you do. ChatGPT's page opens, you approve AgentOrg there, and you come back here. It runs on your ChatGPT plan, and nothing is billed by us.",
  waiting: "Approve AgentOrg on ChatGPT's page, then come back here.",
  ineligible:
    "It isn't eligible to use its plan in this app, so your agents can't work. Sign in with another account.",
};
const cell = (on: boolean) => `col-start-1 row-start-1 ${on ? "" : "invisible"}`;

/**
 * Home's place for what is left to set up. It is there while something is, and gone once nothing
 * is. Every state's words are laid in the same cell, the others unseen, so the place is as tall
 * as its longest and going from one state to the next moves nothing.
 */
export function LeftToSetUp() {
  const login = useLogin();
  const didnt = useFailed();
  if (login === "in") return null;
  const which = login === "ineligible" ? "ineligible" : login === "waiting" ? "waiting" : "out";
  // ChatGPT's page couldn't be opened: the place says so, and the way in can be pressed again.
  const refused = didnt && which === "out";
  // While it waits, the title is the one it had signed out.
  const titled = which === "waiting" ? "out" : which;
  return (
    <section
      aria-label="Set up"
      className="flex items-center gap-6 rounded-3xl bg-[var(--raised)] px-6 py-5 tight:flex-col tight:items-stretch tight:gap-4"
    >
      <div className="min-w-0 flex-1">
        <div className="grid">
          {(["out", "ineligible"] as const).map((s) => (
            <h2 key={s} className={`text-[17px] font-semibold ${cell(s === titled)}`}>
              {TITLES[s]}
            </h2>
          ))}
        </div>
        <div className="mt-1 grid">
          {STATES.map((s) => (
            <p
              key={s}
              className={`text-[15px] text-muted-foreground ${cell(s === which && !refused)}`}
            >
              {WORDS[s]}
            </p>
          ))}
          {refused && (
            <p role="alert" className="col-start-1 row-start-1 text-[15px] text-[var(--bad)]">
              ChatGPT's page couldn't be opened. Try again.
            </p>
          )}
        </div>
      </div>
      <SignInButton className="tight:w-full" />
    </section>
  );
}
