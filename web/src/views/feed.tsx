// One line per settled call, into the entity or from it: what it was about, who called whom, and
// how it ended. Each opens in the thread beside the pane.

import { cn } from "@/lib/utils";
import type { ActorRecord } from "../../../src/human/types.ts";
import type { FeedEntry } from "../model/activity.ts";
import { CallIcon, CallRoute, callTitle, type Names, outcomeOf } from "./calls.tsx";
import { CallLink } from "./links.tsx";
import { SR } from "./marks.tsx";
import { Ago } from "./time.tsx";

export function Feed({
  entries,
  entity,
  names,
}: {
  entries: FeedEntry[];
  entity: ActorRecord | null;
  names: Names;
}) {
  return (
    <ol className="flex flex-col">
      {entries.map(({ at, call }, index) => (
        <li
          key={call.id}
          className={cn("flex items-start gap-3 border-l py-2 pl-4 text-sm", index === 0 && "pt-0")}
        >
          <CallLink
            call={call}
            entity={entity}
            className="min-w-0 flex-1 hover:bg-transparent hover:underline"
          >
            <CallIcon call={call} className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span className="line-clamp-2">{callTitle(call)}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <CallRoute call={call} names={names} />
                <SR>: </SR>
                <span
                  className={cn(
                    "font-medium",
                    call.state === "done" ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {outcomeOf(call)}
                </span>
              </span>
            </span>
          </CallLink>
          <Ago at={at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
        </li>
      ))}
    </ol>
  );
}
