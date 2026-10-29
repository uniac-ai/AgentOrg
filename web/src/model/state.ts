// Where an actor's work stands, as one word: its progress state once it publishes one, else idle,
// and closed once its manager closes it. An item's state reads the same way, a planned one as
// idle. Every mark, count and roll-up in the app uses these words.

import type { ItemRecord, PositionRecord } from "../../../src/clients/web/types.ts";

/** In display order: work moving, work waiting, then actors idle or done. */
export const PROGRESS_STATES = [
  "running",
  "review",
  "waiting",
  "blocked",
  "idle",
  "closed",
] as const;

export type ProgressState = (typeof PROGRESS_STATES)[number];

export function progressState(
  position: Pick<PositionRecord, "closed_at" | "progress">,
): ProgressState {
  if (position.closed_at !== null) return "closed";
  return position.progress?.state ?? "idle";
}

export const itemState = (item: ItemRecord): ProgressState =>
  item.state === "planned" ? "idle" : item.state;
