# Claude Code

`agentorg-mcp connect claude-code` configures the project's `org` MCP server, context and waiter
hooks, and this skill.

- **Tools.** Use `mcp__org__attach`, `mcp__org__interfaces` and `mcp__org__call`. For example, call
  `{name: "message_send", input: {recipientID: "<actor>", text: "The build passed."}}` using the
  current schema from `interfaces`.
- **Attachment.** A resumed session recovers its saved Actor. A new session attaches with the Actor
  ID in its brief, or creates a position once when the user directly appoints it.
- **Delivery.** On startup and after a turn, the hook polls incoming Messages and changes to the
  attached Actor's own asks. It delivers bounded pages as session input and keeps a private
  position for each.
  Delivery is at least once. The same ID/revision can arrive again; no public receipt is written.
- **Provenance.** Delivered content is an Actor record. A Form response requires a validated client
  binding before it can authorize a native request. Ordinary text and buttons do not create that
  binding through the generic adapter.
- **Helpers.** Subagents sharing this MCP server share its Actor. They do not create an independent
  position merely by running. Use the user's authorized workflow for separate report sessions.
- **Lifecycle.** Close an accepted leaf Actor with `actor_close`, then end its session through an
  authorized client operation. Actor closure does not manage Provider resources.

At an upgrade, existing sessions require deliberate delivery baselining before hooks resume. The
Hub's private historical import manifest supports this coordination; old shared cursors cannot be
used as new Message/Form positions.
