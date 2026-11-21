// The decision the agent puts to its party under a reply, served as one card: one rounded card, the
// agent's question at its top, and a full-width outlined row for each choice. Plain, one question's
// choices alone, a tap picks at once and is final. Once answered, or passed over because the party
// wrote instead or a newer card came, the card stays where it is, showing what became of it.
import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { Card } from "../ui/card.tsx";
import type { Ask } from "./data.ts";

type Question = Ask["questions"][number];
type Choice = Question["choices"][number];

/** A card's question when the card is plain: one question, one pick, no confirm. */
export const plainOf = (ask: Ask): Question | undefined => {
  const [only, ...more] = ask.questions;
  if (!only || more.length > 0 || "many" in only || ("confirm" in ask && ask.confirm)) return;
  return only;
};

/** Open, answered with the picks the answer carries, or passed over. */
export type CardState =
  | { kind: "open" }
  | { kind: "answered"; picks: readonly number[] }
  | { kind: "passed" };

/** One row's outline and words. */
const ROW =
  "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[15px] leading-5";

export function AskCard({
  question,
  agent,
  state,
  onPick,
}: {
  question: Question;
  agent: string;
  state: CardState;
  /** Picks a choice, by its place; none where the conversation is only read. */
  onPick?: ((choice: number) => void) | undefined;
}) {
  return (
    <Card
      role="group"
      aria-label={`${agent} asks`}
      size="sm"
      data-ask={state.kind}
      className="gap-3 p-3"
    >
      <div className="flex flex-col gap-2.5">
        {question.question && <p className="px-1 text-[15px] leading-5">{question.question}</p>}
        {state.kind === "open" ? (
          <Plain question={question} agent={agent} onPick={onPick} />
        ) : (
          <Settled
            question={question}
            agent={agent}
            picks={state.kind === "answered" ? state.picks : []}
          />
        )}
      </div>
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
    <div
      role="radiogroup"
      aria-label={question.question ?? `${agent}'s choices`}
      aria-disabled
      className="flex flex-col gap-2"
    >
      {question.choices.map((choice, n) => {
        const picked = picks.includes(n);
        return (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a choice settled, read with its group and never pressed again.
          <div
            key={choice.label}
            role="radio"
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
