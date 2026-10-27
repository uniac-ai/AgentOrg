// An entity's view, the same for the user and for every agent, like a person's pane in a
// messaging app. In order: who it is, what waits on it and from whom, its own asks going up, the
// organization below it, its manager, and what happened to it. An open ask shows as a thread
// beside the view.

import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowUpIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  OctagonAlertIcon,
  StickyNoteIcon,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { AgentRecord } from "../../../src/page/types.ts";
import type { EntityModel } from "../control/entity.tsx";
import { total } from "../model/progress.ts";
import { Chart, ProgressStrip } from "./chart.tsx";
import { Feed } from "./feed.tsx";
import { AskLink } from "./links.tsx";
import { ClientMark, SR, StateMark, StateName } from "./marks.tsx";
import { SplitView } from "./split.tsx";
import { nameOf, Route } from "./thread.tsx";
import { Ago } from "./time.tsx";

const isWebLink = (url: string) => /^https?:\/\//i.test(url);

function CloseAgent({ model, agent }: { model: EntityModel; agent: AgentRecord }) {
  const close = model.close;
  if (!close) return null;
  const blocked = close.openChildren.length > 0;
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
      >
        <ArchiveIcon aria-hidden="true" />
        <SR>Close agent</SR>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {agent.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "Agents under it are still open."
              : close.openAsks === 0
                ? "Its session detaches."
                : `Its session detaches, and its ${close.openAsks === 1 ? "open ask is" : `${close.openAsks} open asks are`} withdrawn.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <ul className="flex flex-col gap-1 text-sm">
            {close.openChildren.map((child) => (
              <li key={child.id}>
                <Link
                  to="/people/$agentId"
                  params={{ agentId: child.id }}
                  className="inline-flex items-center gap-2 hover:underline"
                >
                  <StateMark agent={child} />
                  {child.title}
                  <StateName agent={child} />
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
            Close agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Header({ model }: { model: EntityModel }) {
  const agent = model.entity;
  const session = model.summary?.attached_session;
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {agent ? (
          <StateMark agent={agent} />
        ) : (
          <UserRoundIcon aria-hidden="true" className="size-4" />
        )}
        <h1 id="entity-title" className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {agent ? agent.title : "You"}
        </h1>
        {agent ? <StateName agent={agent} /> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {session ? <ClientMark client={session.client} live /> : null}
          {model.summary ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              <SR>Last active </SR>
              <Ago at={model.summary.last_activity_at} />
            </span>
          ) : null}
          {agent ? <CloseAgent model={model} agent={agent} /> : null}
        </span>
      </div>
      {agent ? <p className="text-sm text-muted-foreground">{agent.purpose}</p> : null}
    </header>
  );
}

function Status({ agent }: { agent: AgentRecord }) {
  const status = agent.status;
  if (!status) return null;
  return (
    <section aria-label="Status" className="flex flex-col gap-2">
      {status.summary ? <p className="whitespace-pre-wrap">{status.summary}</p> : null}
      {status.blockers.map((blocker) => (
        <p key={blocker} className="flex items-center gap-2 text-sm text-state-blocked">
          <OctagonAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          <SR>Blocked on </SR>
          {blocker}
        </p>
      ))}
      {status.links.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {status.links.map((link) => (
            <li key={`${link.label}-${link.url}`}>
              {isWebLink(link.url) ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm hover:bg-muted"
                >
                  {link.label}
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </a>
              ) : (
                <span
                  title={link.url}
                  className="inline-flex rounded-md border px-2 py-1 text-sm text-muted-foreground"
                >
                  {link.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** What waits on the entity, each item with who it came from, pinned at the top. */
function Pending({ model }: { model: EntityModel }) {
  const { asks, messages } = model.pending;
  if (asks.length + messages.length === 0) {
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
      {asks.map((ask) => {
        const from = model.agents.get(ask.agent);
        return (
          <AskLink
            key={ask.id}
            ask={ask}
            entity={model.entity}
            open={model.openAsk === ask.id}
            className="px-2.5 py-2 text-sm"
          >
            <MessageCircleQuestionIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-state-waiting"
            />
            <SR>Ask: </SR>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 font-medium">{ask.title}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {from ? <StateMark agent={from} /> : null}
                <SR>from </SR>
                {from?.title ?? ask.agent}
                {ask.escalates.length > 0 ? (
                  <span className="inline-flex items-center gap-0.5">
                    <CornerLeftUpIcon aria-hidden="true" className="size-3" />
                    {ask.escalates.length}
                    <SR> carried up</SR>
                  </span>
                ) : null}
              </span>
            </span>
            <Ago
              at={ask.opened_at}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            />
          </AskLink>
        );
      })}
      {messages.map((message) => {
        const report = message.kind === "report";
        const Icon = report ? FileTextIcon : StickyNoteIcon;
        const settle = report ? model.onAcknowledge : model.onMarkRead;
        return (
          <div key={message.id} className="flex flex-wrap items-start gap-2.5 px-2.5 py-2 text-sm">
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <SR>{report ? "Report: " : "Note: "}</SR>
              <span className="line-clamp-3 whitespace-pre-line">{message.body}</span>
              <span className="text-xs text-muted-foreground">
                <SR>from </SR>
                {nameOf(message.from, model.agents)}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-2">
              <Ago at={message.sent_at} className="text-xs text-muted-foreground tabular-nums" />
              {settle ? (
                <Button data-row size="sm" variant="outline" onClick={() => settle(message)}>
                  {report ? (
                    <CheckCheckIcon aria-hidden="true" />
                  ) : (
                    <CheckIcon aria-hidden="true" />
                  )}
                  {report ? "Acknowledge" : "Mark read"}
                </Button>
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** Its own open asks, going up to its manager. */
function OwnAsks({ model }: { model: EntityModel }) {
  if (model.ownAsks.length === 0) return null;
  return (
    <section aria-label="Asked" className="flex flex-col gap-0.5">
      {model.ownAsks.map((ask) => (
        <AskLink
          key={ask.id}
          ask={ask}
          entity={model.entity}
          open={model.openAsk === ask.id}
          className="px-2.5 py-2 text-sm"
        >
          <ArrowUpIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2">{ask.title}</span>
            <span className="text-xs text-muted-foreground">
              <Route ask={ask} agents={model.agents} />
            </span>
          </span>
          <Ago at={ask.opened_at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
        </AskLink>
      ))}
    </section>
  );
}

/** Its manager, above it: an agent, or the user for an agent directly under the user. */
function Manager({ manager }: { manager: AgentRecord | null }) {
  const style =
    "flex items-center gap-2 self-start rounded-lg border bg-card px-3 py-2 text-sm hover:bg-muted/60";
  const content = (
    <>
      <ArrowUpIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <SR>Manager: </SR>
      {manager ? (
        <StateMark agent={manager} />
      ) : (
        <UserRoundIcon aria-hidden="true" className="size-3.5" />
      )}
      <span className="font-medium">{manager ? manager.title : "You"}</span>
      {manager ? <StateName agent={manager} /> : null}
    </>
  );
  return manager ? (
    <Link to="/people/$agentId" params={{ agentId: manager.id }} className={style}>
      {content}
    </Link>
  ) : (
    <Link to="/" className={style}>
      {content}
    </Link>
  );
}

function Sessions({ model }: { model: EntityModel }) {
  const sessions = model.sessions;
  if (sessions.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" className="group -ml-2 text-muted-foreground" />}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="transition-transform group-data-[panel-open]:rotate-90"
        />
        Sessions
        <span className="tabular-nums">{sessions.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1.5 pt-1 pl-2 text-sm">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-2">
              <ClientMark client={session.client} live={session.detached_at === null} />
              <span className="truncate text-muted-foreground">{session.machine}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                <Ago at={session.attached_at} />
                {session.detached_at ? (
                  <>
                    {" – "}
                    <Ago at={session.detached_at} />
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function EntityView(model: EntityModel) {
  const agent = model.entity;
  const { reports } = model;
  const pane = (
    <article
      aria-labelledby="entity-title"
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6"
    >
      <Header model={model} />
      {agent ? <Status agent={agent} /> : null}
      <Pending model={model} />
      <OwnAsks model={model} />
      {reports.chart.length > 0 ? (
        <section aria-label="Below" className="flex flex-col gap-2">
          {total(reports.totals) > 1 ? (
            <ProgressStrip totals={reports.totals} recent={reports.recent} />
          ) : null}
          <Chart nodes={reports.chart} />
        </section>
      ) : null}
      {agent ? <Manager manager={model.manager} /> : null}
      {model.feed.length > 0 ? (
        <section aria-label="Recent work" className="flex flex-col gap-2">
          <Feed entries={model.feed} entity={agent} agents={model.agents} />
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
      <Sessions model={model} />
    </article>
  );
  return <SplitView main={pane} detail={model.thread} />;
}
