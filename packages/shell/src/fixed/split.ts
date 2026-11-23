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
