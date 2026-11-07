// The resizable layout pieces: react-resizable-panels, with the kit's handle.
import { Separator } from "react-resizable-panels";

export { Group as ResizableGroup, Panel as ResizablePanel } from "react-resizable-panels";

/** The handle between two panels: dragged, or moved with the arrow keys; only its line shows. */
export function ResizeHandle({ label }: { label: string }) {
  return <Separator className="kit-resize-handle" aria-label={label} />;
}
