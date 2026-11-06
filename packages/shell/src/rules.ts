import type { View } from "./api.ts";
import { api } from "./data.ts";

/** One placement of the person's `layout@1`. */
export interface Placement {
  id: string;
  actor: string;
  module: string;
  title?: string;
  /** The Actor that placed it, when the layout records one. */
  by?: string;
}

/**
 * The placements shown beside an agent's chat, in layout order: its own views other than the chat
 * itself, and whatever it placed. The one place this is decided.
 */
export function besideAgent(home: readonly Placement[], agent: string): Placement[] {
  return home.filter(
    (placement) =>
      (placement.actor === agent && placement.module !== "chat") || placement.by === agent,
  );
}

/** A view's log line, for its Actor's log, through the gateway (`hub.actors.logs` reads it). */
export function viewLog(
  view: View,
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) {
  api.log(view, level, message, fields);
}
