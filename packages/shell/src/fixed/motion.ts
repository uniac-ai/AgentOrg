import { useSyncExternalStore } from "react";

/** Whether the person asks for less motion, followed as it changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}
