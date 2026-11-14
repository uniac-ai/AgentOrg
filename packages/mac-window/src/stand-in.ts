// A stand-in for the app, for the page in a browser: one canned answer per state of the design, in
// the service's own shapes, chosen by `?state=` (the first open when none). A switch asks for
// nothing the person would see. A row's Set up acts as if the person allowed what it brings: a
// browser a moment later reads on; a grant, through macOS's request or its pane, reads granted, and
// the app starts the driver again for a moment, while the service reads both grants as unknown.
// Open Login Items acts as if the person allowed AgentOrg there.
import type {
  Acting,
  AppState,
  Capability,
  Computer,
  Connection,
  Mac,
  Need,
  NeedName,
  Setup,
} from "./mac.ts";

const grant = (need: NeedName, state: Need["state"]): Need => ({ need, holder: "AgentOrg", state });
const browserNeeds = (chrome: Need["state"], edge: Need["state"]): Need[] => [
  { need: "chrome", name: "Chrome", state: chrome },
  { need: "edge", name: "Edge", state: edge },
];
const setupOf = (on: boolean, screen: [Need["state"], Need["state"]], browsers: Need[]): Setup => ({
  capabilities: [
    { capability: "terminal", on, ready: true, needs: [] },
    { capability: "files", on, ready: true, needs: [] },
    {
      capability: "screen",
      on,
      ready: screen.every((s) => s === "granted"),
      needs: [grant("screen-recording", screen[0]), grant("accessibility", screen[1])],
    },
    { capability: "browser", on, ready: browsers.some((b) => b.state === "on"), needs: browsers },
  ],
});
const FIRST_OPEN = setupOf(false, ["not-granted", "not-granted"], browserNeeds("off", "missing"));
const ALL_ON = setupOf(true, ["granted", "granted"], browserNeeds("on", "missing"));
const SCREEN_SHORT = setupOf(true, ["not-granted", "granted"], browserNeeds("on", "missing"));
const BROWSER_SHORT = setupOf(true, ["granted", "granted"], browserNeeds("off", "missing"));
const NO_BROWSER = setupOf(true, ["granted", "granted"], browserNeeds("missing", "missing"));

/** A time today on this Mac, as the service writes it. */
const at = (hour: number, minute: number, second = 0) => {
  const time = new Date();
  time.setHours(hour, minute, second, 0);
  return time.toISOString();
};
const WAITING: Connection = { connected: false, clients: [] };
const CONNECTED: Connection = {
  connected: true,
  clients: [
    { name: "AgentOrg", since: at(10, 42), local: true },
    { name: "AgentOrg 0.0.15", since: at(10, 42, 1), local: true },
  ],
};
/** The computers lent to, the newest first, as the service lists them. */
const LENT: Computer[] = [
  { name: "Inbox", startedAt: at(10, 42, 3), metadata: { agent: "agent-inbox" } },
  { name: "Research", startedAt: at(10, 42, 2), metadata: { agent: "agent-research" } },
];
const ACTING: Acting[] = [
  { who: "agent", name: "Research", capability: "browser", at: at(10, 47, 58) },
  { who: "person", capability: "files", at: at(10, 47, 55) },
];

interface Canned {
  app: AppState;
  setup: Setup;
  connection: Connection;
  computers?: Computer[];
  acting?: Acting[];
  /** What the first reading says instead: a grant the page then sees turned off, or the app running. */
  before?: { setup?: Setup; app?: AppState };
}
/** One canned answer for each of the design's states, by the state's name. */
export const STATES: Record<string, Canned> = {
  "first-open": { app: "running", setup: FIRST_OPEN, connection: WAITING },
  "all-on": { app: "running", setup: ALL_ON, connection: WAITING },
  "screen-needs-more": { app: "running", setup: SCREEN_SHORT, connection: WAITING },
  "browser-needs-more": { app: "running", setup: BROWSER_SHORT, connection: WAITING },
  "no-browser-installed": { app: "running", setup: NO_BROWSER, connection: WAITING },
  connected: { app: "running", setup: ALL_ON, connection: CONNECTED, computers: LENT },
  "connected-acting": {
    app: "running",
    setup: ALL_ON,
    connection: CONNECTED,
    computers: LENT,
    acting: ACTING,
  },
  "permission-withdrawn": {
    app: "running",
    before: { setup: ALL_ON },
    setup: SCREEN_SHORT,
    connection: CONNECTED,
    computers: LENT,
  },
  starting: { app: "starting", setup: FIRST_OPEN, connection: WAITING },
  "starting-again": {
    app: "starting again",
    before: { app: "running" },
    setup: ALL_ON,
    connection: WAITING,
  },
  "not-allowed-in-the-background": {
    app: "turned off",
    before: { app: "running" },
    setup: ALL_ON,
    connection: WAITING,
  },
};

/** How long the person takes to allow what was asked, and the app to start the driver again. */
const ALLOW = 1500;
const RESTART = 1200;
/** What a row's Set up is for: a grant not given, or a browser installed but off. */
const SET_UP: Need["state"][] = ["not-granted", "unknown", "off"];

export function standIn(name: string): Mac {
  const canned = STATES[name] ?? STATES["first-open"];
  if (!canned) throw new Error("No first open state");
  const copy = <T>(value: T): T => structuredClone(value);
  const setup = copy(canned.setup);
  let before = canned.before && copy(canned.before);
  let app = canned.app;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const part = (capability: Capability) => {
    const found = setup.capabilities.find((c) => c.capability === capability);
    if (!found) throw new Error(`No ${capability}`);
    return found;
  };
  const settle = () => {
    for (const c of setup.capabilities)
      c.ready =
        c.capability === "screen"
          ? c.needs.every((n) => n.state === "granted")
          : c.capability === "browser"
            ? c.needs.some((n) => n.state === "on")
            : true;
  };
  /** The person allows it: a grant is granted, and the driver starts again; a browser is on. */
  const allow = (capability: Capability, need: NeedName) =>
    setTimeout(() => {
      const asked = part(capability).needs.find((n) => n.need === need);
      if (!asked) return;
      if (capability === "screen") {
        asked.state = "granted";
        settle();
        app = "starting again";
        changed();
        setTimeout(() => {
          app = "running";
          changed();
        }, RESTART);
        return;
      }
      asked.state = "on";
      settle();
      changed();
    }, ALLOW);
  /** The service's answer; while the app starts, or isn't allowed to run, it isn't there to answer. */
  const answer = <T>(value: T, state = app): T => {
    if (state === "starting" || state === "turned off")
      throw { code: 503, message: "The service isn't running." };
    return copy(value);
  };
  /** The setup as the service reads it: while the driver starts again, its grants can't be read. */
  const read = (state = app): Setup => {
    const now = answer(setup, state);
    if (state !== "starting again") return now;
    const screen = now.capabilities.find((c) => c.capability === "screen");
    if (screen) {
      screen.ready = false;
      for (const n of screen.needs) n.state = "unknown";
    }
    return now;
  };
  /** A row's Set up; with no need, as the switch, nothing the person would see. */
  const ask = async (capability: Capability, need?: NeedName) => {
    answer(setup);
    const asked = part(capability).needs.find((n) => n.need === need);
    if (need && asked && SET_UP.includes(asked.state)) allow(capability, need);
    return read();
  };
  return {
    appState: async () => before?.app ?? app,
    setup: async () => {
      const first = before;
      before = undefined;
      if (!first) return read();
      setTimeout(changed, 0);
      return first.setup ? answer(first.setup) : read(first.app);
    },
    setSwitch: async (capability, on) => {
      answer(setup);
      part(capability).on = on;
      return read();
    },
    ask,
    openSettings: async (need) => {
      answer(setup);
      if (part("screen").needs.some((n) => n.need === need && n.state !== "granted"))
        allow("screen", need);
      return read();
    },
    openLoginItems: async () => {
      if (app !== "turned off") return;
      // Allowed there, macOS starts the app, which starts the service.
      setTimeout(() => {
        app = "starting";
        changed();
        setTimeout(() => {
          app = "running";
          changed();
        }, RESTART);
      }, ALLOW);
    },
    connection: async () => answer(canned.connection),
    computers: async () => answer(canned.computers ?? []),
    acting: async () => answer(canned.acting ?? []),
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fit: (height) => {
      document.documentElement.dataset.fit = String(height);
    },
  };
}
