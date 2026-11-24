// The ring the row of avatars goes round: what a place in it holds, and which places come round to
// the far side as the choice moves.
import { avatarFromSeed, toSvg } from "@agentorg/2dlivebot";
import { freshName } from "./names.ts";

/** An avatar, as its string, and the name it comes with. */
export interface Pair {
  avatar: string;
  name: string;
  /** Its still picture, as an image's address: drawn once, when the pair is made. */
  still: string;
}

/** How many the row keeps. */
export const KEPT = 20;

const randomSeed = () =>
  [...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("");

/** A random avatar, with a name that nothing in `taken` is. */
export function freshPair(taken: Iterable<string>): Pair {
  const avatar = avatarFromSeed(randomSeed());
  return {
    avatar,
    name: freshName(taken),
    still: `data:image/svg+xml,${encodeURIComponent(toSvg(avatar))}`,
  };
}

/** How many places apart two are, round the ring. */
export const apart = (a: number, b: number, kept: number) => {
  const d = Math.abs(a - b) % kept;
  return Math.min(d, kept - d);
};

/**
 * The places that come round to the far side as the choice goes from `from` to `to` the short way:
 * going right, the place half the ring ahead of each step; going left, the one behind it.
 */
export function comingRound(from: number, to: number, kept: number): number[] {
  const half = kept / 2;
  let steps = (((to - from) % kept) + kept) % kept;
  if (steps > half) steps -= kept;
  const places: number[] = [];
  for (let i = 1; i <= Math.abs(steps); i++) {
    const at = from + Math.sign(steps) * i;
    places.push((((steps > 0 ? at + half : at - half + 1) % kept) + kept) % kept);
  }
  return places;
}
