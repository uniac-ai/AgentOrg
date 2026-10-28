// A call in full, like a thread beside its channel: who called whom, the calls that led to it, what
// it carries, and how it ended, or for a decision waiting on the user, its options and the answer.

import { ArrowLeftIcon, SendIcon, StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CallRecord } from "../../../src/human/types.ts";
import type { ThreadModel } from "../control/thread.tsx";
import { outputOf } from "../model/activity.ts";
import { CallIcon, CallRoute, callTitle, type Names, outcomeOf } from "./calls.tsx";
import { SR } from "./marks.tsx";
import { Ago } from "./time.tsx";

function Causes({ calls, names }: { calls: CallRecord[]; names: Names }) {
  return (
    <ol aria-label="Led here" className="flex flex-col gap-2 border-l-2 pl-3">
      {calls.map((call) => (
        <li key={call.id} className="flex flex-col gap-0.5 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <CallRoute call={call} names={names} />
            <Ago at={call.created_at} className="text-xs tabular-nums" />
          </span>
          <span>{callTitle(call)}</span>
        </li>
      ))}
    </ol>
  );
}

/** What the call carries beyond its title: a decision's context, any other tool's input. */
function Body({ call }: { call: CallRecord }) {
  if (call.interface === "decide") {
    return <p className="whitespace-pre-wrap">{String(call.input.context ?? "")}</p>;
  }
  if (call.interface === "note" || call.interface === "report") {
    const text = String(call.input.text ?? call.input.outcome ?? "");
    return text.includes("\n") ? <p className="whitespace-pre-wrap">{text}</p> : null;
  }
  const fields = Object.entries(call.input);
  if (fields.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {fields.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 font-mono text-xs break-words whitespace-pre-wrap">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** How the call ended, once it has. */
function Outcome({ call }: { call: CallRecord }) {
  if (call.state === "pending") return null;
  const words = call.interface === "decide" ? outputOf(call).words : undefined;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3",
        call.state === "done" ? "bg-muted/40" : "text-muted-foreground",
      )}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className={cn(call.state === "done" && "font-medium")}>{outcomeOf(call)}</span>
        {call.settled_at ? (
          <Ago at={call.settled_at} className="text-xs text-muted-foreground tabular-nums" />
        ) : null}
      </p>
      {typeof words === "string" && outputOf(call).choice ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{words}</p>
      ) : null}
    </div>
  );
}

function Answer({ model }: { model: ThreadModel }) {
  const { decision, choice, words, sending, error } = model;
  if (!decision) return null;
  return (
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
        {decision.options.map((option, index) => (
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
                {option.label === decision.recommendation ? (
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
      <Button type="submit" disabled={sending || (!choice && !words.trim())} className="self-end">
        <SendIcon aria-hidden="true" />
        Send
      </Button>
    </form>
  );
}

export function ThreadView(model: ThreadModel) {
  const { call, names } = model;
  return (
    <article aria-labelledby="thread-title" className="flex flex-col gap-4 p-4 sm:p-5">
      <header className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" onClick={model.onClose} className="-ml-1.5 shrink-0">
          <ArrowLeftIcon aria-hidden="true" />
          <SR>Close</SR>
        </Button>
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            id="thread-title"
            className="flex items-start gap-2 text-base leading-snug font-semibold"
          >
            <CallIcon call={call} className="mt-1" />
            {callTitle(call)}
          </h2>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CallRoute call={call} names={names} />
            <Ago at={call.created_at} className="text-xs tabular-nums" />
          </p>
        </div>
      </header>
      {model.causes.length > 0 ? <Causes calls={model.causes} names={names} /> : null}
      <Body call={call} />
      <Outcome call={call} />
      <Answer model={model} />
    </article>
  );
}
