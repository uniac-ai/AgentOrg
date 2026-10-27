// The inbox: one row per thing waiting on the user, oldest first, each opening its sender.

import { Link } from "@tanstack/react-router";
import { FileTextIcon, InboxIcon, MessageCircleQuestionIcon, StickyNoteIcon } from "lucide-react";
import type { InboxEntry, InboxModel } from "../control/inbox.tsx";
import { SR, StateMark, StateName } from "./marks.tsx";
import { Ago } from "./time.tsx";

function EntryIcon({ entry }: { entry: InboxEntry }) {
  const Icon =
    entry.kind === "ask"
      ? MessageCircleQuestionIcon
      : entry.message.kind === "report"
        ? FileTextIcon
        : StickyNoteIcon;
  const name = entry.kind === "ask" ? "Ask" : entry.message.kind === "report" ? "Report" : "Note";
  return (
    <span className="mt-0.5 text-muted-foreground">
      <Icon aria-hidden="true" className="size-4" />
      <SR>{name}</SR>
    </span>
  );
}

function Row({ entry }: { entry: InboxEntry }) {
  const agentId = entry.kind === "ask" ? entry.ask.agent : entry.message.from;
  const text = entry.kind === "ask" ? entry.ask.title : entry.message.body.split("\n")[0];
  return (
    <li>
      <Link
        to="/people/$agentId"
        params={{ agentId }}
        className="flex gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <EntryIcon entry={entry} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium">{text}</span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {entry.from ? <StateMark agent={entry.from} /> : null}
            <span className="truncate">{entry.from?.title ?? agentId}</span>
            {entry.from ? <StateName agent={entry.from} /> : null}
          </span>
        </span>
        <Ago at={entry.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
      </Link>
    </li>
  );
}

export function InboxView({ entries }: InboxModel) {
  return (
    <section aria-labelledby="inbox-title" className="mx-auto w-full max-w-3xl p-3 sm:p-6">
      <h1 id="inbox-title" className="sr-only">
        Inbox
      </h1>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <InboxIcon aria-hidden="true" className="size-8" />
          <p>Nothing is waiting on you</p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <Row key={entry.kind === "ask" ? entry.ask.id : entry.message.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
