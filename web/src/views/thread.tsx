// An ask in full, like a thread beside its channel: who asked whom, the chain it carries up, its
// options, and the answer, given here or already on record.

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  SendIcon,
  StarIcon,
  UserRoundCheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AgentRecord, AskRecord } from "../../../src/page/types.ts";
import type { ThreadModel } from "../control/thread.tsx";
import type { Chain } from "../model/activity.ts";
import { SR } from "./marks.tsx";
import { Ago } from "./time.tsx";

export const nameOf = (id: string | null, agents: ReadonlyMap<string, AgentRecord>) =>
  id === null ? "you" : (agents.get(id)?.title ?? id);

/** Who asked whom, as "asker → addressee". */
export function Route({
  ask,
  agents,
}: {
  ask: AskRecord;
  agents: ReadonlyMap<string, AgentRecord>;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate">{nameOf(ask.agent, agents)}</span>
      <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
      <SR> asked </SR>
      <span className="truncate">{nameOf(ask.to, agents)}</span>
    </span>
  );
}

function ChainList({
  chains,
  agents,
}: {
  chains: Chain[];
  agents: ReadonlyMap<string, AgentRecord>;
}) {
  return (
    <ol aria-label="Carries up" className="flex flex-col gap-2 border-l-2 pl-3">
      {chains.map(({ ask, carries }) => (
        <li key={ask.id} className="flex flex-col gap-0.5 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Route ask={ask} agents={agents} />
            <Ago at={ask.opened_at} className="text-xs tabular-nums" />
          </span>
          <span>{ask.title}</span>
          {carries.length > 0 ? <ChainList chains={carries} agents={agents} /> : null}
        </li>
      ))}
    </ol>
  );
}

/** What the record holds once the ask is settled. */
function Outcome({ ask, agents }: { ask: AskRecord; agents: ReadonlyMap<string, AgentRecord> }) {
  const answer = ask.answer;
  if (ask.state === "withdrawn" || answer === null) {
    return (
      <p className="text-sm text-muted-foreground line-through decoration-muted-foreground/50">
        Withdrawn
      </p>
    );
  }
  const steppedIn = answer.by === null && ask.to !== null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-3">
      <p className="flex flex-wrap items-center gap-2">
        <SR>{steppedIn ? "You stepped in: " : "Answered: "}</SR>
        {answer.choice ? <span className="font-medium">{answer.choice}</span> : null}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            steppedIn ? "bg-state-waiting/15 text-state-waiting" : "bg-muted text-muted-foreground",
          )}
        >
          {steppedIn ? <UserRoundCheckIcon aria-hidden="true" className="size-3" /> : null}
          <SR>by </SR>
          {nameOf(answer.by, agents)}
        </span>
        <Ago at={answer.answered_at} className="text-xs text-muted-foreground tabular-nums" />
      </p>
      {answer.words ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{answer.words}</p>
      ) : null}
    </div>
  );
}

export function ThreadView(model: ThreadModel) {
  const { ask, chain, agents, choice, words, sending, error } = model;
  const steppingIn = ask.to !== null;
  return (
    <article aria-labelledby="thread-title" className="flex flex-col gap-4 p-4 sm:p-5">
      <header className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" onClick={model.onClose} className="-ml-1.5 shrink-0">
          <ArrowLeftIcon aria-hidden="true" />
          <SR>Close</SR>
        </Button>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="thread-title" className="text-base leading-snug font-semibold">
            {ask.title}
          </h2>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Route ask={ask} agents={agents} />
            <Ago at={ask.opened_at} className="text-xs tabular-nums" />
          </p>
        </div>
      </header>
      {chain.carries.length > 0 ? <ChainList chains={chain.carries} agents={agents} /> : null}
      <p className="whitespace-pre-wrap">{ask.context}</p>
      {ask.state !== "open" ? (
        <Outcome ask={ask} agents={agents} />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            model.onSend();
          }}
        >
          <RadioGroup
            aria-labelledby="thread-title"
            value={choice ?? null}
            onValueChange={(value) => model.onChoose(value as string)}
          >
            {ask.options.map((option, index) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's radio renders the control inside.
              <label
                key={option.label}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/60",
                  choice === option.label && "border-primary bg-muted/60",
                )}
              >
                <RadioGroupItem value={option.label} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 font-medium">
                    {option.label}
                    {option.label === ask.recommendation ? (
                      <>
                        <StarIcon
                          aria-hidden="true"
                          className="size-3.5 fill-state-closed text-state-closed"
                        />
                        <SR>, recommended</SR>
                      </>
                    ) : null}
                  </span>
                  {option.detail ? (
                    <span className="text-sm text-muted-foreground">{option.detail}</span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className="hidden font-mono text-xs text-muted-foreground sm:block"
                >
                  {index + 1}
                </span>
              </label>
            ))}
          </RadioGroup>
          <Textarea
            aria-label="Note"
            placeholder="Note"
            value={words}
            maxLength={4000}
            onChange={(event) => model.onWrite(event.target.value)}
            className="min-h-16"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={sending || (!choice && !words.trim())}
            className={cn(
              "self-end",
              steppingIn && "bg-state-waiting text-white hover:bg-state-waiting/90",
            )}
          >
            {steppingIn ? (
              <UserRoundCheckIcon aria-hidden="true" />
            ) : (
              <SendIcon aria-hidden="true" />
            )}
            {steppingIn ? `Answer for ${nameOf(ask.to, agents)}` : "Send"}
          </Button>
        </form>
      )}
    </article>
  );
}
