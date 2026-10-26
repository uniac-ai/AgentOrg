---
name: reporting
description: How a session conveys its work to its reader — the user or its parent session — through a message every time, while the agentorg service holds the record of asks, workstreams and reports. Load whenever a session reports, asks for a decision or approval, ends a turn with something for its reader, or opens, updates or resolves a workstream.
---

# Reporting

A session reaches its reader through two channels. The message, sent every time, is what an employee sends their manager: it grabs attention and summarizes. The record, held by the agentorg service, is the file the employee keeps current so anyone can see the work's state at any time: every decision waiting on the user is an ask, every open workstream an item, every result for a parent session a report. The decisions page shows the user what in it is open. A long report in chat wastes the reader's context and hides what needs them, so whatever the message leaves out lives in the record or behind a link.

When a session reports and to whom, and how sessions form a hierarchy, belong to the task-execution skill. This skill says what a report contains and what the service records. Tools are named as MCP tools; the command line runs each as `agentorg <subject> <verb>`, such as `agentorg ask open`.

## The message

Every report is a message through the client's delivery mechanism (see the client notes below). It carries only what the reader needs and cannot already see, and stands on its own for a reader who has not followed the traffic between sessions, the user included. It leads with what waits on the reader — a decision, an approval, a step — its children's included, one line each with where to take it, and every later message repeats each one until it is resolved and checked. Then come the outcome and state, short: the decisions taken, what is blocked and who unblocks it, and where the artifact is (a pull request, a file). A managing session's state brings its children's work into one status: the goal, each workstream's state and artifact — started only once its child runs, done only once its result is reviewed — the decisions it took on its children's behalf and why, and what happens next. A one-time answer, instruction or single update is a message alone; the record is for what persists.

## The record

- **Asks.** Every decision or approval the user takes is an ask, opened with `ask_open` by the session that puts it to the user, at the moment it does: a title stating the decision as a short question, context in two or three sentences that stand without the conversation, two to six options, and the label of the one it recommends. The service records the asking session and refuses an ask missing any part. The user answers on the decisions page, or in the asking session's own conversation, where that session records the user's words, quoted exactly, with `ask_record_answer`. The answer returns to the session that asked, which acts on it and says in its next message what it did. An ask that no longer needs the user, settled without them or overtaken by events, is withdrawn with `ask_withdraw` by the session that opened it, never left open.
- **Items.** Every workstream in flight or under review is one item, kept with `item_put`: a manager keeps one per child, naming the child as the session doing the work, and an executing session whose parent is the user, with no manager session to keep it, keeps its own. It is put when the workstream starts, a child's once the child runs, and put again, whole, at each milestone that sends a message: its state — `running`, `waiting`, `blocked` with blockers naming who unblocks it, or `review` once its result is delivered — a short summary, and its links, such as the pull request. Once its result is reviewed and checked, the session that keeps it resolves it with `item_resolve`, and it drops off rather than staying marked done.
- **Reports.** Every result for a parent session is a report, sent with `report_send` alongside the message: the outcome in Markdown at the sender's own level, naming its evidence. The service adds the sender's asks still open, and the report waits in the parent's inbox, returning on every `inbox_read` and `session_start`, until the parent acknowledges it with `report_ack`. Acknowledging is the review: the parent acknowledges once it has judged whether the result achieves its task, and accepts it or sends it back in its reply; it never acknowledges a report it has only read.
- **Evidence** is files the reader opens: the report names each by its path, and a message to the user shows them through the client. A UI change is shown by before-and-after screenshots of the same view at the same width, never by a prose list of changes.

An answer reaches a session at once only while the session waits for it, so a session opens an ask and arms a wait for it in the same step (see the client notes below); the wait returns when the ask is answered or withdrawn. Without one, the answer is read only when the session next runs, through `ask_get`, `session_start` or `session_context`.

## The decisions page

The decisions page replaces any page a session would publish per task: a session keeps its tracking in the service, not in a document of its own. The page shows only what is open — every open ask first, with its options as buttons and the recommendation marked, then the open workstreams by task, with their state, summary and links. Never in the record: logs, chatter, routine progress, change lists, raw infrastructure text, or anything resolved; the service refuses text past its length caps.

## Organization specifics

Names, pronouns, conventions and where an organization keeps its status documents belong to the adopter's own skill layer, loaded alongside this one. It adds to these rules and changes none of them.

## Client notes

### Claude Code

- **The message** to the user is the closing reply and, in the desktop app, the next-step box; to a parent session, it is what the app relays at the end of the turn, or a `SendMessage`.
- **An answer given in the session**, through a next-step box button or a reply, is the user's own words in the asking session: record it with `ask_record_answer`.
- **Wait for an answer** with `agentorg ask wait <id>` run as a background command; the session wakes when it exits.

### Other MCP clients

- **The message** is the client's own reply or final answer.
- **Wait** with `agentorg ask wait <id>` where the client wakes on a background process's exit; otherwise with the blocking `ask_wait` once nothing else is left to do.
