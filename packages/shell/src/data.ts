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

/** What an agent's page can show under its head. */
export type AgentTab = "computer" | "chats" | "overview";
/** The hash route: a place, chat or team. Settings is a window over the place, not a route. */
export type Route =
  /** The chat page, on your conversation with an agent if one is named. */
  | { screen: "chat"; agent?: string }
  /** The team page, on an agent's details if one is named. */
  | { screen: "team"; agent?: string; tab?: AgentTab };
function routeOf(hash: string): Route {
  // An agent's own address, from before its details were on the team page, shows them there.
  const team =
    /^#\/team(?:\/([^/]+)(?:\/(computer|chats|overview))?)?$/.exec(hash) ??
    /^#\/a\/([^/]+)(?:\/(computer|chats|overview))?$/.exec(hash);
  if (team)
    return {
      screen: "team",
      ...(team[1] ? { agent: decodeURIComponent(team[1]) } : {}),
      ...(team[2] ? { tab: team[2] as AgentTab } : {}),
    };
  // The app opens on Chat, and so does an address that names nothing.
  const chat = /^#\/chat(?:\/([^/]+))?$/.exec(hash);
  return { screen: "chat", ...(chat?.[1] ? { agent: decodeURIComponent(chat[1]) } : {}) };
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
  if (route.screen === "chat") {
    location.hash = `#/chat${route.agent ? `/${encodeURIComponent(route.agent)}` : ""}`;
    return;
  }
  const agent = route.agent ? `/${encodeURIComponent(route.agent)}` : "";
  location.hash = `#/team${agent}${route.agent && route.tab ? `/${route.tab}` : ""}`;
}

/** A section of Settings, in the order the window lists them. */
export type SettingsSection = "templates" | "skills" | "mcps" | "providers" | "account";
/** What is named in a section when it opens: a row to show, or its form for adding one. */
export interface SettingsNamed {
  focus?: string;
  adding?: boolean;
}
/**
 * The Settings window, over whatever place is looked at: whether it is open, its section, and what
 * is named in it. On a phone it shows its sections first (`listing`), then one section.
 */
export interface SettingsState extends SettingsNamed {
  open: boolean;
  section: SettingsSection;
  listing: boolean;
}
let settings: SettingsState = { open: false, section: "templates", listing: true };
const settingsListeners = new Set<() => void>();
function setSettings(next: SettingsState) {
  settings = next;
  for (const listener of [...settingsListeners]) listener();
}
export function useSettings(): SettingsState {
  return useSyncExternalStore(
    (fn) => {
      settingsListeners.add(fn);
      return () => void settingsListeners.delete(fn);
    },
    () => settings,
  );
}
/**
 * Opens Settings: straight on the section asked for, with what is named in it; or, asked for none,
 * on the section last looked at, its sections first on a phone.
 */
export function openSettings(section?: SettingsSection, named: SettingsNamed = {}) {
  setSettings({ open: true, section: section ?? settings.section, listing: !section, ...named });
}
/** Closes Settings. It opens again on the same section, with nothing named in it. */
export function closeSettings() {
  if (settings.open)
    setSettings({ open: false, section: settings.section, listing: settings.listing });
}
/** Another section, chosen in the window. */
export function pickSection(section: SettingsSection) {
  setSettings({ open: true, section, listing: false });
}
/** On a phone, back from a section to the sections. */
export function backToSections() {
  setSettings({ ...settings, listing: true });
}

/** What Settings' old addresses name: a section, with a row to show or its form for adding. */
function settingsAt(hash: string): [SettingsSection, SettingsNamed] | undefined {
  if (hash === "#/settings") return ["templates", {}];
  const tab = /^#\/settings\/(templates|providers|account)$/.exec(hash)?.[1];
  if (tab) return [tab as SettingsSection, {}];
  const managed = /^#\/(skills|mcps)(?:\/(add|s\/([^/]+)))?$/.exec(hash);
  if (!managed) return undefined;
  return [
    managed[1] as SettingsSection,
    {
      ...(managed[2] === "add" ? { adding: true } : {}),
      ...(managed[3] ? { focus: decodeURIComponent(managed[3]) } : {}),
    },
  ];
}
/** The address of the place being looked at, which Settings opens over. */
let place = "#/chat";
/**
 * An old Settings address opens the window on what it names, over the place that was behind (Chat
 * when there was none), and the address goes back to that place's. Going to a place closes it.
 * This runs before anything that reads the address, so nothing ever reads a Settings address.
 */
function readAddress() {
  const named = settingsAt(location.hash);
  if (named) {
    openSettings(...named);
    history.replaceState(history.state, "", place);
    return;
  }
  place = location.hash || "#/";
  closeSettings();
}
readAddress();
addEventListener("hashchange", readAddress);

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
