import { useRef, useState } from "react";

/** The widgets' width, in CSS pixels: a preference of this browser's, kept between visits. */
const KEY = "agentorg.widgets";
export const WIDGETS = { min: 280, max: 640, initial: 340, step: 16 };

const clamp = (width: number) => Math.round(Math.min(WIDGETS.max, Math.max(WIDGETS.min, width)));

function stored(): number {
  try {
    const width = Number(localStorage.getItem(KEY));
    return width ? clamp(width) : WIDGETS.initial;
  } catch {
    return WIDGETS.initial;
  }
}

/** The widgets' width, and how to change it; a change is kept once it's settled. */
export function useWidgetsWidth(): [number, (width: number, keep?: boolean) => void] {
  const [width, setWidth] = useState(stored);
  return [
    width,
    (next, keep = true) => {
      const clamped = clamp(next);
      setWidth(clamped);
      if (keep)
        try {
          localStorage.setItem(KEY, String(clamped));
        } catch {
          // Not kept: it's only a preference.
        }
    },
  ];
}

/**
 * The handle between the chat and the widgets: dragged, or moved with the arrow keys, it sets the
 * widgets' width. It sits in the gap between them, so it takes no room of its own.
 */
export function Divider({
  width,
  onWidth,
}: {
  width: number;
  onWidth(width: number, keep?: boolean): void;
}) {
  const drag = useRef<{ x: number; width: number }>(undefined);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA splitter; <hr> can't take focus or drags.
    <div
      className="divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the widgets"
      aria-valuemin={WIDGETS.min}
      aria-valuemax={WIDGETS.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        const from = drag.current;
        // The handle is left of the widgets: dragged left, they widen.
        if (from) onWidth(from.width + from.x - event.clientX, false);
      }}
      onPointerUp={(event) => {
        const from = drag.current;
        drag.current = undefined;
        if (from) onWidth(from.width + from.x - event.clientX);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        onWidth(width);
      }}
      onKeyDown={(event) => {
        const by = { ArrowLeft: WIDGETS.step, ArrowRight: -WIDGETS.step }[event.key];
        if (by === undefined) return;
        event.preventDefault();
        onWidth(width + by);
      }}
    />
  );
}
