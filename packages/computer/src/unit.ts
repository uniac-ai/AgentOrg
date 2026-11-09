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
const WITH_FILES = { slots: [{ name: COMPUTER }], skills: [skill("files"), skill("computer")] };

export const LOCAL = "local";
export const ANOTHER = "another";
/** What to do when there is no service here: the app never starts or ships one. */
export const INSTALL_STEPS =
  "No AgentComputer is running on this machine. Install it with `npm install -g @agentorg/computer`, start it with `agentcomputer serve`, and try again.";

/** How the service on this machine isolates its computers, if one is running. */
export type Found = { isolation: "none" | "container" } | undefined;
const localLine = (found: Found) =>
  !found
    ? INSTALL_STEPS
    : found.isolation === "container"
      ? "On this machine, started by you. Each computer is a container of its own."
      : "On this machine, started by you. No isolation: it acts as you, and with a terminal it reaches everything you can.";

/** The form as it stands now, with what was found on this machine. */
export const computerUnit = (found: Found): z.input<typeof Unit> => ({
  id: COMPUTER,
  title: "Computer",
  description: "A place for the agent to work: a folder, how far it can act on it, and a browser.",
  form: [
    {
      id: "service",
      type: "choice",
      value: "string",
      title: "Service",
      description: "Where its computer runs, and how that's kept apart from everything else.",
      required: true,
      options: [
        { value: LOCAL, title: "This machine", description: localLine(found) },
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
      description: "The service's address, over https unless it's on this machine.",
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
      id: "access",
      type: "choice",
      value: "string",
      title: "What it can do",
      required: true,
      options: [
        { value: "none", title: "Nothing", description: "It has no files and can't run anything." },
        {
          value: "read",
          title: "Read files",
          description:
            "It can read files in its working directory, but can't change them or run anything.",
          adds: WITH_FILES,
        },
        {
          value: "files",
          title: "Read and change files",
          description:
            "It can read and change files in its working directory, but can't run anything.",
          adds: WITH_FILES,
        },
        {
          value: "terminal",
          title: "Files and terminal",
          description: "It can run any command, so it can reach every file and program you can.",
          adds: {
            slots: [{ name: COMPUTER }],
            skills: [skill("terminal"), skill("files"), skill("computer")],
          },
        },
      ],
    },
    {
      id: "browser",
      type: "toggle",
      value: "boolean",
      title: "Browser",
      description: "It can open web pages and act on them, in a browser of its own.",
      default: false,
      adds: { slots: [{ name: BROWSER_SLOT }], skills: [skill("browser")] },
    },
    {
      id: "workspace",
      type: "directory",
      value: "string",
      title: "Working directory",
      description:
        "The folder it works in. Its file tools stay inside it by a check, not a sandbox. Removing the agent leaves it. With none, the service makes one, which goes with the computer.",
      visible: { field: "service", in: [LOCAL] },
    },
    {
      id: "path",
      type: "text",
      value: "string",
      title: "Working directory",
      description: "A path on the service's machine. Removing the agent leaves it.",
      visible: { field: "service", in: [ANOTHER] },
    },
  ],
  needs: [],
  gives: { slots: [], skills: [], results: [] },
});

export const WEB_UNIT: z.input<typeof Unit> = {
  id: WEB,
  title: "Web",
  description: "Search the web and read pages.",
  form: [
    {
      id: "service",
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
