# Memory

An agent's memory, as a plugin of its executor: a few short lines the agent writes itself. It is
loaded only in an agent whose settings name it, and an agent without it is told and offered
nothing of it.

## What the model sees

- **One function, `memory__edit`,** offered to each piece of the agent's work, and to the agent's
  main loop when it decides on a message, which may call it beside its answer. `action` is `add`,
  `replace` or `remove`; `replace` and `remove` take a line's `id`, `add` and `replace` its `text`.
  Its description is one sentence.
- **One section of its instructions, `## Memory`,** in every request while the agent holds memory:
  its words (`WORDS` in `src/index.ts`), on what a line is for, when to write one, what never to
  keep, and whose the lines are; then `What you remember:` and each line as `- [id] text (day)`, or
  `You remember nothing yet.` The main loop is told it too. A line's day is the day where the agent
  runs.

## What it costs

- **The function:** roughly 90 tokens in the tools of each request that offers it. Counted by
  hand, not measured.
- **The section:** its words, about 770 characters, then the lines as they are told, with their
  ids and days, which hold at most 2,000 characters together.
- **The prompt cache:** the section changes only when a line is added, replaced or removed. A
  change is read from the next turn; a turn under way keeps what it was told.

## Where the lines are kept

In the plugin's own part of the agent's store, `plugin/memory/lines`. Unloading the plugin leaves
them: an agent that holds it again finds its lines. A line's id is never used for another line.
Changes are made one at a time, and one the store didn't keep is refused and changes nothing.

## For the agent's other plugins

Memory provides the service `memory` in its agent's context: `read`, `add`, `replace` and `remove`,
with the same limit as the model's function. A plugin names `memory` in its `inject` to use it.
