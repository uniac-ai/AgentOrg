// `screen@1`: a live picture of this computer's whole screen, as the person's own Mac shows it.
// Its frames come only when the picture changes, a PNG each, at most 1,280 pixels on the longest
// side; the screen is shown whole, centred, in its own shape. On the person's own Mac it shows that
// Mac's screen, this page among what is on it, as it is: it is watched only while its window is in
// front, so the picture of itself changes only while someone looks at it.
import { useRef } from "react";
import type { ViewerProps } from "./computer.tsx";
import { useLive } from "./live-socket.ts";
import { Closed } from "./xterm.tsx";

export function ScreenView({ target, corner }: ViewerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Watched only, for now: what a person does here waits for its clicks to be given by the drawn
  // pointer, not the real one. Operating is sent from here when it is, as the browser's is.
  const live = useLive({ ...target, mode: "watch" }, (data) => {
    // The frame's size is said before it; the picture says it too, so what it says is enough.
    if (typeof data === "string") return;
    void createImageBitmap(new Blob([data], { type: "image/png" })).then(
      (image) => {
        const c = canvas.current;
        if (!c) return;
        if (c.width !== image.width || c.height !== image.height) {
          c.width = image.width;
          c.height = image.height;
        }
        c.getContext("2d")?.drawImage(image, 0, 0);
      },
      () => {},
    );
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[15px] leading-[1.5]">
      <div className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-2">
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] text-muted-foreground">
          Your screen
        </span>
        {corner}
      </div>
      <div className="relative m-2 mt-0 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg">
        <canvas
          ref={canvas}
          role="img"
          aria-label="Your screen"
          className="max-h-full max-w-full rounded-lg"
        />
        {/* The agent's pointer, and its name beside it, go here once the service says where it
            is: the driver keeps its drawn pointer out of its own pictures. */}
      </div>
      <Closed state={live.state} again={live.again} />
    </div>
  );
}
