/**
 * What an agent holding control is told it can mount, as management gives it beside its own words
 * and skills: told in every request as its own section, `capabilities`, in the place control told
 * it. Nothing when none is on offer.
 */
import type { Context } from "cordis";
import type { Capability } from "../substrate.js";

/** The most characters of the list of what it can mount, told in every request. */
export const OFFERED_MAX = 4_000;

/** The `offered` capability, mounted with `{ text }`. */
export const offered = (): Capability<{ text?: unknown } | undefined> => ({
  name: "offered",
  title: "What it can mount",
  inject: ["prompt"],
  apply(ctx: Context, args) {
    const text = typeof args?.text === "string" && args.text ? args.text : undefined;
    ctx.prompt.section({ name: "capabilities", text: () => text, max: OFFERED_MAX });
  },
});
