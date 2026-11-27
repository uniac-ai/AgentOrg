/**
 * What writes a piece of work's summary once its earlier steps are past the budget: offered as
 * `summary`, which the engine reads each time a summary is due. Every agent holds this one,
 * `summarize`, as its executor mounts it. Another capability may take it off, after which what is
 * over the budget is cut, and may then provide `summary` in its place; one that provides it while
 * another does isn't mounted.
 */
import type { Summarizer } from "@agentorg/looper";
import type { Context } from "cordis";
import { summarize } from "./summarize.js";

export { summarize } from "./summarize.js";

declare module "cordis" {
  interface Context {
    summary: Summarizer;
  }
}

/**
 * The `summary` capability, in the shape an agent's executor mounts a capability: its name and
 * title, the services it injects and provides, and its mount, `apply`. The executor takes it by
 * that shape, so this package takes nothing of the executor.
 */
export interface Summary {
  name: "summary";
  title: string;
  inject: string[];
  provide: "summary";
  apply(ctx: Context): void;
}

/** The `summary` capability, which every agent holds. */
export const summary = (): Summary => ({
  name: "summary",
  title: "Summary",
  inject: [],
  provide: "summary",
  apply(ctx: Context) {
    const service: Summarizer = { summarize };
    ctx.provide("summary", service);
  },
});
