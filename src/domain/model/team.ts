/** Organization identity, hierarchy and admitted connection presence. */
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Actor, Id } from "./records.ts";

export const TeamRequest = z
  .strictObject({
    actor: Id.optional().describe("The position to start from. Default: you."),
    depth: z.number().int().min(0).max(20).default(1).describe("Levels of reports to include."),
  })
  .meta({ id: "TeamRequest" });

export const Position = Actor.meta({
  id: "Position",
  description: "Identity, hierarchy and connection presence.",
});
export const Team = z.strictObject({ root: Id, positions: z.array(Position) }).meta({ id: "Team" });
export const TEAM = toolDefinition("team", {
  team: {
    writes: false,
    level: "team",
    request: TeamRequest,
    response: Team,
    description:
      "Read a position and its open reports: identity, purpose, hierarchy, timestamps and actual Hub connection presence. Anyone may explore any position. Default: you and your direct reports.",
  },
});
