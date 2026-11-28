/**
 * What writes a piece of work's summary once its earlier steps are past the budget: offered as
 * `summary`, which the engine reads each time a summary is due. Every agent holds this one, the
 * looper's own `summarize`, as its executor mounts it. Another capability may take it off, after
 * which what is over the budget is cut, and may then provide `summary` in its place; one that
 * provides it while another does isn't mounted.
 */
import { type Summarize, summarize } from "@agentorg/looper";
import type { Context } from "cordis";
import type { Capability } from "../substrate.js";

/**
 * What `summary` offers: what writes a work's summary, as the looper's `summarize` does, given the
 * work's own way to ask its model. Called on the service, as `ctx.summary.summarize(…)`.
 */
export interface Summarizer {
  summarize: Summarize;
}

declare module "cordis" {
  interface Context {
    summary: Summarizer;
  }
}

/** The `summary` capability, which every agent holds. */
export const summary = (): Capability => ({
  name: "summary",
  title: "Summary",
  inject: [],
  provide: "summary",
  apply(ctx: Context) {
    const service: Summarizer = { summarize };
    ctx.provide("summary", service);
  },
});
