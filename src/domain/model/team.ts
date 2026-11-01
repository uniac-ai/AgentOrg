/** Organization identity, hierarchy, presence and each Actor's report. */
import { Form, Status, Work } from "@uniac/agentic-workspace/contracts";
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Actor, Id, Timestamp } from "./records.ts";

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

export const ActorViewRequest = z
  .strictObject({
    actorID: Id.optional().describe("The Actor to view. Default: you."),
    completed: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(5)
      .describe("How many completed Work to include."),
  })
  .meta({ id: "ActorViewRequest" });

export const ActorState = z
  .enum(["blocked", "waiting", "review", "active", "idle"])
  .describe(
    "The most urgent among its workstreams: blocked, then waiting (active with an open ask), then review (submitted), then active; idle with none.",
  );

export const ActorView = z
  .strictObject({
    actor: z.strictObject({
      actorID: Id,
      name: z.string(),
      path: z.string(),
      purpose: z.string(),
      online: z.boolean(),
      lastActiveAt: Timestamp.nullable().describe("The time of its last recorded write."),
    }),
    state: ActorState,
    status: Status.nullable().describe("Null until it first sets one."),
    workstreams: z
      .array(Work.extend({ asks: z.array(Form).describe("Its open asks linked to this Work.") }))
      .describe(
        "Work it owns that is active, blocked, submitted or has changes requested, and such Work it requested of its direct reports, oldest first.",
      ),
    asks: z.array(Form).describe("Its open asks linked to none of its workstreams."),
    needs: z.array(Form).describe("Open asks of its direct reports."),
    reviews: z.array(Work).describe("Submitted Work it requested, waiting for its review."),
    assigned: z.array(Work).describe("Open Work others requested of it, not started."),
    followUps: z.array(Work).describe("Open Work it requested of itself."),
    completed: z.array(Work).describe("Accepted Work it owns, newest first."),
    reports: z.array(Position).describe("Its open direct reports."),
    actors: z
      .record(z.string(), z.strictObject({ name: z.string() }))
      .describe("Names of the Actors these records mention."),
  })
  .meta({ id: "ActorView" });
export const TEAM = toolDefinition("team", {
  team: {
    writes: false,
    level: "team",
    request: TeamRequest,
    response: Team,
    description:
      "Read a position and its open reports: identity, purpose, hierarchy, timestamps and actual Hub connection presence. Anyone may explore any position. Default: you and your direct reports.",
  },
  actor_view: {
    writes: false,
    level: "team",
    request: ActorViewRequest,
    response: ActorView,
    description:
      "Read an Actor's report as one view, computed now: its derived state and status, its workstreams with their open asks, its other open asks, its reports' open asks, reviews due, assigned and follow-up Work, recent completions and its direct reports. Anyone may view any Actor. Default: you.",
  },
});
