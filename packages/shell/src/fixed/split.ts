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
const watching = new Set<() => void>();
export function setCollapsed(next: boolean) {
  collapsed = next;
  for (const told of [...watching]) told();
}
export const useCollapsed = () =>
  useSyncExternalStore(
    (told) => {
      watching.add(told);
      return () => void watching.delete(told);
    },
    () => collapsed,
  );
