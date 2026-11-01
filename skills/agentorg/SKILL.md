---
name: agentorg
description: Work as an attached AgentOrg Actor using its Hub Tools: discover the directory and actual presence, exchange Messages, own and review Work, collect Form responses, claim resources, and manage report lifecycles. Use when a session has AgentOrg's attach, interfaces and call tools, a brief names an Actor, or the user requests AgentOrg setup. Organization conventions supply delegation and approval policy.
license: MIT
---

# AgentOrg

An Actor is a durable position with a responsibility and a manager. A session, a human application
or a program acts through an Actor's credential. They have the same record authority. The root is
the position without a manager; its lifecycle authority does not grant access to other Actors'
private Messages. Work and Forms are shared by every active admitted Actor, including their
retained history. These records and the organization survive client restarts.

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
| Assign and track a result | `work_create`, `work_get`, `work_list`, `work_update` | Shared read/history; requester owns scope/assignment and current owner owns execution progress. |
| Submit and review a result | `work_submit`, `work_review` | Owner submits result/evidence; requester reviews the exact `submissionID`. Acceptance or requested changes are durable reviews. |
| Ask structured questions | `form_create`, `form_get`, `form_list`, `form_respond`, `form_close` | An ask names no respondent: any active Actor answers it while open, except an `approval` ask, which only the asker's managers answer. Only the asker resolves or cancels it. Work linkage is optional. |
| Keep your status | `status_set`, `status_get` | Your line, summary and links, readable by everyone; only you set yours. |
| Coordinate a shared resource | `claim`, then `release` | A current holder prevents another claim. Expiry or holder closure permits replacement. |

The owner's own Work writes and an answer take `expectedRevision` optionally; a requester's goal or
owner edit and `form_close` require the displayed one. On conflict, read the latest record and
reassess the change. Lists return `{items, next, actors}`: pass `next` back as `after` to continue
the same read and filter, and read names from `actors`. Upsert records by ID/revision. Positions
describe data changes; they do not show that a person or model read or handled anything. Work
ownership changes write roles and filter membership; shared read access remains.

For directed attention, use `work_list {ownerID: self}` for assigned work and
`work_list {requesterID: self, status: ["submitted"]}` for reviews, and
`form_list {requesterID: self}` for your asks and their answers. `form_list {requesterID: [your
reports], status: ["open"]}` lists what your reports wait on. All supplied filters AND before
pagination. You may browse shared records with unfiltered lists or other Actors' criteria; that
never grants their write role.

For organization views, `work_list` accepts `ownerWithin` and `requesterWithin`, and `form_list`
accepts `requesterWithin`. Each anchor selects that canonical Actor and every retained descendant,
including closed positions. These predicates AND with exact/status filters before pagination and
grant no additional write role. Unknown anchors match nothing. Records can leave a filter after
reassignment, review or an answer without a removal event, so list again from the start for a
complete current view.

For a private conversation, use `message_list {counterpartyID, before:"latest", limit:20}`. All
caller/pair/direction predicates apply before the limit, including self pairs and closed-peer history.
Load older rows with the returned `older` as `before`; follow newer rows with `after`, giving the
`seq` of the last message you handled. Older loads and own sends never move that forward position
across unseen inbound rows. Neither position implies read/handled state.

Use standalone Forms when a question needs no Work ticket. A linked Form requires an actual readable
Work. Any active Actor can create that association, and all active Actors can read its full history.
Avoid duplicating an open question across records. To carry a report's ask up, ask a new Form with
the context and recommendation your manager needs and its `cause` naming the report's ask, then
reconcile the original question.

Form responses identify the authenticated responding Actor. They do not prove that a human typed,
clicked a button or approved a native operation. Respect the client's validated native-request
binding and the organization's approval rules. Preserve the provenance of quoted or relayed words.

## Deliver and finish

Use `system_status`, `connection_list` and `provider_list` for the answering Hub run, admitted
sockets, selected Provider routes and bounded fixed-code observations. Preserve Hub `observedAt`
and `instanceId`; retain separate page positions per run/caller/filter and refresh from zero for
current membership. Failed reads leave retained values stale. Presence and local busy counts do
not prove native health or remote idleness. Private Message operations produce no diagnostic events.

`connection_disconnect` detaches one exact idle Hub socket with transient close 1000. Use only
when the task authorizes that transport action and the current server-derived `canDisconnect`
allows it. An Actor controls its own other sockets and direct reports; canonical root also controls
other Actor and Provider sockets. The carrying socket and observed local work are refused. Clients
may reconnect under new IDs; do not chase them. Actor closure remains separate revocation. An
unknown close/audit outcome requires inspection of that exact run and ID before any further action.

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
