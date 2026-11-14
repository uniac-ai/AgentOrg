// A stand-in for the app, for the page in a browser: one canned answer per state of the design, in
// the service's own shapes, chosen by `?state=` (the first open when none). Asking acts as if the
// person allowed it: a moment later the need reads granted or on, and after a grant the app starts
// the driver again for a moment, while the service reads both grants as unknown.
import type {
  Acting,
  AppState,
  Capability,
  Computer,
  Connection,
  Mac,
  Need,
  NeedName,
  Refusal,
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
};

/** How long the person takes to allow what was asked, and the app to start the driver again. */
const ALLOW = 1500;
const RESTART = 1200;
/** The service's words when it can't ask for a browser: none is installed. */
const NO_BROWSER_WORDS = "Neither Chrome nor Edge is installed on this machine.";

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
  /** The person allows what was asked: a grant is granted, and the driver starts again. */
  const allow = (capability: Capability, need?: NeedName) =>
    setTimeout(() => {
      const needs = part(capability).needs;
      if (capability === "screen") {
        for (const n of needs) if (!need || n.need === need) n.state = "granted";
        settle();
        app = "starting again";
        changed();
        setTimeout(() => {
          app = "running";
          changed();
        }, RESTART);
        return;
      }
      const browser = needs.find((n) => (need ? n.need === need : n.state === "off"));
      if (browser) browser.state = "on";
      settle();
      changed();
    }, ALLOW);
  /** What the service refuses: a browser that isn't installed can't be asked for. */
  const refusal = (capability: Capability, need?: NeedName): Refusal | undefined => {
    if (capability !== "browser") return undefined;
    const needs = part(capability).needs;
    const asked = needs.filter((n) => (need ? n.need === need : n.state !== "missing"));
    if (asked.some((n) => n.state !== "missing")) return undefined;
    const browser = asked[0]?.name;
    return {
      code: 409,
      message: browser ? `${browser} isn't installed on this machine.` : NO_BROWSER_WORDS,
    };
  };
  /** The service's answer; while the app starts, it isn't there to answer yet. */
  const answer = <T>(value: T): T => {
    if (app === "starting") throw { code: 503, message: "The service isn't running yet." };
    return copy(value);
  };
  /** The setup as the service reads it: while the driver starts again, its grants can't be read. */
  const read = (state = app): Setup => {
    const now = answer(setup);
    if (state !== "starting again") return now;
    const screen = now.capabilities.find((c) => c.capability === "screen");
    if (screen) {
      screen.ready = false;
      for (const n of screen.needs) n.state = "unknown";
    }
    return now;
  };
  const ask = async (capability: Capability, need?: NeedName) => {
    const refused = refusal(capability, need);
    if (refused) throw refused;
    if (!part(capability).ready) allow(capability, need);
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
      if (!on || part(capability).ready) return read();
      try {
        return await ask(capability);
      } catch (error) {
        const refused = error as Refusal;
        throw {
          ...refused,
          message: `The browser is on, but asking for what it needs didn't start: ${refused.message}`,
        };
      }
    },
    ask,
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
