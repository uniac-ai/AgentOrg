// Where an agent's work stands, as one word: its status once a session reports one, else its
// lifecycle. Every mark, count and roll-up in the app uses these words.

import type { AgentRecord } from "../../../src/page/types.ts";

/** In display order: work moving, work waiting, then agents not yet started, idle or done. */
export const PROGRESS_STATES = [
  "running",
  "review",
  "waiting",
  "blocked",
  "pending",
  "idle",
  "closed",
] as const;

export type ProgressState = (typeof PROGRESS_STATES)[number];

export function progressState(agent: AgentRecord): ProgressState {
  if (agent.state !== "active") return agent.state;
  return agent.status?.state ?? "idle";
}
