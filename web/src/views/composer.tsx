// The composer at the foot of a pane, as in a messaging app: the words, and when it answers or
// replies, what it answers as chips, with the options the questions all share to choose from.
// ⌘/Ctrl+Enter sends, and Esc leaves it.

import { SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
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
              <li key={target.id} className="min-w-0 max-w-full">
                <Badge variant="secondary" className="h-auto max-w-full gap-1 pr-0.5">
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
                </Badge>
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
        <InputGroup className="items-end">
          <InputGroupTextarea
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
            className="max-h-48 min-h-12 text-base sm:text-sm"
          />
          <InputGroupAddon align="inline-end" className="pb-2">
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              disabled={model.sending || empty}
            >
              <SendIcon aria-hidden="true" />
              <SR>Send</SR>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {model.error ? (
          <p role="alert" className="text-sm text-destructive">
            {model.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
