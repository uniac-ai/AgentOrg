// The computer unit's form and what its answers give. The form is data, read by people and agents
// alike, so what each answer grants is said in its description. Which service it runs on is found
// when the form is read.
import type { Unit } from "@agentorg/interfaces";
import type { z } from "zod";

export const COMPUTER = "computer";
export const WEB = "web";
export const BROWSER_SLOT = "browser";
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
// views, in the order they are drawn. A computer with files has the `computer` connection, and so
// the `about` tool, which says how it is isolated; one with a browser alone has neither.
const LOAD = { surface: "load", protocol: "metrics@1" };
const FILES = { surface: "files", protocol: "files@1" };
const TERMINAL = { surface: "terminal", protocol: "terminal@1" };
const SCREEN = { surface: "browser", protocol: "screencast@1" };
/** The ids of the views whose rows `apply` gives. */
export const WHERE = "where";
export const WORKSPACE = "workspace";
const ISOLATION = {
  id: "isolation",
  place: "column",
  kind: "facts",
  when: "reachable" as const,
  operation: "about",
  slot: COMPUTER,
  rows: ["Isolation"],
};
const WITH_FILES = {
  slots: [{ name: COMPUTER }],
  skills: [skill("files"), skill("computer")],
  surfaces: [FILES],
  views: [ISOLATION],
};

export const LOCAL = "local";
export const ANOTHER = "another";
/** What to do when AgentComputer isn't installed here: the app doesn't include it. */
export const INSTALL_STEPS =
  "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.";

/**
 * How the service here isolates. With `starts`, none runs yet, and one with this isolation is
 * started when a computer is added. Undefined when none runs and AgentComputer isn't installed.
 */
export type Found = { isolation: "none" | "container"; starts?: true } | undefined;
/** What a computer here reaches is said in one place, for how the service here isolates. */
const localLine = (found: Found) =>
  !found
    ? INSTALL_STEPS
    : `On this computer, by AgentComputer${found.starts ? ", started when you add this computer" : ""}. ${
        found.isolation === "container"
          ? "Each agent's computer is a container of its own, and the only folder of yours in it is its workspace directory."
          : "No isolation: it acts as you, and with a terminal it reaches everything you can."
      }`;

/** The form as it stands now, with what was found on this machine. */
export const computerUnit = (found: Found): z.input<typeof Unit> => ({
  id: COMPUTER,
  title: "Computer",
  description: "A place for the agent to work: a folder, how far it can act on it, and a browser.",
  capability: { id: COMPUTER, title: "Computer" },
  once: true,
  form: [
    {
      id: "service",
      type: "choice",
      value: "string",
      title: "Where it resides",
      description: "Where its computer runs, and how that's kept apart from everything else.",
      // Not required: with none found, `check` says what to do, which is more than "fill this in".
      ...(found ? { default: LOCAL } : {}),
      options: [
        {
          value: LOCAL,
          title: "This computer",
          description: localLine(found),
          // The line warns of no isolation whenever it says so: not with a container or none installed.
          ...(found && found.isolation !== "container" ? { caution: true as const } : {}),
        },
        {
          value: ANOTHER,
          title: "Another address",
          description: "A service elsewhere. What a computer can reach depends on how it isolates.",
        },
      ],
    },
    {
      id: "address",
      type: "text",
      value: "string",
      title: "Address",
      description: "The service's address, over https unless it's on this computer.",
      required: true,
      visible: { field: "service", in: [ANOTHER] },
    },
    {
      id: "token",
      type: "secret",
      value: "secret",
      title: "Token",
      description:
        "The service's control token. It's asked each time and never saved in a template.",
      required: true,
      visible: { field: "service", in: [ANOTHER] },
    },
    {
      id: "workspace",
      type: "directory",
      value: "string",
      title: "Workspace directory",
      description:
        "The folder it works in, made if it's missing. Left empty, it's a folder with the agent's name in ~/Agents. Its file tools stay inside it. Removing the agent leaves it.",
      placeholder: "~/Agents/{name}",
      visible: { field: "service", in: [LOCAL] },
    },
    {
      id: "path",
      type: "text",
      value: "string",
      title: "Workspace directory",
      description: "A path on the service's machine. Removing the agent leaves it.",
      visible: { field: "service", in: [ANOTHER] },
    },
    {
      id: "access",
      authority: "setting",
      type: "choice",
      value: "string",
      title: "What it reaches",
      required: true,
      options: [
        {
          value: "none",
          title: "No files or terminal",
          description: "It has no files and can't run anything.",
        },
        {
          value: "read",
          title: REACHES.read,
          description:
            "It can read files in its workspace directory, but can't change them or run anything.",
          adds: WITH_FILES,
        },
        {
          value: "files",
          title: REACHES.files,
          description:
            "It can read and change files in its workspace directory, but can't run anything.",
          adds: WITH_FILES,
        },
        {
          value: "terminal",
          title: REACHES.terminal,
          description: "It can run any command. What that reaches depends on where it resides.",
          adds: {
            slots: [{ name: COMPUTER }],
            skills: [skill("terminal"), skill("files"), skill("computer")],
            surfaces: [TERMINAL, FILES],
            views: [ISOLATION],
          },
        },
      ],
    },
    {
      id: "browser",
      authority: "setting",
      type: "toggle",
      value: "boolean",
      title: "With a browser",
      description: "It can open web pages and act on them, in a browser of its own.",
      default: false,
      adds: { slots: [{ name: BROWSER_SLOT }], skills: [skill("browser")], surfaces: [SCREEN] },
    },
  ],
  needs: [],
  gives: {
    slots: [],
    skills: [],
    results: [],
    surfaces: [LOAD],
    views: [
      { id: WHERE, place: "column", kind: "facts" },
      { id: "load", place: "column", kind: "meters", when: "reachable", surface: "load" },
      { id: WORKSPACE, place: "column", kind: "facts" },
    ],
  },
});

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
  [COMPUTER]: ["terminal", "files", "computer", "browser"],
  [WEB]: ["web-research"],
};
