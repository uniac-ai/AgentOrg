// Keyboard shortcuts: one window listener per caller, which skips keys typed into a field unless
// the handler asks for them.

import { useEffect, useRef } from "react";

/** True while the user types into a field, where single-key shortcuts must not fire. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Call `handle` for every key press; when it returns true, the key's default action is cancelled. */
export function useKeys(handle: (event: KeyboardEvent) => boolean | undefined) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (latest.current(event)) event.preventDefault();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/** The row that has focus: its `data-row` value, else undefined. */
export function focusedRow(): string | undefined {
  const row = document.activeElement?.closest<HTMLElement>("[data-row]");
  return row?.dataset.row || undefined;
}

/**
 * `j`/`k` (or ↓/↑ with no field focused) move focus through the rows of the list on screen, as
 * in a mail client; a row is any element marked `data-row`. Enter then opens or acts on it.
 */
export function useRowKeys() {
  useKeys((event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return false;
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return false;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
    if (rows.length === 0) return false;
    const at = rows.findIndex((row) => row.contains(document.activeElement));
    const next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next]?.focus();
    return true;
  });
}
