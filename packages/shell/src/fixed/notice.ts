// What can be done about a chat's problem, where there is something: the control an agent's page
// offers for it.

/** The way out of a problem, by its code: the plan's page, or signing in. */
export function remedyOf(problem: {
  code: string;
}): { label: string; run: "manage" | "signIn" } | undefined {
  if (problem.code === "usage_limit") return { label: "Manage usage", run: "manage" };
  if (problem.code === "not_signed_in") return { label: "Continue with ChatGPT", run: "signIn" };
  return undefined;
}
