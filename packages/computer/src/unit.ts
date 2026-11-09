// The computer unit's form and what its answers give. The form is data, read by people and agents
// alike, so what each answer grants is said in its description.
import type { Unit } from "@agentorg/interfaces";
import type { z } from "zod";

export const COMPUTER = "computer";
export const WEB = "web";
export const BROWSER_SLOT = "browser";
const SKILL = "SKILL.md";
const skill = (name: string) => ({ name, files: [SKILL] });

export type Access = "read" | "files" | "terminal";
const WITH_FILES = { slots: [{ name: COMPUTER }], skills: [skill("files"), skill("computer")] };

export const COMPUTER_UNIT: z.input<typeof Unit> = {
  id: COMPUTER,
  title: "Computer",
  description: "A place for the agent to work: a folder, how far it can act on it, and a browser.",
  form: [
    {
      id: "where",
      type: "choice",
      value: "string",
      title: "Where it runs",
      required: true,
      options: [
        {
          value: "local",
          title: "This computer",
          description: "It runs on this computer, as you.",
        },
      ],
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
        "The folder it works in. Its file tools stay inside it by a check, not a sandbox. Removing the agent never deletes it.",
      visible: { field: "where", in: ["local"] },
    },
    {
      id: "containerPath",
      type: "text",
      value: "string",
      title: "Working directory",
      description: "A path inside the container.",
      visible: { field: "where", in: ["container"] },
    },
  ],
  needs: [],
  gives: { slots: [], skills: [], results: [] },
};

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
