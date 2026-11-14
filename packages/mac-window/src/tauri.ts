// Inside the app, the seam is its Tauri commands, reached through what Tauri gives the page
// (`withGlobalTauri` in the app's tauri.conf.json), so the page has no Tauri package of its own.
// The commands answer with the service's own shapes, and reject with its `{ code, message }`.
import type { AppState, Capability, Mac, NeedName } from "./mac.ts";

interface Tauri {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen(event: string, handler: () => void): Promise<() => void> };
}

const tauri = (globalThis as { __TAURI__?: Tauri }).__TAURI__;

/** Whether the page is in the app's window. */
export const inTauri = (): boolean => tauri !== undefined;

/** The app's implementation of the seam. */
export function tauriMac(): Mac {
  const { core, event } = tauri as Tauri;
  return {
    setup: () => core.invoke("setup"),
    setSwitch: (capability: Capability, on: boolean) =>
      core.invoke("set_switch", { capability, on }),
    ask: (capability: Capability, need?: NeedName) => core.invoke("ask", { capability, need }),
    connection: () => core.invoke("connection"),
    computers: () => core.invoke("computers"),
    acting: () => core.invoke("acting"),
    appState: () => core.invoke<AppState>("app_state"),
    onChanged(listener) {
      // Listening starts once Tauri says so: a stop before then stops it as soon as it has.
      let stop: (() => void) | undefined;
      let stopped = false;
      void event.listen("changed", listener).then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      });
      return () => {
        stopped = true;
        stop?.();
      };
    },
    fit: (height: number) => void core.invoke("fit", { height }),
  };
}
