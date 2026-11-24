// Whether a page has room for its list beside what is chosen in it, by the page's own width.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The width, in pixels, from which a page holds its list and what is chosen side by side: the
 * `split` variant in styles.css, which the frame and the page's parts are laid out by.
 */
export const SPLIT = 896;

/** A ref for the page, whether it is wide enough for both, and its width, measured as it changes. */
export function useSplit<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  const split = width === 0 || width >= SPLIT;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  return [ref, split, width] as const;
}

/** Whether the list is put away, where a page has room for it beside what is chosen. */
let collapsed = false;
/** Whether it has just been put away as the page opened, and not by the person. */
let opened = false;
const watching = new Set<() => void>();
const watch = (told: () => void) => {
  watching.add(told);
  return () => void watching.delete(told);
};
const tell = () => {
  for (const told of [...watching]) told();
};
/** Puts the list away or brings it back: `asOpened`, as the page opens, from what was kept. */
export function setCollapsed(next: boolean, asOpened = false) {
  collapsed = next;
  opened = asOpened;
  tell();
}
/** The list put away as the page opened has been drawn away. */
export function settle() {
  if (!opened) return;
  opened = false;
  tell();
}
export const useCollapsed = () => useSyncExternalStore(watch, () => collapsed);
/** Whether the list is being put away as the page opens: it is away at once, with no motion. */
export const useOpenedAway = () => useSyncExternalStore(watch, () => opened);

/**
 * How wide the frame's side is, in pixels: the page's list beside what is chosen, and the frame's
 * rows over it. `--side` in styles.css starts at `start`, and a person drags it from there.
 */
export const SIDE = {
  start: 300,
  /**
   * A row with a name of two words whole: 150 for its face, its time and the room around them,
   * and 106 for the name. Under 288 the pinned tiles, 88 at least, are two to a row.
   */
  least: 256,
  /** A conversation's own room: the list is never wider than the narrowest a conversation is kept. */
  most: 480,
  /** Of the frame's width at most, so the card beside it stays the larger part. */
  share: 0.4,
  /** What an arrow key moves it by. */
  step: 16,
} as const;
/** The width the person chose, and the frame's own width: 0 until it is measured. */
let chosen: number = SIDE.start;
let room = 0;
/** What a page keeps beside the list while something is open beside its conversation: else 0. */
let kept = 0;
/**
 * The widest the side is in the frame as it is now: its share of the frame, and what the page
 * leaves of it, which holds a list made wider and never one as wide as it starts.
 */
const most = () =>
  room
    ? Math.max(
        SIDE.least,
        Math.min(SIDE.most, Math.floor(room * SIDE.share), Math.max(SIDE.start, room - kept)),
      )
    : SIDE.most;
/** Chooses the side's width, within its least and its most. */
export function setSide(next: number) {
  chosen = Math.round(Math.max(SIDE.least, Math.min(SIDE.most, next)));
  tell();
}
/** The frame's width, measured: a width chosen in a wider frame is held to what this one has. */
export function setRoom(next: number) {
  if (next === room) return;
  room = next;
  tell();
}
/** A page says what it keeps beside the list: the side is held to what is left of the frame. */
export function setKept(next: number) {
  if (next === kept) return;
  kept = next;
  tell();
}
/** The side's width now: what was chosen, or the most this frame has room for if that is less. */
export const useSide = () => useSyncExternalStore(watch, () => Math.min(chosen, most()));
export const useSideMost = () => useSyncExternalStore(watch, most);
