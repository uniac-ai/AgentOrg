import { useSyncExternalStore } from "react";
import { api } from "./data.ts";

/** Where ChatGPT sends the browser back to; the gateway completes the sign-in there. */
const CALLBACK = "/oauth/chatgpt";
/** How long the button waits for ChatGPT before it can be pressed again. */
const WAIT_MS = 120_000;

let signingIn = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
function set(value: boolean) {
  signingIn = value;
  clearTimeout(timer);
  if (value) timer = setTimeout(() => set(false), WAIT_MS);
  for (const listener of [...listeners]) listener();
}
// The login's state changed: signed in, or not; either way the wait is over.
api.subscribe("login", "changed", () => set(false));

/**
 * The shell's ChatGPT sign-in, for its own buttons and `ui.shell@1.signIn`: ChatGPT's page opens
 * in a new tab, and the shell moves on when `login` says it is signed in.
 */
export async function signIn() {
  if (signingIn) return;
  set(true);
  try {
    const { authorizeUrl } = await api.call<{ authorizeUrl: string }>("login", "start", {
      redirectUri: `${location.origin}${CALLBACK}`,
    });
    // ChatGPT's own page, over https only: anything else isn't opened.
    if (new URL(authorizeUrl).protocol !== "https:")
      throw new Error("The sign-in address isn't https.");
    window.open(authorizeUrl, "_blank", "noopener,noreferrer");
  } catch (error) {
    set(false);
    throw error;
  }
}

export function useSigningIn(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => signingIn,
  );
}
