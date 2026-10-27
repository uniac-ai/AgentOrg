// One line per thing that happened to an agent: a status set, an ask opened or answered, a
// message sent or received. Asks open in the thread beside the pane.

import {
  ArrowRightIcon,
  CheckIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  StickyNoteIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentRecord } from "../../../src/page/types.ts";
import type { FeedEntry } from "../model/activity.ts";
import { AskLink } from "./links.tsx";
import { SR, StateShape } from "./marks.tsx";
import { nameOf, Route } from "./thread.tsx";
import { Ago } from "./time.tsx";

const firstLine = (text: string) => text.split("\n")[0] ?? text;

function Line({
  entry,
  entity,
  agents,
}: {
  entry: FeedEntry;
  entity: AgentRecord | null;
  agents: ReadonlyMap<string, AgentRecord>;
}) {
  switch (entry.kind) {
    case "status": {
      const { status } = entry;
      return (
        <span className="flex min-w-0 flex-1 items-start gap-2.5">
          <StateShape state={status.state} className="mt-1" />
          <SR>{`Status ${status.state}: `}</SR>
          <span className="line-clamp-2 whitespace-pre-line">{status.summary || status.state}</span>
        </span>
      );
    }
    case "asked":
      return (
        <AskLink
          ask={entry.ask}
          entity={entity}
          className="min-w-0 flex-1 hover:bg-transparent hover:underline"
        >
          <MessageCircleQuestionIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-state-waiting"
          />
          <span className="flex min-w-0 flex-col">
            <span className="line-clamp-2">{entry.ask.title}</span>
            <span className="text-xs text-muted-foreground">
              <Route ask={entry.ask} agents={agents} />
            </span>
          </span>
        </AskLink>
      );
    case "answered": {
      const answer = entry.ask.answer;
      return (
        <AskLink
          ask={entry.ask}
          entity={entity}
          className="min-w-0 flex-1 hover:bg-transparent hover:underline"
        >
          <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-state-closed" />
          <span className="flex min-w-0 flex-col">
            <span>
              <SR>Answered: </SR>
              <span className="font-medium">{answer?.choice ?? answer?.words}</span>
              <span className="text-muted-foreground"> · {nameOf(answer?.by ?? null, agents)}</span>
            </span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{entry.ask.title}</span>
          </span>
        </AskLink>
      );
    }
    case "message": {
      const { message } = entry;
      const Icon = message.kind === "report" ? FileTextIcon : StickyNoteIcon;
      return (
        <span className="flex min-w-0 flex-1 items-start gap-2.5">
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <SR>{message.kind === "report" ? "Report: " : "Note: "}</SR>
            <span className="line-clamp-2 whitespace-pre-line">{firstLine(message.body)}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {nameOf(message.from, agents)}
              <ArrowRightIcon aria-hidden="true" className="size-3" />
              <SR> to </SR>
              {nameOf(message.to, agents)}
            </span>
          </span>
        </span>
      );
    }
  }
}

export function Feed({
  entries,
  entity,
  agents,
}: {
  entries: FeedEntry[];
  entity: AgentRecord | null;
  agents: ReadonlyMap<string, AgentRecord>;
}) {
  return (
    <ol className="flex flex-col">
      {entries.map((entry, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id of their own.
          key={`${entry.kind}-${entry.at}-${index}`}
          className={cn("flex items-start gap-3 border-l py-2 pl-4 text-sm", index === 0 && "pt-0")}
        >
          <Line entry={entry} entity={entity} agents={agents} />
          <Ago at={entry.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
        </li>
      ))}
    </ol>
  );
}
