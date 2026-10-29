// An actor's page, like a person's pane in a messaging app. In order: who it is, its progress
// (summary, open items, what it produced), its open questions, its reports underneath, and its
// history on request; then what the user sent it that it has not read, above the composer.

import { Link } from "@tanstack/react-router";
import { ArchiveIcon, CheckIcon } from "lucide-react";
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
import type { ActorModel } from "../control/actor.tsx";
import { updatedAt } from "../model/progress.ts";
import { Below } from "./chart.tsx";
import { Composer } from "./composer.tsx";
import { History } from "./history.tsx";
import { Items } from "./items.tsx";
import { OnlineMark, SR, StateMark, StateName } from "./marks.tsx";
import { Links, QuestionCard } from "./messages.tsx";
import { Ago } from "./time.tsx";

function CloseActor({ model }: { model: ActorModel }) {
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
          <AlertDialogTitle>Close {model.member.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked ? "Actors under it are still open." : "Its connections close."}
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
                  <StateMark member={report} />
                  {report.name}
                  <StateName member={report} />
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

function Header({ model }: { model: ActorModel }) {
  const { member } = model;
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <StateMark member={member} />
        <h1 id="actor-title" className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {member.name}
        </h1>
        <StateName member={member} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {member.online ? <OnlineMark /> : null}
          <span className="text-xs text-muted-foreground tabular-nums">
            <SR>Last update </SR>
            <Ago at={updatedAt(member)} />
          </span>
          <CloseActor model={model} />
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{member.purpose}</p>
    </header>
  );
}

/** What the user sent it that it has not read yet, as quiet bubbles above the composer. */
function Sent({ model }: { model: ActorModel }) {
  if (model.sent.length === 0) return null;
  return (
    <ol aria-label="Sent, not read yet" className="flex flex-col items-end gap-1.5">
      {model.sent.map((message) => (
        <li
          key={message.id}
          className="flex max-w-[85%] items-end gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
        >
          <span className="whitespace-pre-wrap">{message.text}</span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Ago at={message.created_at} className="tabular-nums" />
            <CheckIcon aria-hidden="true" className="size-3" />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ActorView(model: ActorModel) {
  return (
    <div className="flex min-h-full flex-col">
      <article
        aria-labelledby="actor-title"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8 [&>*]:shrink-0"
      >
        <Header model={model} />
        {model.summary ? <p className="whitespace-pre-wrap">{model.summary}</p> : null}
        {model.items ? <Items {...model.items} /> : null}
        <Links links={model.links} />
        {model.questions.length > 0 ? (
          <section aria-label="Open questions" className="flex flex-col gap-2">
            {model.questions.map((card) => (
              <QuestionCard key={card.question.id} {...card} />
            ))}
          </section>
        ) : null}
        <Below below={model.below} />
        <History {...model.history} />
        <Sent model={model} />
      </article>
      <Composer {...model.composer} />
    </div>
  );
}
