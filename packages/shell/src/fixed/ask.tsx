// The decision the agent puts to its party under a reply, served as one card: one rounded card, the
// agent's question at its top, and a full-width outlined row for each choice. Plain, one question's
// choices alone, a tap picks at once and is final. With a confirm, where several may be picked, or
// with several questions, each on a tab of its own, the picks are held, changeable, until Confirm
// sends them. Once answered, or passed over because the party wrote instead or a newer card came,
// the card stays where it is, showing what became of it.
import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "../ui/field.tsx";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import type { Ask } from "./data.ts";

type Question = Ask["questions"][number];
type Choice = Question["choices"][number];

/** Whether a question takes several picks. */
const isMany = (question: Question) => "many" in question && question.many === true;

/** Open, answered with the picks the answer carries for each question, or passed over. */
export type CardState =
  | { kind: "open" }
  | { kind: "answered"; picks: readonly (readonly number[])[] }
  | { kind: "passed" };

/** One row's outline and words. */
const ROW =
  "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[15px] leading-5";

export function AskCard({
  ask,
  agent,
  state,
  onAnswer,
}: {
  ask: Ask;
  agent: string;
  state: CardState;
  /**
   * Answers it with the choices picked for each question, by their places; none where the
   * conversation is only read.
   */
  onAnswer?: ((picks: number[][]) => void) | undefined;
}) {
  const all = ask.questions;
  // Several picks, and several questions, always confirm, as a card asked to does.
  const confirm = all.length > 1 || all.some(isMany) || ("confirm" in ask && ask.confirm === true);
  /** The picks held until Confirm, for each question, by their places. */
  const [held, setHeld] = useState<number[][]>(() => all.map(() => []));
  /** The question shown, where there are several: the first not answered yet. */
  const [at, setAt] = useState("0");
  const hold = (n: number, picks: number[]) => {
    setHeld((was) => was.map((one, i) => (i === n ? picks : one)));
    // One pick of several questions moves on to the next not answered yet.
    const question = all[n];
    if (all.length > 1 && question && !isMany(question)) {
      const next = all.findIndex((_, i) => i > n && (held[i]?.length ?? 0) === 0);
      if (next !== -1) setAt(String(next));
    }
  };
  const answered = (n: number) =>
    ((state.kind === "answered" ? state.picks[n] : held[n])?.length ?? 0) > 0;
  const body = (question: Question, n: number) => (
    <div className="flex flex-col gap-2.5">
      {question.question && <p className="px-1 text-[15px] leading-5">{question.question}</p>}
      {state.kind !== "open" ? (
        <Settled
          question={question}
          agent={agent}
          picks={state.kind === "answered" ? (state.picks[n] ?? []) : []}
        />
      ) : !confirm ? (
        <Plain
          question={question}
          agent={agent}
          onPick={onAnswer && ((pick) => onAnswer([[pick]]))}
        />
      ) : isMany(question) ? (
        <Several
          question={question}
          agent={agent}
          picks={held[n] ?? []}
          disabled={!onAnswer}
          onChange={(picks) => hold(n, picks)}
        />
      ) : (
        <One
          question={question}
          agent={agent}
          pick={held[n]?.[0]}
          disabled={!onAnswer}
          onChange={(pick) => hold(n, [pick])}
        />
      )}
    </div>
  );
  return (
    <Card
      role="group"
      aria-label={`${agent} asks`}
      size="sm"
      data-ask={state.kind}
      className="gap-3 p-3"
    >
      {all.length > 1 ? (
        <Tabs value={at} onValueChange={setAt} className="gap-3">
          {/* Each question's name, a check once it has its pick. */}
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            {all.map((question, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a card's questions never move.
              <TabsTrigger key={n} value={String(n)} className="flex-none px-2">
                {question.header ?? `Question ${n + 1}`}
                {answered(n) && <CheckIcon aria-label="answered" className="size-3.5" />}
              </TabsTrigger>
            ))}
          </TabsList>
          {all.map((question, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a card's questions never move.
            <TabsContent key={n} value={String(n)}>
              {body(question, n)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        all[0] && body(all[0], 0)
      )}
      {confirm && state.kind === "open" && (
        <div className="flex justify-end">
          <Button
            size="sm"
            className="rounded-full px-4"
            disabled={!all.every((_, n) => (held[n]?.length ?? 0) > 0)}
            onClick={() => onAnswer?.(held.map((picks) => [...picks].sort((a, b) => a - b)))}
          >
            Confirm
          </Button>
        </div>
      )}
    </Card>
  );
}

/** A choice's words, and the line under them if it has one. */
function Words({ choice }: { choice: Choice }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span>{choice.label}</span>
      {choice.detail && (
        <span className="text-[13px] leading-[18px] text-muted-foreground">{choice.detail}</span>
      )}
    </span>
  );
}

/**
 * Plain: a tap picks at once and is final. The rows are a radio group; arrow keys move between
 * them and Enter or Space picks, so moving never picks by itself.
 */
function Plain({
  question,
  agent,
  onPick,
}: {
  question: Question;
  agent: string;
  onPick?: ((choice: number) => void) | undefined;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent) => {
    const rows = [...(group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step || at === -1) return;
    event.preventDefault();
    rows[(at + step + rows.length) % rows.length]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={question.question ?? `${agent}'s choices`}
      className="flex flex-col gap-2"
      onKeyDown={move}
    >
      {question.choices.map((choice, n) => (
        // biome-ignore lint/a11y/useSemanticElements: a native radio picks as the arrows move; here moving never picks, a press does.
        <button
          key={choice.label}
          type="button"
          role="radio"
          aria-checked={false}
          tabIndex={n === 0 ? 0 : -1}
          disabled={!onPick}
          onClick={() => onPick?.(n)}
          className={`${ROW} border-[var(--line-strong)] outline-none hover:bg-[var(--hover)] focus-visible:ring-3 focus-visible:ring-ring/50`}
        >
          <Words choice={choice} />
        </button>
      ))}
    </div>
  );
}

/**
 * Answered or passed over: the rows stay in place, nothing pressable. A pick's outline solid and
 * bright, with a filled check at its end; the rest dimmed, their outlines dashed.
 */
function Settled({
  question,
  agent,
  picks,
}: {
  question: Question;
  agent: string;
  picks: readonly number[];
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a radio group, or a group of checkboxes where several are picked.
    <div
      role={isMany(question) ? "group" : "radiogroup"}
      aria-label={question.question ?? `${agent}'s choices`}
      aria-disabled
      className="flex flex-col gap-2"
    >
      {question.choices.map((choice, n) => {
        const picked = picks.includes(n);
        return (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive lint/a11y/useAriaPropsSupportedByRole: a choice settled, a radio or a checkbox, read with its group and never pressed again.
          <div
            key={choice.label}
            role={isMany(question) ? "checkbox" : "radio"}
            aria-checked={picked}
            aria-disabled
            className={`${ROW} ${picked ? "border-foreground text-foreground" : "border-dashed border-[var(--line-strong)] opacity-50"}`}
          >
            <Words choice={choice} />
            {picked && (
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[var(--canvas)]"
              >
                <CheckIcon className="size-3.5" strokeWidth={3} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** With a confirm, one pick: a choice card for each, a radio at its end; changeable until Confirm. */
function One({
  question,
  agent,
  pick,
  disabled,
  onChange,
}: {
  question: Question;
  agent: string;
  pick: number | undefined;
  disabled: boolean;
  onChange(choice: number): void;
}) {
  const id = useId();
  return (
    <RadioGroup
      value={pick === undefined ? "" : String(pick)}
      onValueChange={(value) => onChange(Number(value))}
      aria-label={question.question ?? `${agent}'s choices`}
      disabled={disabled}
      className="gap-2"
    >
      {question.choices.map((choice, n) => (
        <Choose key={choice.label} id={`${id}-${n}`} choice={choice}>
          <RadioGroupItem value={String(n)} id={`${id}-${n}`} />
        </Choose>
      ))}
    </RadioGroup>
  );
}

/** Several picks: the same rows with a checkbox at each end; changeable until Confirm. */
function Several({
  question,
  agent,
  picks,
  disabled,
  onChange,
}: {
  question: Question;
  agent: string;
  picks: readonly number[];
  disabled: boolean;
  onChange(picks: number[]): void;
}) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: one question's choices with its name, not a form.
    <div
      role="group"
      aria-label={question.question ?? `${agent}'s choices`}
      className="flex flex-col gap-2"
    >
      {question.choices.map((choice, n) => (
        <Choose key={choice.label} id={`${id}-${n}`} choice={choice}>
          <Checkbox
            id={`${id}-${n}`}
            checked={picks.includes(n)}
            disabled={disabled}
            onCheckedChange={(on) =>
              onChange(on ? [...picks, n] : picks.filter((one) => one !== n))
            }
          />
        </Choose>
      ))}
    </div>
  );
}

/** A choice card (a label holding a field), drawn as the plain card's rows; held, its outline is solid and bright. */
function Choose({ id, choice, children }: { id: string; choice: Choice; children: ReactNode }) {
  return (
    <FieldLabel
      htmlFor={id}
      className="w-full rounded-xl border-[var(--line-strong)] *:data-[slot=field]:px-4 *:data-[slot=field]:py-3 has-data-checked:border-foreground has-data-checked:bg-transparent dark:has-data-checked:border-foreground dark:has-data-checked:bg-transparent"
    >
      <Field orientation="horizontal" className="items-center">
        <FieldContent className="gap-0.5">
          <FieldTitle className="text-[15px] leading-5 font-normal">{choice.label}</FieldTitle>
          {choice.detail && (
            <FieldDescription className="text-[13px] leading-[18px]">
              {choice.detail}
            </FieldDescription>
          )}
        </FieldContent>
        {children}
      </Field>
    </FieldLabel>
  );
}
