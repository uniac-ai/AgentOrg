// The computer unit's form and what its answers give. The form is data, read by people and agents
// alike, so what each answer grants is said in its description.
import type { Unit } from "@agentorg/interfaces";
import type { z } from "zod";

export const UNIT_ID = "computer";
export const SLOT = "computer";
const SKILL = "SKILL.md";
const skill = (name: string) => ({ name, files: [SKILL] });

export type Access = "read" | "files" | "terminal";
const WITH_FILES = { slots: [{ name: SLOT }], skills: [skill("files"), skill("computer")] };

export const COMPUTER_UNIT: z.input<typeof Unit> = {
  id: UNIT_ID,
  title: "Computer",
  description: "A place for the agent to work: a folder, and how far it can act on it.",
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
            slots: [{ name: SLOT }],
            skills: [skill("terminal"), skill("files"), skill("computer")],
          },
        },
      ],
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

/** The skills the unit can give, by name. */
export const SKILLS = ["terminal", "files", "computer"];
