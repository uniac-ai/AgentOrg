// The user's own pane: one row per thing waiting on the user, oldest first. An ask opens beside
// the list; a message is settled in its row.

import { Link } from "@tanstack/react-router";
import {
  CheckCheckIcon,
  CheckIcon,
  CornerLeftUpIcon,
  FileTextIcon,
  InboxIcon,
  MessageCircleQuestionIcon,
  StickyNoteIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InboxEntry, InboxModel } from "../control/inbox.tsx";
import { SR, StateMark, StateName } from "./marks.tsx";
import { SplitView } from "./split.tsx";
import { Ago } from "./time.tsx";

function From({ entry }: { entry: InboxEntry }) {
  const id = entry.kind === "ask" ? entry.ask.agent : entry.message.from;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {entry.from ? <StateMark agent={entry.from} /> : null}
      <span className="truncate">{entry.from?.title ?? id}</span>
      {entry.from ? <StateName agent={entry.from} /> : null}
    </span>
  );
}

function AskRow({ entry, open }: { entry: Extract<InboxEntry, { kind: "ask" }>; open: boolean }) {
  const { ask } = entry;
  return (
    <li>
      <Link
        data-row
        to="/inbox/asks/$askId"
        params={{ askId: ask.id }}
        aria-current={open ? "true" : undefined}
        className={cn(
          "flex gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          open && "bg-muted",
        )}
      >
        <MessageCircleQuestionIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-state-waiting"
        />
        <SR>Ask: </SR>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 font-medium">{ask.title}</span>
          <span className="flex items-center gap-2">
            <From entry={entry} />
            {ask.escalates.length > 0 ? (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <CornerLeftUpIcon aria-hidden="true" className="size-3" />
                {ask.escalates.length}
                <SR> carried up</SR>
              </span>
            ) : null}
          </span>
        </span>
        <Ago at={entry.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
      </Link>
    </li>
  );
}

function MessageRow({
  entry,
  model,
}: {
  entry: Extract<InboxEntry, { kind: "message" }>;
  model: InboxModel;
}) {
  const { message } = entry;
  const report = message.kind === "report";
  const Icon = report ? FileTextIcon : StickyNoteIcon;
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/60">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <SR>{report ? "Report: " : "Note: "}</SR>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-3 whitespace-pre-line">{message.body}</span>
        <From entry={entry} />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2">
        <Ago at={entry.at} className="text-xs text-muted-foreground tabular-nums" />
        <Button
          data-row
          size="sm"
          variant="outline"
          onClick={() => (report ? model.onAcknowledge(message) : model.onMarkRead(message))}
        >
          {report ? <CheckCheckIcon aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}
          {report ? "Acknowledge" : "Mark read"}
        </Button>
      </span>
    </li>
  );
}

export function InboxView(model: InboxModel) {
  const list = (
    <section aria-labelledby="inbox-title" className="mx-auto w-full max-w-3xl p-3 sm:p-6">
      <h1 id="inbox-title" className="sr-only">
        Inbox
      </h1>
      {model.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <InboxIcon aria-hidden="true" className="size-8" />
          <p>Nothing is waiting on you</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {model.entries.map((entry) =>
            entry.kind === "ask" ? (
              <AskRow key={entry.ask.id} entry={entry} open={model.openAsk === entry.ask.id} />
            ) : (
              <MessageRow key={entry.message.id} entry={entry} model={model} />
            ),
          )}
        </ul>
      )}
    </section>
  );
  return <SplitView main={list} detail={model.thread} />;
}
