// Activity: every write and every routed call on the record, newest first, a line each, grouped by
// day. Who did it, what they did and to what read left to right; a refusal shows its error code.

import { Link } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuditRecord } from "../../../src/human/types.ts";
import type { ActivityModel } from "../control/activity.tsx";
import { callTitle, nameOf } from "./calls.tsx";

const VERBS: Record<string, string> = {
  actor_create: "created",
  actor_close: "closed",
  status_set: "set its status",
  call_withdraw: "withdrew",
};

/** A routed call's line by the state it entered: called by its caller, settled by its callee. */
const CALL_VERBS: Record<string, string> = {
  pending: "called",
  done: "answered",
  failed: "failed",
  withdrawn: "withdrew",
};

/** How the user settles a note or a report: there is nothing to answer. */
const SETTLED: Record<string, string> = { note: "read", report: "acknowledged" };

function verbOf(entry: AuditRecord, model: ActivityModel): string {
  if (entry.operation !== "call") return VERBS[entry.operation] ?? entry.operation;
  const tool = entry.target ? model.calls.get(entry.target)?.interface : undefined;
  if (entry.outcome === "done" && tool && SETTLED[tool]) return SETTLED[tool];
  return CALL_VERBS[entry.outcome] ?? "called";
}

/** Whether the entry records a refusal, which shows its error code. */
const refused = (entry: AuditRecord) =>
  entry.operation === "call" ? !(entry.outcome in CALL_VERBS) : entry.outcome !== "ok";

function Target({ entry, model }: { entry: AuditRecord; model: ActivityModel }) {
  // An actor acting on itself, such as setting its status, names no one else.
  if (entry.target === null || entry.target === entry.actor) return null;
  const call = model.calls.get(entry.target);
  if (call) {
    return call.to === model.root ? (
      <Link
        to="/calls/$callId"
        params={{ callId: call.id }}
        className="truncate font-medium hover:underline"
      >
        {callTitle(call)}
      </Link>
    ) : (
      <Link
        to="/people/$actorId/calls/$callId"
        params={{ actorId: call.to, callId: call.id }}
        className="truncate font-medium hover:underline"
      >
        {callTitle(call)}
      </Link>
    );
  }
  if (!model.names.has(entry.target)) return null;
  return entry.target === model.root ? null : (
    <Link
      to="/people/$actorId"
      params={{ actorId: entry.target }}
      className="truncate font-medium hover:underline"
    >
      {nameOf(entry.target, model.names)}
    </Link>
  );
}

function Line({ entry, model }: { entry: AuditRecord; model: ActivityModel }) {
  const actor =
    entry.actor === null
      ? "agentorg"
      : entry.actor === model.root
        ? "You"
        : nameOf(entry.actor, model.names);
  return (
    <li className="flex min-w-0 items-baseline gap-3 py-1.5 text-sm">
      <time
        dateTime={entry.at}
        className="w-16 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </time>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
        <span className="font-medium">{actor}</span>
        <span className="text-muted-foreground">{verbOf(entry, model)}</span>
        <Target entry={entry} model={model} />
        {refused(entry) ? <span className="text-xs text-destructive">{entry.outcome}</span> : null}
      </span>
    </li>
  );
}

export function ActivityView(model: ActivityModel) {
  const days = new Map<string, AuditRecord[]>();
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
