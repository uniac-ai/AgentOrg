// The user's page: what waits on the user, a card each, then the organization below. The answer
// or reply being written sits at the foot of the pane once something is in it.

import { InboxIcon } from "lucide-react";
import type { YouModel } from "../control/you.tsx";
import { Below } from "./chart.tsx";
import { Composer } from "./composer.tsx";
import { MessageCard, QuestionCard } from "./messages.tsx";

export function YouView(model: YouModel) {
  return (
    <div className="flex min-h-full flex-col">
      <article
        aria-labelledby="you-title"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 p-4 sm:p-6"
      >
        <h1 id="you-title" className="sr-only">
          You
        </h1>
        <section aria-label="Waiting on you" className="flex flex-col gap-2">
          {model.waiting.length === 0 ? (
            <p className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              <InboxIcon aria-hidden="true" className="size-5" />
              Nothing is waiting on you
            </p>
          ) : (
            model.waiting.map((card) =>
              card.kind === "question" ? (
                <QuestionCard key={card.question.id} {...card} />
              ) : (
                <MessageCard key={card.message.id} {...card} />
              ),
            )
          )}
        </section>
        <Below below={model.below} />
      </article>
      {model.composer ? <Composer {...model.composer} /> : null}
    </div>
  );
}
