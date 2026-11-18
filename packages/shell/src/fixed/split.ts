// Whether a page has room for its list beside what is chosen in it, by the page's own width.
import { useLayoutEffect, useRef, useState } from "react";

/** The width, in pixels, from which a page holds its list and what is chosen side by side. */
export const SPLIT = 896;

/** A ref for the page, and whether it is wide enough for both, measured as it changes. */
export function useSplit<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [split, setSplit] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSplit(element.clientWidth >= SPLIT);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  return [ref, split] as const;
}
