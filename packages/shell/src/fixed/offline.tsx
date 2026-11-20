// While signed in and the service can't be reached: one steady notice, centred at the top, over the
// whole screen under a gradual blur. Nothing turns and nothing waits on "…" while the client's own
// backoff tries again; when a try reaches the service, the notice and the blur go. Pressed, the
// notice tries at once, and says so while that try runs. Every cursor event over the screen stops at
// the blur, and the page under it is inert (see `useOffline`), so nothing under it is pressed by
// accident.
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWaited } from "../app.tsx";
import { api, useConnection } from "../data.ts";
import GradualBlur from "../ui/gradual-blur.tsx";

/** Whether the service has been out of reach for a moment: a quick reconnection shows nothing. */
export const useOffline = () => useWaited(useConnection() === "connecting");

/** Stops an event where it is: nothing under the blur, an open window included, hears it. */
const hold = (event: { stopPropagation(): void }) => event.stopPropagation();
const held = {
  onPointerDown: hold,
  onPointerUp: hold,
  onPointerMove: hold,
  onMouseDown: hold,
  onMouseUp: hold,
  onClick: hold,
  onDoubleClick: hold,
  onWheel: hold,
  onContextMenu: (event: { stopPropagation(): void; preventDefault(): void }) => {
    event.stopPropagation();
    event.preventDefault();
  },
};

/** The notice and the blur, over everything the page shows, a window too. */
export function Offline() {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await api.connectNow();
    } finally {
      setChecking(false);
    }
  };
  return createPortal(
    <>
      {/* The page behind, blurred most under the notice and fading to clear at the foot. */}
      <div
        data-offline-cover
        className="pointer-events-auto fixed inset-0 z-[100] touch-none overscroll-none"
        {...held}
      >
        <GradualBlur position="top" height="100%" zIndex={0} />
      </div>
      {/* At the layer's inset from the top. */}
      <div
        role="status"
        className="pointer-events-auto fixed top-5 left-1/2 z-[101] -translate-x-1/2"
        onPointerDown={hold}
        onMouseDown={hold}
        onWheel={hold}
        onContextMenu={held.onContextMenu}
      >
        {/* Pointed at, or reached by the keyboard, the refresh mark shows at its start; without a
            pointer it always shows. While a try it asked for runs, it says so, with no mark. */}
        <button
          type="button"
          aria-label={checking ? "Reconnecting" : "You're offline. Check again"}
          aria-busy={checking || undefined}
          onClick={() => void check()}
          className={`window group/offline relative flex ${checking ? "cursor-default" : "cursor-pointer"} items-center rounded-full bg-[var(--raised)] px-4 py-2 text-[13px] whitespace-nowrap text-foreground shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`}
        >
          {!checking && (
            <span
              aria-hidden
              className="inline-flex w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-150 group-hover/offline:mr-2 group-hover/offline:w-3.5 group-hover/offline:opacity-100 group-focus-visible/offline:mr-2 group-focus-visible/offline:w-3.5 group-focus-visible/offline:opacity-100 [@media(hover:none)]:mr-2 [@media(hover:none)]:w-3.5 [@media(hover:none)]:opacity-100"
            >
              <RotateCwIcon className="size-3.5 shrink-0" />
            </span>
          )}
          {checking ? "Reconnecting…" : "You're offline"}
        </button>
      </div>
    </>,
    document.body,
  );
}
