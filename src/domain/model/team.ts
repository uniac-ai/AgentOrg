/** Organization identity, hierarchy, presence and each Actor's report. */
import { Form, Work } from "@uniac/agentic-workspace/contracts";
import { z } from "zod";
import { toolDefinition } from "./json-schema.ts";
import { Actor, Count, Id, Timestamp } from "./records.ts";

export const TeamRequest = z
  .strictObject({
    actor: Id.optional().describe("The position to start from. Default: you."),
    depth: z.number().int().min(0).max(20).default(1).describe("Levels of reports to include."),
  })
  .meta({ id: "TeamRequest" });

export const PositionState = z
  .enum(["waiting", "review", "active", "idle"])
  .describe(
    "The most urgent among the Work on it: waiting (its owner's open ask on Work not submitted), then review (submitted), then active; idle with none. A stored blocked reads as active.",
  );

const LastActiveAt = Timestamp.nullable().describe("The time of its last recorded write.");

export const Headline = z
  .strictObject({
    subject: z
      .strictObject({ ticketID: Id, title: z.string(), state: PositionState.exclude(["idle"]) })
      .nullable()
      .describe(
        "The most urgent Work on it that is waiting, in review or active: waiting, review, active with changes requested, then active; ties to the latest update. Null with none.",
      ),
    clause: z
      .strictObject({
        kind: z.enum(["ask", "approval", "review", "waits", "step"]),
        text: z.string(),
      })
      .nullable()
      .describe(
        'The first that applies to the subject: its owner\'s oldest open ask on it, by title, as ask or approval; "with <X> for review", X being its requester or, once that is closed, its nearest open manager; what it waits on; its current step, else the first sentence of its progress. The caller is "you".',
      ),
    more: Count.describe("Its other Work that is waiting, in review or active."),
    notStarted: Count.describe("Open Work on it with no open ask by its owner."),
    finished: z
      .strictObject({ ticketID: Id, title: z.string(), at: Timestamp })
      .nullable()
      .describe("The last Work it finished."),
  })
  .meta({
    id: "Headline",
    description:
      "An Actor's line: the subject's title, its clause and +N for the rest. With no subject: N not started, else the last finished Work and when.",
  });

export const Position = Actor.extend({
  state: PositionState,
  headline: Headline,
  asks: Count.describe("Its own open asks."),
  branchAsks: Count.describe("Open asks of every Actor below it, closed ones included."),
  lastActiveAt: LastActiveAt,
}).meta({
  id: "Position",
  description:
    "Identity, hierarchy and connection presence, with its state and headline from the Work on it.",
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
    answeredBy: Id.optional().describe(
      "Also return its asks, open or closed, that this Actor answered, on any Work.",
    ),
  })
  .meta({ id: "ActorViewRequest" });

export const ActorView = z
  .strictObject({
    actor: z.strictObject({
      actorID: Id,
      name: z.string(),
      path: z.string(),
      purpose: z.string(),
      managerID: Actor.shape.manager,
      online: z.boolean(),
      lastActiveAt: LastActiveAt,
      closed_at: Actor.shape.closed_at,
    }),
    state: PositionState,
    headline: Headline,
    workstreams: z
      .array(Work.extend({ asks: z.array(Form).describe("The open asks on this Work.") }))
      .describe("Work on it that is waiting, in review or active, oldest first."),
    asks: z
      .array(Form)
      .describe("Its own open asks, wherever they are: on its Work, on other Work, or on none."),
    needs: z
      .array(Form)
      .describe(
        "Open asks routed to it: its reports' asks it hasn't raised, asks raised to it, and asks passed up past closed managers.",
      ),
    reviews: z
      .array(Work)
      .describe(
        "Submitted Work routed to it: Work it requested, or a closed Actor requested whom it stands in for.",
      ),
    assigned: z
      .array(Work)
      .describe("Work on it that others requested, not started or with changes requested."),
    ownerClosed: z
      .array(Work)
      .describe(
        "Unfinished, unsubmitted Work routed to it as requester whose owner is closed, to reassign or cancel.",
      ),
    answered: z
      .array(Form)
      .optional()
      .describe("With answeredBy: its asks, open or closed, that Actor answered."),
    followUps: z.array(Work).describe("Open Work it requested of itself."),
    completed: z.array(Work).describe("Accepted Work it owns, newest first."),
    reports: z.array(Actor).describe("Its open direct reports."),
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
      "Read a position and its open reports: identity, purpose, hierarchy, timestamps, actual Hub connection presence, its last write, its own and its branch's open asks, and from the Work on it its state and headline. Anyone may explore any position. Default: you and your direct reports.",
  },
  actor_view: {
    writes: false,
    level: "team",
    request: ActorViewRequest,
    response: ActorView,
    description:
      "Read an Actor's report as one view, computed now: its state and headline, the Work on it with its open asks, its own open asks, the asks routed to it, the submissions it answers, the Work it must take up or hand on, its follow-ups, recent completions and direct reports. Anyone may view any Actor. Default: you.",
  },
});
