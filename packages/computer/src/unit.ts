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
        { value: "local", title: "This computer", description: "It acts as you on this computer." },
      ],
    },
    {
      id: "access",
      type: "choice",
      value: "string",
      title: "What it can do",
      required: true,
      options: [
        { value: "none", title: "Nothing", description: "No files and no commands." },
        {
          value: "read",
          title: "Read files",
          description:
            "Reads files in the working directory. Cannot change them or run anything. Kept to that folder by a check, not a sandbox.",
          adds: WITH_FILES,
        },
        {
          value: "files",
          title: "Read and change files",
          description:
            "Reads and changes files in the working directory. Cannot run anything. Kept to that folder by a check, not a sandbox.",
          adds: WITH_FILES,
        },
        {
          value: "terminal",
          title: "Files and terminal",
          description: "Runs any command, so it reaches every file and program you can.",
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
      description: "The folder it works in. Removing the agent never deletes it.",
      required: true,
      visible: { field: "access", in: ["read", "files", "terminal"] },
    },
  ],
  needs: [],
  gives: { slots: [], skills: [], results: [] },
};

/** The skills the unit can give, by name. */
export const SKILLS = ["terminal", "files", "computer"];
