// Under a person's message while it is in hand, one muted line on the bubble's side. Taken, it is
// the library's spinner alone; with a step, the step's words with the library's shimmer. It is a
// fact about that one message, not the chat's or the agent's, and goes when the message is
// answered or closed. The line is a status region whose words are heard once each; what it shows
// is seen, not heard.
import { Marker, MarkerContent, MarkerIcon } from "../ui/marker.tsx";
import { Spinner } from "../ui/spinner.tsx";
import type { Progress } from "./data.ts";

/** The line of a message in hand; of one that isn't, nothing. */
export function WorkingLine({ progress }: { progress: Progress | undefined }) {
  if (!progress) return null;
  const said = progress.step;
  return (
    <Marker role="status" className="w-fit max-w-[80%]">
      <span className="sr-only">{said ?? "Taken"}</span>
      {said ? (
        <MarkerContent aria-hidden className="shimmer">
          {said}
        </MarkerContent>
      ) : (
        <MarkerIcon>
          <Spinner />
        </MarkerIcon>
      )}
    </Marker>
  );
}
