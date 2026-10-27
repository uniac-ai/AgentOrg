// An agent's pane, like a person's conversation: who it is and whether a session is on it, what
// waits on it pinned at the top, then its recent work. The ask open beside it shows as a thread.

import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  OctagonAlertIcon,
  StickyNoteIcon,
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
import { cn } from "@/lib/utils";
import type { AgentModel } from "../control/agent.tsx";
import { Feed } from "./feed.tsx";
import { ClientMark, SR, StateMark, StateName } from "./marks.tsx";
import { SplitView } from "./split.tsx";
import { nameOf, Route } from "./thread.tsx";
import { Ago } from "./time.tsx";

const isWebLink = (url: string) => /^https?:\/\//i.test(url);

/** Close the agent, after a confirmation that says what closing does; while agents under it
 * are open, the confirmation names them instead and cannot be given. */
function CloseAgent({ model }: { model: AgentModel }) {
  const { agent } = model.detail;
  const blocked = model.openChildren.length > 0;
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
              : model.openAsks === 0
                ? "Its session detaches."
                : `Its session detaches, and its ${model.openAsks === 1 ? "open ask is" : `${model.openAsks} open asks are`} withdrawn.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <ul className="flex flex-col gap-1 text-sm">
            {model.openChildren.map((child) => (
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
            disabled={blocked || model.closing}
            onClick={model.onCloseAgent}
          >
            Close agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Header({ model }: { model: AgentModel }) {
  const { agent } = model.detail;
  const session = model.summary?.attached_session;
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <StateMark agent={agent} />
        <h1 id="agent-title" className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {agent.title}
        </h1>
        <StateName agent={agent} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {session ? <ClientMark client={session.client} live /> : null}
          {model.summary ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              <SR>Last active </SR>
              <Ago at={model.summary.last_activity_at} />
            </span>
          ) : null}
          {agent.state === "closed" ? null : <CloseAgent model={model} />}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{agent.purpose}</p>
    </header>
  );
}

function Status({ model }: { model: AgentModel }) {
  const status = model.detail.agent.status;
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

/** What waits on the agent, pinned above its feed; empty, it takes no room. */
function Pinned({ model }: { model: AgentModel }) {
  const { asks, messages } = model.pending;
  const id = model.detail.agent.id;
  if (asks.length + messages.length === 0) return null;
  return (
    <section
      aria-label="Waiting on this agent"
      className="flex flex-col gap-0.5 rounded-lg border border-state-waiting/30 bg-state-waiting/5 p-1.5"
    >
      {asks.map((ask) => (
        <Link
          key={ask.id}
          data-row
          to="/people/$agentId/asks/$askId"
          params={{ agentId: id, askId: ask.id }}
          aria-current={model.openAsk === ask.id ? "true" : undefined}
          className={cn(
            "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            model.openAsk === ask.id && "bg-muted",
          )}
        >
          <MessageCircleQuestionIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-state-waiting"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2 font-medium">{ask.title}</span>
            <span className="text-xs text-muted-foreground">
              <Route ask={ask} agents={model.agents} />
            </span>
          </span>
          <Ago at={ask.opened_at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
        </Link>
      ))}
      {messages.map((message) => {
        const Icon = message.kind === "report" ? FileTextIcon : StickyNoteIcon;
        return (
          <div key={message.id} className="flex items-start gap-2.5 px-2.5 py-2 text-sm">
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <SR>{message.kind === "report" ? "Unreviewed report: " : "Unread note: "}</SR>
              <span className="line-clamp-3 whitespace-pre-line">{message.body}</span>
              <span className="text-xs text-muted-foreground">
                {nameOf(message.from, model.agents)}
              </span>
            </span>
            <Ago
              at={message.sent_at}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            />
          </div>
        );
      })}
    </section>
  );
}

function Sessions({ model }: { model: AgentModel }) {
  const { sessions } = model.detail;
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

export function AgentView(model: AgentModel) {
  const { agent } = model.detail;
  const pane = (
    <article
      aria-labelledby="agent-title"
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6"
    >
      <Header model={model} />
      <Status model={model} />
      <Pinned model={model} />
      {model.feed.length > 0 ? (
        <section aria-label="Recent work" className="flex flex-col gap-2">
          <Feed entries={model.feed} agent={agent} agents={model.agents} />
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
