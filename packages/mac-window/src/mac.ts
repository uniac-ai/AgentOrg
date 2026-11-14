// The seam between the window's page and the app under it. The page knows the app only through
// this interface. The app's implementation is Tauri commands, which hold the service's control
// token, so the page never sees it. The stand-in (stand-in.ts) answers in the same shapes.
// The service's parts are passed through as AgentComputer's openapi.yaml has them.

/** A part of this Mac an agent can use. */
export type Capability = "terminal" | "files" | "screen" | "browser";

/** What a part needs: the screen's driver and its two grants, or each browser. */
export type NeedName =
  | "install"
  | "screen-recording"
  | "accessibility"
  | "chrome"
  | "edge"
  | "named";
export type NeedState = "missing" | "granted" | "not-granted" | "unknown" | "on" | "off";
export interface Need {
  need: NeedName;
  /** A browser's name: Chrome, Edge, or the one browser named. */
  name?: string;
  /** For a grant, whose it is, as System Settings lists it. */
  holder?: string;
  state: NeedState;
}

/** `GET /v1/setup`: each part, the person's switch, whether it has all it needs, and each need. */
export interface Setup {
  capabilities: { capability: Capability; on: boolean; ready: boolean; needs: Need[] }[];
}

/** `GET /v1/connection`: whether AgentOrg holds a connection, and since when. */
export interface Connection {
  connected: boolean;
  clients: { name: string; since: string; local: boolean }[];
}

/** `GET /v1/acting`: one who acted on a part in the last few seconds, the most recent first. */
export interface Acting {
  who: "person" | "agent";
  name?: string;
  capability: Capability;
  terminal?: string;
  at: string;
}

/** `GET /v1/computers`, those running or starting: a computer lent to now, as the service lists
 * it, the newest first. Only what the page reads is named here; `metadata.agent` is the agent's
 * id. */
export interface Computer {
  name: string;
  startedAt?: string | null;
  metadata?: { agent?: string };
}

/** The app's own state: starting, running, or bringing the driver or the service back. */
export type AppState = "starting" | "running" | "starting again";

/** The service's `Error`, as a part rejects with it: 409 where it refuses, with words for the
 * person; 503 while the service isn't there to answer. */
export interface Refusal {
  code: number;
  message: string;
}
/** A refusal with words for the card's line: a 409. */
export const isRefusal = (error: unknown): error is Refusal =>
  typeof error === "object" &&
  error !== null &&
  (error as Refusal).code === 409 &&
  typeof (error as Refusal).message === "string";

export interface Mac {
  /** Each part, read afresh. */
  setup(): Promise<Setup>;
  /** A card's switch. Turning it on also asks for what it is missing; a 409 rejects with a Refusal. */
  setSwitch(capability: Capability, on: boolean): Promise<Setup>;
  /** A row's Grant or Set up: ask for one need, or with none for all it misses. 409: a Refusal. */
  ask(capability: Capability, need?: NeedName): Promise<Setup>;
  connection(): Promise<Connection>;
  /** The computers this Mac is lent to now. */
  computers(): Promise<Computer[]>;
  acting(): Promise<Acting[]>;
  appState(): Promise<AppState>;
  /** Called when the app's state changes; returns the way to stop listening. */
  onChanged(listener: () => void): () => void;
  /** The page's height, so the window fits it, as the design's does. */
  fit(height: number): void;
}
