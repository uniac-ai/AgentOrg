import { NotConnected } from "@agentorg/sdk";
import { useSyncExternalStore } from "react";
import { api, useLoad } from "./data.ts";

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
/** The wait is over: the account has said where it stands now, signed in or not. */
export const endSigningIn = () => set(false);

/**
 * The shell's ChatGPT sign-in, for its own buttons: ChatGPT's page opens
 * in a new tab, and the shell moves on when `login` says it is signed in.
 */
export async function signIn() {
  if (signingIn) return;
  set(true);
  try {
    const { authorizeUrl } = await api
      .call<{ authorizeUrl: string }>("login", "start", {
        redirectUri: `${location.origin}${CALLBACK}`,
      })
      .catch((error: Error) => {
        // Its process hasn't connected yet: nothing opens from a wait, so the person tries again.
        throw error instanceof NotConnected
          ? new Error("ChatGPT is still starting. Try again in a moment.")
          : error;
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

/**
 * Where the person's ChatGPT stands: `unbound` (no `login` binding), `starting` (bound, its process
 * not connected yet, so a sign-in can't start), or `ready`. Read again as Actors change, so it's
 * `ready` the moment its process connects; until the first read, `undefined`.
 */
export function useChatGpt(): "unbound" | "starting" | "ready" | undefined {
  return useLoad(async () => {
    const { bindings } = await api.call<{
      bindings: { consumer: string; slot: string; provider: string }[];
    }>("bindings", "list", { actor: "person" });
    const provider = bindings.find((b) => b.consumer === "person" && b.slot === "login")?.provider;
    if (!provider) return "unbound" as const;
    const { connected } = await api.call<{ connected: boolean }>("actors", "get", {
      actorId: provider,
    });
    return connected ? ("ready" as const) : ("starting" as const);
  }, ["bindings", "actors"]).value;
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
