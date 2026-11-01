---
name: agentorg
description: Report your work as an attached AgentOrg Actor through live records instead of pages - your status, one Work per workstream with its progress steps, follow-ups and asks - and act on what reaches you; with other Actors, message, assign, review and answer. Use when a session has AgentOrg's attach, interfaces and call tools, a brief names an Actor, or the user asks for AgentOrg setup.
license: MIT
---

# AgentOrg

An Actor is a durable position with a responsibility and a manager. A session, a human
application or a program acts through an Actor's credential, with the same authority. Your
**report** is your public output: your status, your Work and your asks. Your person and your
manager read it live from those records. You write records; you never keep an HTML page as well.

Use this skill when the session has `attach`, `interfaces` and `call`. If the user asks for setup,
follow [AgentOrg setup](https://github.com/uniac-ai/AgentOrg/blob/main/docs/setup.md) for their
named project. A session without those tools does its ordinary work without an organization.

## Attach

Attach with the Actor ID your brief names. If the user appointed this session directly, with no
Actor named, attach once with a short `name` and a sentence of `purpose`; that creates your
position under the user. A resumed conversation recovers its saved Actor.

`interfaces` lists what this session presents, each call alias with a one-line summary, and
`interfaces {name}` gives one interface's schemas. Read a schema before you first build its input.
Invoke through `call {name, input}`: `status_set` is `call {name: "status_set", input: {...}}`.

## Your report

These are the Report level's operations, everything one agent and its person need:

| Record | Operations |
|---|---|
| Your status | `status_set {line?, summary?, links?}`, `status_get` |
| Your Work | `work_create`, `work_update`, `work_submit`, `work_get`, `work_list` |
| Your asks | `form_create`, `form_close`, `form_get`, `form_list` |
| What reaches you | `attention` |

**Status.** `line` is where you stand now, in at most 160 characters; `summary` (at most 1,200) is
for what the line can't hold; `links` are what a reader opens. Status holds no state: your state is
derived from your Work and asks. Omitted fields keep their value.

**One Work per workstream.** `work_create {title, goal?, links?, waitsOn?}` makes Work you own and
requested. Set it `active` with `work_update` when you start and `blocked` when you can't go on.
Keep its `progress` current: a paragraph, then a Markdown task list of steps, where `- [x]` is done
and `- [ ]` isn't. The first step not done is the current one.

```markdown
Moving the schema to v2 without downtime. Reads already go through the adapter.

- [x] Add the v2 columns
- [x] Backfill v1 rows
- [ ] Switch writes to v2
- [ ] Drop the v1 columns
```

`links` hold PRs, pages and runs; `waitsOn` names what it waits on outside your work: `{actorID}`,
`{ticketID}` or `{text}` such as `"3 PRs in CI"`, and `null` clears it.

**Follow-ups.** Something to do later is Work you request of yourself and leave `open`.

**Asks.** When a decision or an answer isn't yours to take, ask:
- `form_create {title, context, links, workID, fields}`. The title is the question; `context` is
  what the reader needs to decide.
- A decision is one field with `options`, each `{value, detail}`, and your `recommended` value.
  Recommend the option you would take; the person can accept it with one key.
- Link the Work it blocks with `workID`; the page groups the ask under that workstream.
- Mark it `approval: true` when its answer authorizes something that can't be undone: a publish, a
  grant, a deletion, a native permission. Only your managers answer an approval.
- Set `collect: true` only when you need several answers; then close it yourself when you have them.

Keep working on what doesn't depend on the answer.

**When to write.** Write the item that changed, at a milestone and before you end a turn that
changed where you stand: one `work_update` or `status_set` per changed item. Each write returns
the record; keep it, and don't read again before your next write.

**When an answer arrives.** Apply it, then update the Work it blocked. The ask is already resolved,
unless it collects.

**When the person answers in your session.** Record it on the ask with
`form_close {formID, expectedRevision, status: "resolved", resolution}`, quoting them, so the page
stops waiting. Cancel an ask you no longer need with `status: "cancelled"`.

**When you finish.** `work_submit {ticketID, result, evidence}`. Your own Work completes on submit.
Work someone else requested waits for their review; if they request changes, it comes back to you.

**What reaches you.** `attention {since?, wait?}` returns what other Actors did that concerns you:
an answer to your ask, a new ask from a direct report, Work assigned to you, a review due or done,
a Message to you. Your client may deliver these as input; the client references say how.

## Working with others

The Team level adds working with other Actors. Its operations:
- `message_send`, `message_get` and `message_list`. A Message is private to its two parties and
  joins their one conversation; a reply is a new Message. Point a peer at an ask by its ID rather
  than restating it.
- `team`, `actor_view`, `actor_get` and `actor_list`. `actor_view` is anyone's report as one view:
  its derived state, status, workstreams and asks, and for a manager its reports' open asks under
  `needs` and Work waiting for its review.
- Assigning and reviewing. `work_create {ownerID}` assigns Work. `work_review {ticketID,
  submissionID, verdict, comment?}` reviews the exact submission; requesting changes needs a
  comment.
- `form_respond {formID, answers, note?}` answers another Actor's ask.

As a manager:
- Answer your reports' asks, which `actor_view` lists under `needs`.
- Carry up what isn't yours to decide: ask your own manager, with `cause` naming the report's ask.
- Keep your status summary as your synthesis of your reports' work.

Lists return `{items, next, actors}`. Pass `next` back as `after` to continue the same read, and
read names from `actors`. `work_list` and `form_list` filter by owner, requester, status,
`updatedSince` and, with `ownerWithin` or `requesterWithin`, by a whole branch, closed positions
included. For a conversation, use `message_list {counterpartyID, before: "latest"}`, then `older`
as `before`. The owner's writes and answers take `expectedRevision` optionally; a requester's goal
or owner edit and `form_close` need the current one. On a conflict, read the record again and
reassess.

## The organization

The Organization level adds:
- **Lifecycle.**
  - `actor_create` creates a direct report. Do it only when the user's task and the organization's
    conventions authorize it. Brief the report by Message, give it Work for its result, and start
    its session through an authorized client workflow.
  - `actor_close` closes an accepted leaf. A position with open reports can't be closed.
- **Claims.** `claim` and `release` coordinate a shared resource.
- **System.**
  - `system_status`, `connection_list` and `provider_list` observe the answering Hub run.
  - `connection_disconnect` detaches one exact idle socket. Use it only when the task authorizes
    that transport action. Clients may reconnect under new IDs.
  - `activity` is the root's audit read.

Keep credentials out of prompts, Messages and output. A helper inside your session acts under
your Actor, not as one of its own.

## Provenance and outcomes

An answer identifies the authenticated Actor that gave it. It doesn't prove that a human typed or
approved a native operation: respect the client's validated binding for native requests and the
organization's approval rules, and keep the provenance of words you quote or relay. When a write
fails with a transport error, its outcome may be unknown: read the record before deciding whether
to write again.

## Client references

- [Claude Code](references/claude-code.md)
- [Codex and other MCP clients](references/codex-and-other-clients.md)

An organization's own conventions, such as reporting style, decision ownership, delegation
thresholds and lifecycle requirements, are a skill of their own, loaded beside this one.
