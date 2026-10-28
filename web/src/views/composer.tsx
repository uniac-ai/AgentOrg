// The composer at the foot of a pane, as in a messaging app: the words, and when it answers or
// replies, what it answers as chips, with the options the questions all share to choose from.
// ⌘/Ctrl+Enter sends, and Esc leaves it.

import { SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SR } from "./marks.tsx";
import { firstLine, type Names, nameOf } from "./messages.tsx";

/** A question or a message being answered: who sent it, and its words. */
export interface ComposerTarget {
  id: string;
  from: string;
  text: string;
}

export interface ComposerModel {
  /** What it answers; empty for a new message. */
  targets: ComposerTarget[];
  names: Names;
  /** The options every target shares. */
  choices: string[];
  choice: string | undefined;
  words: string;
  placeholder: string;
  sending: boolean;
  /** Why the last send was refused. */
  error: string | undefined;
  /** Changes each time the composer should take focus. */
  focus: number;
  onChoose: (label: string | undefined) => void;
  onWrite: (text: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  onLeave: () => void;
}

export function Composer(model: ComposerModel) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (model.focus > 0) field.current?.focus();
  }, [model.focus]);
  const empty = !model.words.trim() && model.choice === undefined;
  return (
    <form
      aria-label={model.targets.length > 0 ? "Reply" : model.placeholder}
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        model.onSend();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {model.targets.length > 0 ? (
          <ul aria-label="Answers" className="flex flex-wrap gap-1.5">
            {model.targets.map((target) => (
              <li
                key={target.id}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-xs"
              >
                <span className="shrink-0 font-medium">{nameOf(target.from, model.names)}</span>
                <span className="truncate text-muted-foreground">{firstLine(target.text)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => model.onRemove(target.id)}
                >
                  <XIcon aria-hidden="true" />
                  <SR>Leave out</SR>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {model.choices.length > 0 ? (
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Choice</legend>
            {model.choices.map((label) => (
              <Button
                key={label}
                type="button"
                size="sm"
                variant={model.choice === label ? "default" : "outline"}
                aria-pressed={model.choice === label}
                onClick={() => model.onChoose(model.choice === label ? undefined : label)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={field}
            aria-label={model.placeholder}
            placeholder={model.placeholder}
            value={model.words}
            maxLength={4000}
            onChange={(event) => model.onWrite(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                model.onSend();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
                model.onLeave();
              }
            }}
            className={cn("max-h-48 min-h-10 resize-none bg-background", "dark:bg-input/30")}
          />
          <Button type="submit" size="icon" disabled={model.sending || empty}>
            <SendIcon aria-hidden="true" />
            <SR>Send</SR>
          </Button>
        </div>
        {model.error ? (
          <p role="alert" className="text-sm text-destructive">
            {model.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
