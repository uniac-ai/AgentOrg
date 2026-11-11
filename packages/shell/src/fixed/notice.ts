// What a chat's own line ends with when its problem is one the plan's page can fix.
import { USAGE } from "../app.tsx";

/** The way out of a problem, where the plan's page is one: for the plan's limit. */
export const fixOf = (problem: { code: string }) =>
  problem.code === "usage_limit"
    ? { label: "Manage usage", run: () => void window.open(USAGE, "_blank", "noopener,noreferrer") }
    : undefined;
