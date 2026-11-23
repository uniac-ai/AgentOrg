// What is left to set up, which is the model account. Being signed out of it never keeps a
// person out of the app. They see their agents and chats, a banner across the top says what is
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
      // A sign-in that doesn't start leaves the button as it was, to be pressed again, and the
      // banner says so.
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

/**
 * What is left to set up, as a banner across the top of the app, over the frame and every page. It
 * is there while something is, and gone once nothing is; it has no close. It holds a title and the
 * way in, at one height through every state, so going from one to the next moves nothing. Wider
 * than a phone its title starts 96 in, past the room a window's own buttons take at the top left.
 * On a phone the title wraps beside the way in.
 */
export function SignInBanner() {
  const login = useLogin();
  const didnt = useFailed();
  if (login === "in") return null;
  // ChatGPT's page couldn't be opened: the banner says so, and the way in can be pressed again.
  const refused = didnt && login === "out";
  return (
    <section
      aria-label="Set up"
      className="flex h-12 shrink-0 items-center gap-4 border-b bg-[var(--raised)] px-4 wide:pl-24 phone:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <h2 className="shrink-0 text-[15px] font-semibold phone:line-clamp-2 phone:min-w-0 phone:shrink phone:leading-[18px]">
          {login === "ineligible" ? "This ChatGPT account can't be used" : "Sign in with ChatGPT"}
        </h2>
        {refused && (
          <p role="alert" className="min-w-0 truncate text-[13px] text-[var(--bad)] phone:hidden">
            ChatGPT's page couldn't be opened. Try again.
          </p>
        )}
      </div>
      <SignInButton className="h-8 w-[196px] text-[13px]" />
    </section>
  );
}
