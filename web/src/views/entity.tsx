// An entity's view, the same for the user and for every actor, like a person's pane in a messaging
// app. In order: who it is, what waits on it and from whom, its own calls going out, the
// organization below it, its manager, and what happened to it. An open call shows as a thread
// beside the view.

import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowUpIcon,
  CheckCheckIcon,
  CheckIcon,
  CornerLeftUpIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActorRecord, CallRecord } from "../../../src/human/types.ts";
import type { EntityModel } from "../control/entity.tsx";
import { total } from "../model/progress.ts";
import { CallIcon, CallRoute, callTitle, nameOf } from "./calls.tsx";
import { Chart, ProgressStrip } from "./chart.tsx";
import { Feed } from "./feed.tsx";
import { CallLink } from "./links.tsx";
import { OnlineMark, SR, StateMark, StateName } from "./marks.tsx";
import { SplitView } from "./split.tsx";
import { Ago } from "./time.tsx";

function CloseActor({ model, actor }: { model: EntityModel; actor: ActorRecord }) {
  const close = model.close;
  if (!close) return null;
  const blocked = close.openReports.length > 0;
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
      >
        <ArchiveIcon aria-hidden="true" />
        <SR>Close actor</SR>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {actor.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "Actors under it are still open."
              : close.openCalls === 0
                ? "Its connections close."
                : `Its connections close, and its ${close.openCalls === 1 ? "pending call ends" : `${close.openCalls} pending calls end`}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <ul className="flex flex-col gap-1 text-sm">
            {close.openReports.map((report) => (
              <li key={report.id}>
                <Link
                  to="/people/$actorId"
                  params={{ actorId: report.id }}
                  className="inline-flex items-center gap-2 hover:underline"
                >
                  <StateMark actor={report} />
                  {report.name}
                  <StateName actor={report} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={blocked || close.closing}
            onClick={close.onClose}
          >
            Close actor
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Header({ model }: { model: EntityModel }) {
  const actor = model.entity;
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {actor ? (
          <StateMark actor={actor} />
        ) : (
          <UserRoundIcon aria-hidden="true" className="size-4" />
        )}
        <h1 id="entity-title" className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {actor ? actor.name : "You"}
        </h1>
        {actor ? <StateName actor={actor} /> : null}
        {actor ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {actor.online ? <OnlineMark /> : null}
            <span className="text-xs text-muted-foreground tabular-nums">
              <SR>Last update </SR>
              <Ago at={actor.status?.updated_at ?? actor.created_at} />
            </span>
            <CloseActor model={model} actor={actor} />
          </span>
        ) : null}
      </div>
      {actor ? <p className="text-sm text-muted-foreground">{actor.purpose}</p> : null}
      {actor?.status?.summary ? (
        <section aria-label="Status" className="pt-3">
          <p className="whitespace-pre-wrap">{actor.status.summary}</p>
        </section>
      ) : null}
    </header>
  );
}

/** A call that waits, with who it came from and when. */
function From({ call, model }: { call: CallRecord; model: EntityModel }) {
  const from = model.actors.get(call.from);
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {from ? <StateMark actor={from} /> : null}
      <SR>from </SR>
      {nameOf(call.from, model.names)}
      {call.cause !== null ? (
        <span className="inline-flex items-center gap-0.5">
          <CornerLeftUpIcon aria-hidden="true" className="size-3" />
          <SR>, carried up</SR>
        </span>
      ) : null}
    </span>
  );
}

/** What waits on the entity, each call with who it came from, pinned at the top. */
function Pending({ model }: { model: EntityModel }) {
  if (model.pending.length === 0) {
    return model.entity === null ? (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing is waiting on you
      </p>
    ) : null;
  }
  return (
    <section
      aria-label="Waiting"
      className="flex flex-col gap-0.5 rounded-lg border border-state-waiting/30 bg-state-waiting/5 p-1.5"
    >
      {model.pending.map((call) => {
        const settle = call.tool === "note" || call.tool === "report" ? model.onSettle : undefined;
        if (settle) {
          const report = call.tool === "report";
          return (
            <div key={call.id} className="flex flex-wrap items-start gap-2.5 px-2.5 py-2 text-sm">
              <CallIcon call={call} className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col">
                <SR>{report ? "Report: " : "Note: "}</SR>
                <span className="line-clamp-3 whitespace-pre-line">
                  {String(call.input.outcome ?? call.input.text ?? "")}
                </span>
                <From call={call} model={model} />
              </span>
              <span className="flex shrink-0 flex-col items-end gap-2">
                <Ago at={call.created_at} className="text-xs text-muted-foreground tabular-nums" />
                <Button data-row size="sm" variant="outline" onClick={() => settle(call)}>
                  {report ? (
                    <CheckCheckIcon aria-hidden="true" />
                  ) : (
                    <CheckIcon aria-hidden="true" />
                  )}
                  {report ? "Acknowledge" : "Mark read"}
                </Button>
              </span>
            </div>
          );
        }
        return (
          <CallLink
            key={call.id}
            call={call}
            entity={model.entity}
            open={model.openCall === call.id}
            className="px-2.5 py-2 text-sm"
          >
            <CallIcon call={call} className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 font-medium">{callTitle(call)}</span>
              <From call={call} model={model} />
            </span>
            <Ago
              at={call.created_at}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            />
          </CallLink>
        );
      })}
    </section>
  );
}

/** Its own calls still waiting on another actor. */
function OpenCalls({ model }: { model: EntityModel }) {
  if (model.openCalls.length === 0) return null;
  return (
    <section aria-label="Called" className="flex flex-col gap-0.5">
      {model.openCalls.map((call) => (
        <CallLink
          key={call.id}
          call={call}
          entity={model.entity}
          open={model.openCall === call.id}
          className="px-2.5 py-2 text-sm"
        >
          <ArrowUpIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2">{callTitle(call)}</span>
            <span className="text-xs text-muted-foreground">
              <CallRoute call={call} names={model.names} />
            </span>
          </span>
          <Ago
            at={call.created_at}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          />
        </CallLink>
      ))}
    </section>
  );
}

/** Its manager, above it: an actor, or the user for an actor directly under the user. */
function Manager({ manager }: { manager: ActorRecord | null }) {
  const style =
    "flex items-center gap-2 self-start rounded-lg border bg-card px-3 py-2 text-sm hover:bg-muted/60";
  const content = (
    <>
      <ArrowUpIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <SR>Manager: </SR>
      {manager ? (
        <StateMark actor={manager} />
      ) : (
        <UserRoundIcon aria-hidden="true" className="size-3.5" />
      )}
      <span className="font-medium">{manager ? manager.name : "You"}</span>
      {manager ? <StateName actor={manager} /> : null}
    </>
  );
  return manager ? (
    <Link to="/people/$actorId" params={{ actorId: manager.id }} className={style}>
      {content}
    </Link>
  ) : (
    <Link to="/" className={style}>
      {content}
    </Link>
  );
}

export function EntityView(model: EntityModel) {
  const actor = model.entity;
  const { reports } = model;
  const pane = (
    <article
      aria-labelledby="entity-title"
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6"
    >
      <Header model={model} />
      <Pending model={model} />
      <OpenCalls model={model} />
      {reports.chart.length > 0 ? (
        <section aria-label="Below" className="flex flex-col gap-2">
          {total(reports.totals) > 1 ? (
            <ProgressStrip totals={reports.totals} recent={reports.recent} />
          ) : null}
          <Chart nodes={reports.chart} />
        </section>
      ) : null}
      {actor ? <Manager manager={model.manager} /> : null}
      {model.feed.length > 0 ? (
        <section aria-label="Recent work" className="flex flex-col gap-2">
          <Feed entries={model.feed} entity={actor} names={model.names} />
          {model.more > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start text-muted-foreground"
              onClick={model.onShowMore}
            >
              More
              <span className="tabular-nums">{model.more}</span>
            </Button>
          ) : null}
        </section>
      ) : null}
    </article>
  );
  return <SplitView main={pane} detail={model.thread} />;
}
