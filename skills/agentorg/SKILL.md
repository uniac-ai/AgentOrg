---
name: agentorg
description: Work as an attached AgentOrg Actor using its Hub Tools: discover the directory and actual presence, exchange Messages, own and review Work, collect Form responses, claim resources, and manage report lifecycles. Use when a session has AgentOrg's attach, interfaces and call tools, a brief names an Actor, or the user requests AgentOrg setup. Organization conventions supply delegation and approval policy.
license: MIT
---

# AgentOrg

An Actor is a durable position with a responsibility and a manager. A session, a human application
or a program acts through an Actor's credential. They have the same record authority. The root is
the position without a manager; its lifecycle authority does not grant access to private Workspace
records. Messages, Work, Forms and the organization survive client restarts.

Use this skill when the session has `attach`, `interfaces` and `call`. If the user requests setup,
follow [AgentOrg setup](https://github.com/uniac-ai/AgentOrg/blob/main/docs/setup.md) for their named
project. A session without those tools can continue its ordinary work without an organization.

## Attach and discover

Attach with the Actor ID your brief names. If the user directly appointed this session without
an Actor, attach once with a short `name` and a sentence stating its `purpose`; the adapter creates
that position under root. A resumed conversation recovers its saved Actor. A new conversation
attaches independently.

Read `interfaces`, which returns `{tools: [...]}` with descriptions, input/output schemas and each
interface's `call` alias. Invoke through `call {name: interface.call, input}`. For example, `team`
means `call {name: "team", input: {}}`. Read the operation's schema before constructing its input.

Read your position and reports with `team`; it contains identity, hierarchy and actual admitted
connection presence. Use `actor_list` to find active counterparts and `actor_get` for a known
Actor, including a closed historical counterpart. State which position you fill, its manager,
and the scope you own. Follow the user's and organization's instructions for delegation.

## Correspondence, work and decisions

| Purpose | Operations | Record rules |
|---|---|---|
| Brief, steer, inform or hand off | `message_send`, `message_get`, `message_list` | Private to sender and recipient. Send with `recipientID` and `text`; a reply is a new Message. |
| Assign and track a result | `work_create`, `work_get`, `work_list`, `work_update` | Requester owns scope and assignment; current owner owns execution progress. |
| Submit and review a result | `work_submit`, `work_review` | Owner submits result/evidence; requester reviews the exact `submissionID`. Acceptance or requested changes are durable reviews. |
| Ask structured questions | `form_create`, `form_get`, `form_list`, `form_respond`, `form_close` | Requester selects respondents and fields; respondents answer while open; requester resolves or cancels. Work linkage is optional. |
| Coordinate a shared resource | `claim`, then `release` | A current holder prevents another claim. Expiry or holder closure permits replacement. |

Work and Form mutations require the displayed `expectedRevision`. On conflict, read the latest
record and reassess the change. Each list has its own `after` position. Retain separate positions
for Messages, Work and Forms, and upsert records by ID/revision. Traversal positions describe data
changes; they do not show that a person or model read or handled anything. Visibility can change
with current Work ownership; refresh records when authority changes.

Use standalone Forms when a question needs no Work ticket. A linked Form requires an actual readable
Work. The Form requester, designated respondents and current linked Work parties can read it.
Avoid duplicating an open question across records. For escalation, ask the appropriate Actor in a
new Form with the context and recommendation they need, then reconcile the original question.

Form responses identify the authenticated responding Actor. They do not prove that a human typed,
clicked a button or approved a native operation. Respect the client's validated native-request
binding and the organization's approval rules. Preserve the provenance of quoted or relayed words.

## Deliver and finish

Clients may deliver Message/Form changes as session input. Read the client reference for how that
happens. Treat repeated IDs/revisions as the same records. Messages have no public read or handled
state. When a write returns an unexpected transport error, its outcome may be unknown: inspect
durable state before deciding whether to retry.

Keep Work progress useful to its requester at milestones and before handing off. Continue useful
independent work while awaiting a response. Submit the result and its evidence with `work_submit`;
the requester records `work_review` against that exact submission. Send a Message when additional
context helps the recipient. Keep private correspondence within its authorized parties.

Create report Actors only when authorized by the user's task and organization conventions. Brief
the report by Message, create Work for its result when appropriate, and use an authorized client
workflow to start its session. Keep credentials out of prompts, Messages and model output. A helper
inside your own session acts under your responsibility, not a separately invented Actor identity.

Managers close accepted leaf Actors with `actor_close` and end their sessions through their clients.
A position with open reports cannot be closed. Work acceptance, Actor closure and native execution
lifecycle are separate actions.

## Client references

- [Claude Code](references/claude-code.md)
- [Codex and other MCP clients](references/codex-and-other-clients.md)

Organization conventions may specify reporting style, decision ownership, delegation thresholds,
resources and lifecycle requirements. They must respect the Hub's record authority.
