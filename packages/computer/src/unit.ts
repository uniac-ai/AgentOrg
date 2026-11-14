// The computer unit's form and what its answers give. The form is data, read by people and agents
// alike, so what each answer grants is said in its description. Which service it runs on is found
// when the form is read.
import type { Unit } from "@agentorg/interfaces";
import type { z } from "zod";

export const COMPUTER = "computer";
export const WEB = "web";
export const BROWSER_SLOT = "browser";
/** The slot of this computer's screen, through its own endpoint. */
export const SCREEN_SLOT = "screen";
const SKILL = "SKILL.md";
const skill = (name: string) => ({ name, files: [SKILL] });

export type Access = "read" | "files" | "terminal";
/** What a computer reaches at each level: the answer's title, and what the person reads of it. */
export const REACHES: Record<Access, string> = {
  read: "Read-only files",
  files: "Files",
  terminal: "Files and terminal",
};

// What the computer gives the person's side: its live surfaces, by the service's names, and its
// views, in the order they are drawn. Their rows are given when it is made: what it is, and what
// it reaches.
const LOAD = { surface: "load", protocol: "metrics@1" };
const FILES = { surface: "files", protocol: "files@1" };
const TERMINAL = { surface: "terminal", protocol: "terminal@1" };
const SCREENCAST = { surface: "browser", protocol: "screencast@1" };
/** This computer's screen, live. */
const SCREEN = { surface: "screen", protocol: "screen@1" };
/** Who is acting on it now, the person and agents, by what: from a service that says. */
const PRESENCE = { surface: "presence", protocol: "presence@1" };
/** The ids of the views whose rows `apply` gives. */
export const WHERE = "where";
export const WORKSPACE = "workspace";
const WITH_FILES = {
  slots: [{ name: COMPUTER }],
  skills: [skill("files"), skill("computer")],
  surfaces: [FILES],
};

/** Which computer: this one, whole, or one made for the agent. */
export const THIS = "this";
export const NEW = "new";
/** How a new one is made: a container here, or by a service at another address. */
export const CONTAINER = "container";
export const REMOTE = "remote";
/**
 * Where AgentOrg Mac keeps its computer service's record on a Mac, under the person's home: the
 * service's own `server.json` and `control-token`. The folder is made when the app first opens.
 */
export const MAC_RECORD = ["Library", "Application Support", "AgentOrg", "computer"];
/**
 * AgentOrg Mac as the person reads it: the app is AgentOrg.app, called "the AgentOrg app" so it
 * isn't taken for the AgentOrg they are using. Its name changes here alone.
 */
export const MAC_APP = "the AgentOrg app";
/** `MAC_APP` at the start of a sentence. */
const MacApp = MAC_APP.charAt(0).toUpperCase() + MAC_APP.slice(1);
/** What to do when AgentOrg Mac is on this Mac but isn't running: nothing starts it but the person. */
export const OPEN_MAC = `${MacApp} isn't open on this Mac. Open it to use this computer.`;
/** What to do when AgentOrg Mac's service is older than this build. */
export const UPDATE_MAC = `${MacApp} on this Mac is older than this AgentOrg. Update it, and open it again.`;
/** Why a part of this computer can't be had while the person has it off in AgentOrg Mac. */
const OFF_MAC = {
  files: `Files are turned off in ${MAC_APP}. Turn them on there to use this computer.`,
  screen: `Screen is turned off in ${MAC_APP}. Turn it on there to choose it.`,
  browser: `Your browser is turned off in ${MAC_APP}. Turn it on there to choose it.`,
};
/** Why no container is made here, where AgentOrg Mac makes none. */
export const NO_CONTAINER_MAC = `${MacApp} makes no container. To use a computer you run yourself, give its address.`;
/** What to do when AgentComputer isn't installed here: the app doesn't include it. */
export const INSTALL_STEPS =
  "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.";

/**
 * What the service here can make now, each kind ready or with why not, as it says. With `starts`,
 * none runs yet: one is started when a computer is added, and what it can make is found then.
 * With `why`, nothing of this machine can be had, and that says why. With `mac`, AgentOrg Mac is
 * this machine's provider: it lends this computer and makes nothing here. Undefined when none runs
 * and AgentComputer isn't installed.
 */
export type Found =
  | {
      thisComputer?: {
        ready: boolean;
        reason?: string;
        /** Each part of it, ready or not: one the person switched off isn't, and says so. */
        capabilities?: { capability: string; ready: boolean; reason?: string }[];
        /** The browsers that can go with it, the person's own (`own`) among them. */
        browsers?: { kind: string; ready: boolean; reason?: string }[];
      };
      /** On a Mac with AgentOrg Mac, the parts of this machine the person has switched off. */
      off?: string[];
      made: { isolation: string; ready: boolean; reason?: string }[];
      starts?: true;
      why?: string;
      mac?: true;
    }
  | undefined;
/** Why a computer on this machine can't be had now, if it can't. */
const notHere = (found: Found, kind: typeof THIS | typeof CONTAINER) => {
  if (!found) return INSTALL_STEPS;
  if (found.why) return found.why;
  if (found.starts) return undefined;
  if (kind === THIS) {
    if (found.thisComputer?.ready === false)
      return found.thisComputer.reason ?? "The provider here can't attach this computer now.";
    // Every reach it is offered with works in its files: with those off, none does.
    return partOff(found, "files");
  }
  const container = found.made.find((one) => one.isolation === CONTAINER);
  return !container
    ? "The provider here can't make containers."
    : container.ready
      ? undefined
      : (container.reason ?? "The provider here can't make a container now.");
};
const unavailable = (why: string | undefined) => (why ? { unavailable: why } : {});
/**
 * Why a part of this computer can't be had now: switched off in AgentOrg Mac, in its words; else
 * as its service says, such as what to install or allow. Nothing where the service says nothing of
 * the part's readiness, as an older one doesn't of a switch. Its terminal is its service's to
 * refuse to the agent while it is off: the person may turn it on later.
 */
const partOff = (found: Found, part: keyof typeof OFF_MAC) => {
  const offered = found?.thisComputer;
  if (!offered) return undefined;
  const one =
    part === "browser"
      ? offered.browsers?.find((each) => each.kind === "own")
      : offered.capabilities?.find((each) => each.capability === part);
  // A service that says what it offers, and doesn't offer this, is older than this AgentOrg.
  if (!one) {
    const listed = part === "browser" ? offered.browsers : offered.capabilities;
    if (!listed || part === "files") return undefined;
    return found?.mac
      ? UPDATE_MAC
      : part === "browser"
        ? "The provider here can't reach your own browser."
        : "The provider here can't give its screen.";
  }
  if (one.ready) return undefined;
  return found?.mac && found.off?.includes(part)
    ? OFF_MAC[part]
    : (one.reason ?? `This computer's ${part} can't be used now.`);
};

/** The form as it stands now, with what was found on this machine. */
export const computerUnit = (found: Found): z.input<typeof Unit> => {
  const screenOff = partOff(found, "screen");
  const ownOff = partOff(found, "browser");
  return {
    id: COMPUTER,
    title: "Computer",
    description: "Where it runs commands, keeps files and acts on a screen.",
    capability: { id: COMPUTER, title: "Computer" },
    once: true,
    form: [
      {
        id: "kind",
        type: "choice",
        value: "string",
        title: "Which computer",
        required: true,
        options: [
          {
            value: THIS,
            title: "This computer",
            description:
              "The whole machine: your files, apps, screen and signed-in browser. It acts as you, with everything you can reach.",
            caution: true,
            ...unavailable(notHere(found, THIS)),
          },
          {
            value: NEW,
            title: "A new computer",
            description: "Made for this agent and kept apart from yours.",
          },
        ],
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Where its work happens",
        description: "It's told to work here. Not a wall: the rest of your computer is open to it.",
        placeholder: "~/Agents/{name}",
        visible: { field: "kind", in: [THIS] },
      },
      {
        id: "made",
        type: "choice",
        value: "string",
        title: "Made as",
        required: true,
        // AgentOrg Mac makes nothing: a service you run is reached at its address, this Mac's too.
        default: found?.mac ? REMOTE : CONTAINER,
        visible: { field: "kind", in: [NEW] },
        options: [
          ...(found?.mac
            ? []
            : [
                {
                  value: CONTAINER,
                  title: "A container on this machine",
                  description: "Commands and files, apart from yours.",
                  ...unavailable(notHere(found, CONTAINER)),
                },
              ]),
          {
            value: REMOTE,
            title: "At another address",
            description: "A computer provider there makes it.",
          },
        ],
      },
      {
        id: "address",
        type: "text",
        value: "string",
        title: "Provider's address",
        description: "Over https unless it's on this computer.",
        required: true,
        visible: { field: "made", in: [REMOTE] },
      },
      {
        id: "token",
        type: "secret",
        value: "secret",
        title: "Token",
        description:
          "The provider's control token. It's asked each time and never saved in a template.",
        required: true,
        visible: { field: "made", in: [REMOTE] },
      },
      {
        id: "path",
        type: "text",
        value: "string",
        title: "Workspace directory",
        description: "A path on the provider's machine. Removing the agent leaves it.",
        visible: { field: "made", in: [REMOTE] },
      },
      {
        id: "access",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "What it reaches",
        required: true,
        default: "terminal",
        options: [
          {
            value: "terminal",
            title: REACHES.terminal,
            description: "It can run any command.",
            adds: {
              slots: [{ name: COMPUTER }],
              skills: [skill("terminal"), skill("files"), skill("computer")],
              surfaces: [TERMINAL, FILES],
            },
          },
          {
            value: "files",
            title: REACHES.files,
            description: "It can read and change files, but can't run anything.",
            adds: WITH_FILES,
          },
          {
            value: "read",
            title: REACHES.read,
            description: "It can read files, but can't change them or run anything.",
            adds: WITH_FILES,
          },
          {
            value: "none",
            title: "No files or terminal",
            description: "It has no files and can't run anything.",
          },
        ],
      },
      {
        id: "screen",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Screen",
        required: true,
        // On while it can be had: one greyed isn't left chosen.
        default: screenOff || !found?.thisComputer ? "off" : "on",
        visible: { field: "kind", in: [THIS] },
        options: [
          {
            value: "on",
            title: "Your screen",
            description: "It sees your screen and acts on it, as you would.",
            ...unavailable(screenOff),
            adds: { slots: [{ name: SCREEN_SLOT }], skills: [skill("screen")], surfaces: [SCREEN] },
          },
          { value: "off", title: "No screen" },
        ],
      },
      {
        id: "ownBrowser",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Browser",
        required: true,
        default: ownOff || !found?.thisComputer ? "none" : "yours",
        visible: { field: "kind", in: [THIS] },
        options: [
          {
            value: "yours",
            title: "Your browser",
            description: "Signed in as you: it acts as you on every site you're signed in to.",
            caution: true,
            ...unavailable(ownOff),
            adds: {
              slots: [{ name: BROWSER_SLOT }],
              skills: [skill("browser")],
              surfaces: [SCREENCAST],
            },
          },
          { value: "none", title: "No browser" },
        ],
      },
      {
        id: "browser",
        authority: "setting",
        type: "toggle",
        value: "boolean",
        title: "With a browser",
        description: "It can open web pages and act on them, in a browser of its own.",
        default: true,
        visible: { field: "kind", in: [NEW] },
        adds: {
          slots: [{ name: BROWSER_SLOT }],
          skills: [skill("browser")],
          surfaces: [SCREENCAST],
        },
      },
    ],
    needs: [],
    gives: {
      slots: [],
      skills: [],
      results: [],
      surfaces: [LOAD, PRESENCE],
      views: [
        { id: WHERE, place: "column", kind: "facts" },
        { id: "load", place: "column", kind: "meters", when: "reachable", surface: "load" },
        { id: WORKSPACE, place: "column", kind: "facts" },
        { id: "in-use", place: "column", kind: "presence", when: "reachable", surface: "presence" },
      ],
    },
  };
};

export const WEB_UNIT: z.input<typeof Unit> = {
  id: WEB,
  title: "Web search",
  description: "Search the web and read pages.",
  once: true,
  form: [
    {
      id: "service",
      authority: "setting",
      type: "choice",
      value: "string",
      title: "Service",
      required: true,
      default: "exa",
      options: [
        {
          value: "exa",
          title: "Exa",
          description: "It searches and reads pages through Exa, which sees what it looks for.",
        },
      ],
    },
  ],
  needs: [],
  gives: { slots: [{ name: WEB }], skills: [skill("web-research")], results: [] },
};

/** The skills each unit can give, by name. */
export const SKILLS: Record<string, string[]> = {
  [COMPUTER]: ["terminal", "files", "computer", "browser", "screen"],
  [WEB]: ["web-research"],
};
