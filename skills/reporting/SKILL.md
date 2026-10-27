---
name: reporting
description: How a session conveys its agent's work to its reader — the manager, which is another agent or the user — through a message every time, while the agentorg service holds the record of each agent's status, asks and messages. Load whenever a session reports, asks for a decision or approval, ends a turn with something for its reader, or sets its agent's status.
---

# Reporting

A session reaches its reader through two channels. The message, sent every time, is what an employee sends their manager: it grabs attention and summarizes. The record, held by the agentorg service, is the file the employee keeps current so anyone can see the work's state at any time: each agent's status is its workstream, every decision for the manager is an ask, and every note or report to the manager is a message. The decisions page shows the user what waits on them and lets them inspect the rest. A long report in chat wastes the reader's context and hides what needs them, so whatever the message leaves out lives in the record or behind a link.

How agents form a hierarchy, and when a session reports or asks and to whom, belong to the task-execution skill. This skill says what a status, an ask and a message contain. Tools are named as MCP tools; the command line runs each as `agentorg <subject> <verb>`, such as `agentorg ask open`.

## The message

Every report is a message through the client's delivery mechanism (see the client notes below). It carries only what the reader needs and cannot already see, and stands on its own for a reader who has not followed the traffic between sessions, the user included. It leads with what waits on the reader — a decision, an approval, a step — its children's included, one line each with where to take it, and every later message repeats each one until it is resolved and checked. Then come the outcome and state, short: the decisions taken, what is blocked and who unblocks it, and where the artifact is (a pull request, a file). A managing agent's state brings its children's work into one status: the goal, each child's state and artifact — started only once its session runs, done only once its result is reviewed — the decisions it took on its children's behalf and why, and what happens next. A one-time answer, instruction or single update is a message alone; the record is for what persists.

## The record

- **Status.** Every agent has one status, which its attached session keeps current with `status_set`: its state — `running`, `waiting`, `blocked` with blockers naming who unblocks it, or `review` once its result is delivered — a short plain-text summary, and its links, such as the pull request. The session sets it when the work starts and again, whole, at each milestone that sends a message. A manager reads its children's statuses rather than keeping copies, and the decisions page shows every agent's status in the organization view.
- **Asks.** Every decision or approval a session needs from the level above is an ask, opened with `ask_open` at the moment the session puts it up, and addressed to its agent's manager: a title stating the decision as a short question, context in two or three sentences that stand without the conversation, two to six options, and the label of the one it recommends. The service refuses an ask missing any part. The manager answers it with `ask_answer`, or escalates it with an ask of its own whose `escalates` names the child's ask, restating the decision at its own level. An ask addressed to the user is answered on the decisions page, or in the asking session's own conversation, where that session records the user's words, quoted exactly, with `ask_record_answer`; the user can also step in on any open ask from the page, and the answer then shows it came from the user. The session that asked acts on the answer and says in its next message what it did. An ask that no longer needs its addressee, settled some other way or overtaken by events, is withdrawn with `ask_withdraw` by the session that opened it, never left open.
- **Messages.** A message goes only up, to the agent's manager, sent with `message_send`. A `note` carries a request or a conflict that needs the manager before completion. A `report` carries a result: the outcome in Markdown at the sender's own level, naming its evidence. The manager reads its messages with `inbox_read` when it checks in; nothing pushes them. A report stays unacknowledged until the manager acknowledges it with `message_ack`, or the user does on the decisions page, and acknowledging is the review: the manager acknowledges once it has judged whether the result achieves its task, and accepts it or sends it back in its reply; it never acknowledges a report it has only read.
- **Evidence** is files the reader opens: the report names each by its path, and a message to the user shows them through the client. A UI change is shown by before-and-after screenshots of the same view at the same width, never by a prose list of changes.

Waiting on an ask is optional. A session with work that does not depend on the answer goes on with it and reads the answer when it next checks, through `ask_get`, `session_attach` or `session_context`. A session with nothing else left waits for it (see the client notes below); the wait returns when the ask is answered or withdrawn.

## The decisions page

The decisions page replaces any page a session would publish per task: a session keeps its tracking in the record, not in a document of its own. The page shows the user what is open: first the asks waiting on them, each with the chain of asks it escalates, its options as buttons and the recommendation marked, and the notes and reports addressed to them; then the organization, every agent with its status and its counts of open asks and unread messages, each one open to inspection. Never in the record: logs, chatter, routine progress, change lists, raw infrastructure text, or anything resolved; the service refuses text past its length caps.

## Organization specifics

Names, pronouns, conventions and where an organization keeps its status documents belong to the adopter's own skill layer, loaded alongside this one. It adds to these rules and changes none of them.

## Client notes

### Claude Code

- **The message** to the user is the closing reply and, in the desktop app, the next-step box. To a manager session, it is what the app relays at the end of the turn, or a `SendMessage`, alongside the `message_send` that records it.
- **An answer given in the session**, through a next-step box button or a reply, is the user's own words in the asking session: record it with `ask_record_answer`.
- **Wait for an answer** with `agentorg ask wait <id>` run as a background command; the session wakes when it exits.

### Other MCP clients

- **The message** is the client's own reply or final answer.
- **Wait** with `agentorg ask wait <id>` where the client wakes on a background process's exit; otherwise with the blocking `ask_wait` once nothing else is left to do.
