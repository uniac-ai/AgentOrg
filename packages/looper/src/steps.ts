/**
 * A worker's steps: a short checklist of its piece of work, kept with the work apart from what it
 * did. The worker keeps it with the looper's `status`, which sets the list, or moves
 * through it a step at a time or by number.
 */
import { z } from "zod";
import { head, Refusal } from "./types.js";

/** A list holds at most this many steps. */
export const MOST_STEPS = 8;
/** A step's text, and its words while in progress, keep this many characters. */
export const STEP_CHARS = 200;

/** A step: what it is, its words while it is in progress, and where it stands. */
export const Step = z.object({
  text: z.string(),
  active: z.string().optional(),
  state: z.enum(["pending", "in_progress", "completed"]),
});
export type Step = z.output<typeof Step>;

/** What the worker is told of its steps: one line each, with its number, its state and its text. */
export const listOf = (steps: readonly Step[]) =>
  steps.length === 0
    ? "No steps."
    : steps.map((step, i) => `${i + 1}. ${step.state}: ${step.text}`).join("\n");

/** The words of the step in progress: its `active` words, or its text; none when no step is. */
export const stepWords = (steps: readonly Step[]) => {
  const running = steps.find((step) => step.state === "in_progress");
  return running && (running.active ?? running.text);
};

function refuse(message: string): never {
  throw new Refusal("invalid", message);
}

/** A new list, as `status` is given it: each step pending unless it says otherwise. */
function listed(given: unknown): Step[] {
  if (!Array.isArray(given)) refuse('Give `steps` as a list, like [{"text": "Compare prices"}].');
  if (given.length > MOST_STEPS)
    refuse(`At most ${MOST_STEPS} steps: this list has ${given.length}.`);
  const steps = given.map((one): Step => {
    const { text, active, state } = (one ?? {}) as Record<string, unknown>;
    if (typeof text !== "string" || text.trim() === "")
      refuse("Each step needs its text: words saying what it is.");
    const known = Step.shape.state.safeParse(state ?? "pending");
    if (!known.success) refuse("A step's state is pending, in_progress or completed.");
    const words = typeof active === "string" && active.trim() !== "" ? active.trim() : undefined;
    return {
      text: head(text.trim(), STEP_CHARS),
      ...(words === undefined ? {} : { active: head(words, STEP_CHARS) }),
      state: known.data,
    };
  });
  if (steps.filter((step) => step.state === "in_progress").length > 1)
    refuse("At most one step may be in progress.");
  return steps;
}

/**
 * The steps after a `status` call given `input`, from `steps`: a new list, or the list moved on.
 * `advance` completes the step in progress and starts the next pending one, after it or else the
 * first; `done` completes steps by number, then `start` starts one. A call that breaks a rule is
 * refused, with the rule in plain words.
 */
export function stepped(steps: readonly Step[], input: unknown): Step[] {
  // A field that is null is taken as absent.
  const {
    steps: given,
    advance,
    done,
    start,
  } = Object.fromEntries(
    Object.entries((input ?? {}) as Record<string, unknown>).filter(([, value]) => value !== null),
  );
  const moves = advance === true || done !== undefined || start !== undefined;
  if (given !== undefined && moves)
    refuse(
      "Set the list with `steps`, or move through it with `advance`, `done` or `start`: not both in one call.",
    );
  if (given !== undefined) return listed(given);
  if (!moves)
    refuse(
      "Give `steps` to set the list, `advance` to go to the next step, or `done` and `start` by number.",
    );
  if (advance === true && (done !== undefined || start !== undefined))
    refuse("Use `advance` alone, or `done` and `start`: not both in one call.");
  if (steps.length === 0) refuse("There are no steps yet: set them with `steps` first.");
  const next = steps.map((step) => ({ ...step }));
  const at = (index: number) => next[index] as Step;
  if (advance === true) {
    const running = next.findIndex((step) => step.state === "in_progress");
    if (running !== -1) at(running).state = "completed";
    const after = next.findIndex((step, i) => i > running && step.state === "pending");
    const pending = after !== -1 ? after : next.findIndex((step) => step.state === "pending");
    if (pending !== -1) at(pending).state = "in_progress";
    return next;
  }
  const index = (position: unknown) => {
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > next.length
    )
      refuse(
        `There is no step ${head(String(JSON.stringify(position)), 20)}: the steps are numbered 1 to ${next.length}.`,
      );
    return position - 1;
  };
  for (const position of done === undefined ? [] : [done].flat())
    at(index(position)).state = "completed";
  if (start !== undefined) {
    const starting = index(start);
    const running = next.findIndex((step) => step.state === "in_progress");
    if (running !== -1 && running !== starting)
      refuse(`Step ${running + 1} is in progress: complete it with \`done\` in the same call.`);
    at(starting).state = "in_progress";
  }
  return next;
}
