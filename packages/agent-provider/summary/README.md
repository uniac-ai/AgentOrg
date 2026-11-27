# Summary

What writes a piece of work's summary once its earlier steps are past the budget, as a capability
of its executor: `summary()`. Every agent holds it, mounted by its executor as it opens the agent;
no tree names it. It provides the service `summary`, the looper's `Summarizer`, whose `summarize`
the engine calls each time a summary is due.

## What the model sees

- **Nothing in the agent's own requests.** A summary is sent to the model as the looper sends it.
- **Requests of its own,** asked through the turn's own way to ask, so a stop cancels them: pi's
  system prompt and one user message, no tools. What the work read since its last summary is
  written out as text, each call's arguments and output cut at 2,000 characters, in pieces of at
  most 160,000 characters, summarized a piece at a time with pi's first prompt and then its update
  prompt; past eight pieces the oldest are left out. The part of an exchange before the cut, when
  the cut falls inside one, is summarized apart with pi's turn-prefix prompt and set after the rest.

## What it gives back

A summary of at most 16,000 characters, with the files the calls read and changed, as the host's
`files` names them, carried from the summary before, each list its newest within 900 characters.
An empty summary is refused, and the turn takes the looper's cut instead.

## For the agent's other plugins

Another capability may take this one off, after which what is over the budget is cut, and may then
provide `summary` in its place.

Its prompts and the way it writes a conversation out are adapted from pi (MIT): see `NOTICE`.
