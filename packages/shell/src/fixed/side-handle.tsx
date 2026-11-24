// The line between the page's list and its card, which a person drags to make the list wider or
// narrower, and the width they chose, kept in their store.
import { useEffect, useRef, useState } from "react";
import { api } from "../data.ts";
import { SIDE, setSide, useSide, useSideMost } from "./split.ts";

/** The person's store key for the width they chose. */
const LIST_WIDTH = "ui/list-width";

/** Reads the width the person chose as the page opens: the frame is that wide as the store answers. */
export function useKeptSide() {
  useEffect(() => {
    void api
      .call<{ value?: unknown }>("store", "get", { key: LIST_WIDTH })
      .then(({ value }) => {
        if (typeof value === "number" && Number.isFinite(value)) setSide(value);
      })
      .catch(() => {});
  }, []);
}

/**
 * The handle on the line between the list and the card, where they are side by side: 8 wide, with
 * nothing drawn until it is pointed at, has the keyboard or is dragged, when a thin line shows along
 * the card's edge. Dragged, the list is as wide as the pointer says, between its least and the most
 * the frame has room for, and the card has the rest. A double click puts it back where it starts.
 * With the keyboard on it, the arrows move it a step, and Home and End take it to its least and its
 * most. The width is kept as the drag ends, or the key is pressed.
 */
export function SideHandle() {
  const side = useSide();
  const most = useSideMost();
  /** Where the pointer took it, and how wide the list was then. */
  const from = useRef<{ x: number; side: number }>(undefined);
  const [dragging, setDragging] = useState(false);
  const within = (next: number) => Math.round(Math.max(SIDE.least, Math.min(most, next)));
  const keep = (next: number) => {
    setSide(next);
    void api.call("store", "set", { key: LIST_WIDTH, value: next }).catch(() => {});
  };
  const drop = () => {
    if (!from.current) return;
    const moved = from.current.side !== side;
    from.current = undefined;
    setDragging(false);
    if (moved) keep(side);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that is moved is not an `hr`.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="List width"
      aria-valuenow={side}
      aria-valuemin={SIDE.least}
      aria-valuemax={most}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // The press selects nothing as it moves.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        from.current = { x: event.clientX, side };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (from.current) setSide(within(from.current.side + event.clientX - from.current.x));
      }}
      onPointerUp={drop}
      onPointerCancel={drop}
      onLostPointerCapture={drop}
      onDoubleClick={() => keep(within(SIDE.start))}
      onKeyDown={(event) => {
        const to = {
          ArrowLeft: side - SIDE.step,
          ArrowRight: side + SIDE.step,
          Home: SIDE.least,
          End: most,
        }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        keep(within(to));
      }}
      className="group/handle absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none split:block"
    >
      {/* Along the card's edge, between its corners. */}
      <span className="absolute top-5 bottom-[26px] left-[3px] w-0.5 rounded-full bg-[var(--ring)] opacity-0 transition-opacity duration-100 group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-data-dragging/handle:opacity-100 motion-reduce:transition-none" />
    </div>
  );
}
