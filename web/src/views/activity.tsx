// Activity: every write on the record, newest first, a line each, grouped by day. Who did it,
// what they did and to what read left to right; a refused write shows its error code.

import { Link } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActivityEntry, ActivityModel } from "../control/activity.tsx";
import { ClientMark } from "./marks.tsx";

const VERBS: Record<string, string> = {
  agent_create: "created",
  agent_close: "closed",
  agent_close_as_user: "closed",
  session_attach: "attached a session",
  status_set: "set its status",
  ask_open: "asked",
  ask_withdraw: "withdrew",
  ask_answer: "answered",
  ask_record_answer: "recorded your answer to",
  ask_answer_as_user: "answered",
  message_send: "sent a message",
  inbox_read: "read its inbox",
  message_ack: "acknowledged a report",
  message_ack_as_user: "acknowledged a report",
  message_read_as_user: "read a note",
  ui_login_link: "made a sign-in link",
};

function Target({ entry, model }: { entry: ActivityEntry; model: ActivityModel }) {
  // An agent acting on itself, such as setting its status, names no one else.
  if (entry.target === null || entry.target === entry.agent) return null;
  const agent = model.agents.get(entry.target);
  if (agent) {
    return (
      <Link
        to="/people/$agentId"
        params={{ agentId: agent.id }}
        className="truncate font-medium hover:underline"
      >
        {agent.title}
      </Link>
    );
  }
  const ask = model.asks.get(entry.target);
  if (ask) {
    return (
      <Link
        to="/people/$agentId/asks/$askId"
        params={{ agentId: ask.agent, askId: ask.id }}
        className="truncate font-medium hover:underline"
      >
        {ask.title}
      </Link>
    );
  }
  return null;
}

function Line({ entry, model }: { entry: ActivityEntry; model: ActivityModel }) {
  const actor = entry.agent
    ? (model.agents.get(entry.agent)?.title ?? entry.agent)
    : entry.channel === "page"
      ? "You"
      : "API";
  return (
    <li className="flex min-w-0 items-baseline gap-3 py-1.5 text-sm">
      <time
        dateTime={entry.at}
        className="w-16 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </time>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
        {entry.client ? <ClientMark client={entry.client} /> : null}
        <span className="font-medium">{actor}</span>
        <span className="text-muted-foreground">{VERBS[entry.operation] ?? entry.operation}</span>
        <Target entry={entry} model={model} />
        {entry.outcome !== "ok" ? (
          <span className="text-xs text-destructive">{entry.outcome}</span>
        ) : null}
      </span>
    </li>
  );
}

export function ActivityView(model: ActivityModel) {
  const days = new Map<string, ActivityEntry[]>();
  for (const entry of model.entries) {
    const day = new Date(entry.at).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <section
      aria-labelledby="activity-title"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6"
    >
      <h1 id="activity-title" className="sr-only">
        Activity
      </h1>
      {model.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
          <ActivityIcon aria-hidden="true" className="size-8" />
          <p>No activity yet</p>
        </div>
      ) : null}
      {[...days].map(([day, entries]) => (
        <section key={day} aria-label={day} className="flex flex-col">
          <h2 className="sticky top-0 bg-background py-1 text-xs font-medium text-muted-foreground">
            {day}
          </h2>
          <ol className="flex flex-col">
            {entries.map((entry) => (
              <Line key={entry.id} entry={entry} model={model} />
            ))}
          </ol>
        </section>
      ))}
      {model.more ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          onClick={model.onShowMore}
        >
          More
        </Button>
      ) : null}
    </section>
  );
}
