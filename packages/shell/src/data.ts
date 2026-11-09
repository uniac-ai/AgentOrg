import { useEffect, useState, useSyncExternalStore } from "react";
import { Api, type Connection } from "./api.ts";

export const api = new Api();

/** What the shell reads, each told to read again by its own events. */
export type Topic = "actors" | "bindings" | "login";
const versions: Record<Topic, number> = {
  actors: 0,
  bindings: 0,
  login: 0,
};
const listeners = new Set<() => void>();
let snapshot = { ...versions };
function bump(...topics: Topic[]) {
  for (const topic of topics) versions[topic]++;
  snapshot = { ...versions };
  for (const listener of [...listeners]) listener();
}
const subscribeVersions = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Audit kinds that change what a topic lists; the Hub has no other event for them. */
const AUDITED: [RegExp, Topic][] = [[/^(bind|unbind)$/, "bindings"]];
/**
 * Each topic's events. A subscription the gateway ends is made again (see `Api.subscribe`), and
 * what it says is read again then, since its events meanwhile are lost.
 */
const on = (slot: string, event: string, topics: Topic[], send = () => bump(...topics)) =>
  api.subscribe(slot, event, send, { again: () => bump(...topics) });
on("audit", "appended", ["bindings"], (entry?: unknown) => {
  const kind = String((entry as { kind?: unknown } | undefined)?.kind ?? "");
  for (const [pattern, topic] of AUDITED) if (pattern.test(kind)) bump(topic);
});
// Made, started, stopped, closed, its process gone, a channel admitted or dropped.
on("actors", "changed", ["actors"]);
on("login", "changed", ["login"]);
// A new connection: everything may have changed while it was down.
api.watch((connection) => {
  if (connection === "open") bump("actors", "bindings", "login");
});

export function useConnection(): Connection {
  return useSyncExternalStore(
    (fn) => api.watch(fn),
    () => api.connection,
  );
}

/**
 * Read with `load` while connected, and again each time one of `topics` changes. The last value
 * stays while a newer read runs, so nothing empties on a refresh.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  topics: Topic[],
  deps: unknown[] = [],
): { value?: T; error?: Error; loaded: boolean } {
  const connection = useConnection();
  const seen = useSyncExternalStore(subscribeVersions, () => snapshot);
  const [state, setState] = useState<{ value?: T; error?: Error; loaded: boolean }>({
    loaded: false,
  });
  const key = topics.map((topic) => seen[topic]).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` reads what `deps` and `key` say.
  useEffect(() => {
    if (connection !== "open") return;
    let current = true;
    load().then(
      (value) => current && setState({ value, loaded: true }),
      (error: Error) => current && setState({ error, loaded: true }),
    );
    return () => {
      current = false;
    };
  }, [connection, key, ...deps]);
  return state;
}

/**
 * A call a control makes: `busy` while it runs, so the control is disabled, and `failed` after
 * one that didn't work, for one quiet line in place. `done` runs after one that did.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = (call: () => Promise<unknown>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    call().then(
      () => {
        setBusy(false);
        done?.();
      },
      () => {
        setBusy(false);
        setFailed(true);
      },
    );
  };
  return { busy, failed, run };
}

/** The hash route: home, an agent, or settings. */
export type Route =
  | { screen: "home" }
  | { screen: "settings"; tab: "providers" | "account" }
  | { screen: "agent"; agent: string }
  | { screen: "agent-settings"; agent: string }
  | { screen: "skills" | "mcps"; focus?: string; adding?: boolean };
function routeOf(hash: string): Route {
  // Settings opens on its first tab.
  if (hash === "#/settings") return { screen: "skills" };
  const tab = /^#\/settings\/(providers|account)$/.exec(hash)?.[1];
  if (tab) return { screen: "settings", tab: tab as "providers" | "account" };
  const managed = /^#\/(skills|mcps)(?:\/(add|s\/([^/]+)))?$/.exec(hash);
  if (managed)
    return {
      screen: managed[1] as "skills" | "mcps",
      ...(managed[2] === "add" ? { adding: true } : {}),
      ...(managed[3] ? { focus: decodeURIComponent(managed[3]) } : {}),
    };
  const settings = /^#\/a\/([^/]+)\/settings$/.exec(hash)?.[1];
  if (settings) return { screen: "agent-settings", agent: decodeURIComponent(settings) };
  const agent = /^#\/a\/([^/]+)$/.exec(hash)?.[1];
  return agent ? { screen: "agent", agent: decodeURIComponent(agent) } : { screen: "home" };
}
export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (fn) => {
      addEventListener("hashchange", fn);
      return () => removeEventListener("hashchange", fn);
    },
    () => location.hash,
  );
  return routeOf(hash);
}
export function go(route: Route) {
  if (route.screen === "skills" || route.screen === "mcps") {
    const rest = route.adding ? "/add" : route.focus ? `/s/${encodeURIComponent(route.focus)}` : "";
    location.hash = `#/${route.screen}${rest}`;
    return;
  }
  if (route.screen === "settings") {
    location.hash = `#/settings/${route.tab}`;
    return;
  }
  location.hash =
    route.screen === "agent-settings"
      ? `#/a/${encodeURIComponent(route.agent)}/settings`
      : route.screen === "agent"
        ? `#/a/${encodeURIComponent(route.agent)}`
        : "#/";
}

export type ThemeName = "dark" | "light";
const THEME = "agentorg.theme";
const themeListeners = new Set<() => void>();
export function setTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME, theme);
  } catch {
    // Kept for this page only.
  }
  for (const listener of [...themeListeners]) listener();
}
try {
  if (localStorage.getItem(THEME) === "light") document.documentElement.dataset.theme = "light";
} catch {
  // Dark, the default.
}
export function useTheme(): ThemeName {
  return useSyncExternalStore(
    (fn) => {
      themeListeners.add(fn);
      return () => void themeListeners.delete(fn);
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}
