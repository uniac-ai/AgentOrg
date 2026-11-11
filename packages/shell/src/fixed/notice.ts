// What can be done about a chat's problem, where there is something: the control its agent's page
// offers for it, and the one a chat's own line ends with when it is the plan's page.
import { USAGE } from "../app.tsx";

/** The way out of a problem, by its code: the plan's page, or signing in. */
export function remedyOf(problem: {
  code: string;
}): { label: string; run: "manage" | "signIn" } | undefined {
  if (problem.code === "usage_limit") return { label: "Manage usage", run: "manage" };
  if (problem.code === "not_signed_in") return { label: "Continue with ChatGPT", run: "signIn" };
  return undefined;
}

/** Opens the plan's page, in a tab of its own. */
export const openUsage = () => void window.open(USAGE, "_blank", "noopener,noreferrer");
