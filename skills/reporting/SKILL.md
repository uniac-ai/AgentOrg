---
name: reporting
description: How a session conveys its position's work — to its manager, another position or the user — through its progress, its questions and its messages in AgentOrg, and through what it says in its own session. Load whenever a session reports, asks for a decision or approval, ends a turn with something for its reader, or sets its progress.
---

# Reporting

A session reaches its readers in two ways. What it writes in its own session is read by whoever is in that session, often nobody. The record, held by AgentOrg, is what the organization reads: the position's progress, a public snapshot of where it stands; its questions, public and waiting only on their addressee; and its messages, private to their two parties, the manager of either, and the user. Anything that someone else must read or act on goes into the record, written once, and the session's own text never holds the only copy of it. A long text wastes the reader's context and hides what needs them, so whatever a message leaves out lives in progress or behind a link.

When a session reports or asks, and to whom, belongs to the task-execution skill. This skill says what progress, a question and a message contain. Tools are named as the tools are; the command line runs each with spaces for underscores.

## Progress

`progress_set` replaces the fields it is given in the position's one snapshot. Set it at the start and at each milestone; it is current state, replaced in place, never a log.

- **`state`:** `running`, `waiting`, `blocked` or `review`.
- **`summary`:** a short current paragraph at the position's own level. A manager writes four lines where its report writes forty.
- **`items`:** the open workstreams or steps, in order. Each has a `title` and a `state` (`planned`, `running`, `waiting`, `blocked` or `review`), and may have a `summary`, `links`, an `owner` (the position that holds it: a report, or a position elsewhere that took a handoff) and `waits_on` (another item, a position, or text such as "the consumer release"). A step list is items with a title and a state alone. Done items drop off.
- **`links`:** what the position produced: pull requests, pages, documents.

A manager's progress is its own synthesis: the ordering and dependencies across its reports, the decisions it settled, the work that spans several, and an outcome agreed with a peer, such as a release order. Its reports' snapshots sit beneath it as drill-down and never stand in for it. Progress is public to the whole organization, so nothing private goes in it: never a transcript, logs, raw infrastructure text or reasoning.

## Questions

A question is its own public record, asked with `question_ask` to the manager, its default, or to a direct report, never to any other position, and read with `questions`. Its `text` states the decision in a sentence or two that stand without the conversation. Two to six options name the choices, and the recommendation is the label of one of them. A question is written once: the same record is the addressee's "waiting on you" card, the asker's open question beside its progress, and the history once answered, so it is never also restated in a message or a document, nor sent again while it is open.

- **Escalating:** a manager that cannot settle a report's question asks a new question in its own terms, with its recommendation and the context only it sees, and `cause` naming the report's question. Once it has the answer, it answers the report.
- **Approvals:** a decision only the user may take names the root as its `answerer`. AgentOrg checks who answers, so a relayed "the user said yes" cannot satisfy it.
- **Answering:** `question_answer` naming the questions, with an optional `choice` and `text`. One answer may resolve several questions, and may reject the options and reframe them; that still resolves them. When the user answers in the asking session, the session records it at once on its own question, with the user's words as `text` and `recorded: true`; that is refused for words typed before the question and for an approval with `answerer`, which its answerer answers in the web app.
- **After the answer:** the session that asked acts on it and says in its next message what it did.

## Messages

A message is private correspondence, sent with `message_send` to any position, and a reply names what it replies to with `reply_to`: a brief, a steer, an FYI, a finding with its evidence, a rework brief, or a final report. A final report gives the outcome at the sender's own level, links its artifacts, and shows a user interface change with before-and-after screenshots of the same view at the same width, never a prose list of changes. The manager's review of a report is its reply, which accepts the result or sends it back with a rework brief. `read_at` tells the sender the message reached its addressee's session. A message is private, so an outcome others need, such as an agreed order, goes into progress too.

## What a session writes in its own session

The text a session shows its own reader leads with what waits on that reader — a decision, an approval, a session to start, a step — one line each with where to take it, and then the outcome and state, short. It never replaces the record: a question for the user is still a question in AgentOrg, which the user sees in the web app and in the session, and a final report is still a message to the manager.

## The web app

The web app shows the user each position's progress and open questions, with its reports beneath, and the questions waiting on the user first. The user answers there, or in the asking session, which records the answer.

## Organization specifics

Names, pronouns, conventions and where an organization keeps its status documents belong to the adopter's own skill layer, loaded alongside this one. It adds to these rules and changes none of them.
