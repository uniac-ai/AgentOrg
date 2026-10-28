// An actor's history, shown only when asked for: its earlier progress, the questions it asked and
// was asked with their answers, and its messages with any position, newest first, a line each. An
// answer the asker recorded from the user's words in its own session reads as recorded by the
// asker, quoting them, never as the user's own. A message shows whether it was read.

import {
  CheckCheckIcon,
  CheckIcon,
  CornerDownRightIcon,
  HistoryIcon,
  MessageCircleQuestionIcon,
  NotebookPenIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MessageRecord, QuestionRecord } from "../../../src/human/types.ts";
import type { HistoryEntry } from "../model/messages.ts";
import { SR, StateShape } from "./marks.tsx";
import { firstLine, type Names, nameOf } from "./messages.tsx";
import { Ago } from "./time.tsx";

export interface HistoryModel {
  /** Undefined until it is asked for. */
  entries: HistoryEntry[] | undefined;
  loading: boolean;
  names: Names;
  more: boolean;
  onOpen: () => void;
  onShowMore: () => void;
}

/** Who wrote to whom, as "from → to". */
function Route({ from, to, names }: { from: string; to: string; names: Names }) {
  return (
    <>
      <span className="truncate">{nameOf(from, names)}</span>
      <span aria-hidden="true">→</span>
      <SR>to</SR>
      <span className="truncate">{nameOf(to, names)}</span>
    </>
  );
}

function Question({ question, names }: { question: QuestionRecord; names: Names }) {
  const { answer } = question;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <MessageCircleQuestionIcon aria-hidden="true" className="size-3" />
        <Route from={question.from} to={question.to} names={names} />
      </span>
      <span className="line-clamp-2">{firstLine(question.text)}</span>
      {answer ? (
        <span className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground">
          {answer.recorded ? (
            <span title="Recorded by the asker" className="inline-flex shrink-0 self-center">
              <NotebookPenIcon aria-hidden="true" className="size-3" />
            </span>
          ) : (
            <CornerDownRightIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
          )}
          <span className="shrink-0 text-xs">
            {answer.recorded ? `${nameOf(answer.by, names)} recorded` : nameOf(answer.by, names)}
            <SR>: </SR>
          </span>
          <span className="line-clamp-2 min-w-0">
            {answer.choice ? (
              <span className="font-medium text-foreground">{answer.choice} </span>
            ) : null}
            {answer.text ? (answer.recorded ? `“${answer.text}”` : answer.text) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function Message({ message, names }: { message: MessageRecord; names: Names }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {message.reply_to !== null ? (
          <CornerDownRightIcon aria-hidden="true" className="size-3" />
        ) : null}
        <Route from={message.from} to={message.to} names={names} />
        {message.read_at ? (
          <span title="Read" className="inline-flex">
            <CheckCheckIcon aria-hidden="true" className="size-3" />
            <SR>, read</SR>
          </span>
        ) : (
          <span title="Not read yet" className="inline-flex">
            <CheckIcon aria-hidden="true" className="size-3" />
            <SR>, not read yet</SR>
          </span>
        )}
      </span>
      <span className="line-clamp-2">{firstLine(message.text)}</span>
    </span>
  );
}

const keyOf = (entry: HistoryEntry) =>
  entry.kind === "progress"
    ? `progress-${entry.version.version}`
    : entry.kind === "question"
      ? entry.question.id
      : entry.message.id;

export function History(model: HistoryModel) {
  if (model.entries === undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        disabled={model.loading}
        onClick={model.onOpen}
      >
        <HistoryIcon aria-hidden="true" />
        History
      </Button>
    );
  }
  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-2">
      <h2
        id="history-title"
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
      >
        <HistoryIcon aria-hidden="true" className="size-4" />
        History
      </h2>
      <ol className="flex flex-col">
        {model.entries.map((entry, index) => (
          <li
            key={keyOf(entry)}
            className={cn(
              "flex items-start gap-3 border-l py-2 pl-4 text-sm",
              index === 0 && "pt-0",
            )}
          >
            {entry.kind === "progress" ? (
              <span className="flex min-w-0 flex-1 items-start gap-2">
                <StateShape state={entry.version.state ?? "idle"} className="mt-1" />
                <SR>{`${entry.version.state ?? "idle"}: `}</SR>
                <span className="line-clamp-2 min-w-0 text-muted-foreground">
                  {entry.version.summary}
                </span>
              </span>
            ) : (
              <span className="min-w-0 flex-1">
                {entry.kind === "question" ? (
                  <Question question={entry.question} names={model.names} />
                ) : (
                  <Message message={entry.message} names={model.names} />
                )}
              </span>
            )}
            <Ago at={entry.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
          </li>
        ))}
      </ol>
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
