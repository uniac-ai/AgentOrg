import type {
  Actor as ActorSchema,
  BindingRequest as BindingRequestSchema,
  Binding as BindingSchema,
  Package as PackageSchema,
} from "@agentorg/interfaces";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import { Api, type Connection } from "./api.ts";

export type Actor = z.output<typeof ActorSchema>;
export type Binding = z.output<typeof BindingSchema>;
export type BindingRequest = z.output<typeof BindingRequestSchema>;
export type Package = z.output<typeof PackageSchema>;
export type Manifest = {
  name: string;
  modules: Record<string, { placement: string; slots: Record<string, string> }>;
};

export const api = new Api();

/** What the shell reads, each told to read again by its own events. */
export type Topic = "actors" | "packages" | "bindings" | "layout" | "grants" | "login";
const versions: Record<Topic, number> = {
  actors: 0,
  packages: 0,
  bindings: 0,
  layout: 0,
  grants: 0,
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
const AUDITED: [RegExp, Topic][] = [
  [/^package\./, "packages"],
  [/^(bind|unbind)$/, "bindings"],
];
/**
 * Each topic's events. A subscription the gateway ends is made again (see `Api.subscribe`), and
 * what it says is read again then, since its events meanwhile are lost.
 */
const on = (slot: string, event: string, topics: Topic[], send = () => bump(...topics)) =>
  api.subscribe(slot, event, send, { again: () => bump(...topics) });
on("audit", "appended", ["packages", "bindings"], (entry?: unknown) => {
  const kind = String((entry as { kind?: unknown } | undefined)?.kind ?? "");
  for (const [pattern, topic] of AUDITED) if (pattern.test(kind)) bump(topic);
});
// Made, started, stopped, closed, its process gone, a channel admitted or dropped.
on("actors", "changed", ["actors"]);
on("layout", "changed", ["layout"]);
on("grants", "requested", ["grants"]);
on("grants", "decided", ["grants", "bindings"]);
on("login", "changed", ["login"]);
// A new connection: everything may have changed while it was down.
api.watch((connection) => {
  if (connection === "open") bump("actors", "packages", "bindings", "layout", "grants", "login");
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

/** A package's manifest never changes: read once per hash. */
const manifests = new Map<string, Promise<Manifest>>();
export function manifestOf(hash: string): Promise<Manifest> {
  let found = manifests.get(hash);
  if (!found) {
    found = api
      .call<{ manifest: Manifest }>("packages", "get", { hash })
      .then((reply) => reply.manifest);
    found.catch(() => manifests.delete(hash));
    manifests.set(hash, found);
  }
  return found;
}

/** The hash route: home, an agent, or settings. */
export type Route =
  | { screen: "home" }
  | { screen: "settings" }
  | { screen: "agent"; agent: string };
function routeOf(hash: string): Route {
  if (hash === "#/settings") return { screen: "settings" };
  const agent = /^#\/a\/(.+)$/.exec(hash)?.[1];
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
  location.hash =
    route.screen === "agent"
      ? `#/a/${encodeURIComponent(route.agent)}`
      : route.screen === "settings"
        ? "#/settings"
        : "#/";
}

/** The shell's tokens, which every view gets as its theme. */
const TOKENS = [
  "font",
  "canvas",
  "surface",
  "raised",
  "card",
  "fg",
  "muted",
  "faint",
  "line",
  "hover",
  "selected",
  "accent",
  "accent-fg",
  "ok",
  "warn",
  "ring",
  "radius",
];
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
/** The current theme as CSS variables, for a view's frame. */
export function themeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    TOKENS.map((name) => [`--${name}`, style.getPropertyValue(`--${name}`).trim()]),
  );
}
