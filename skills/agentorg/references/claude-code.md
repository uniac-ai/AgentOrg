# Claude Code

`agentorg-mcp connect claude-code` configures the project's `org` MCP server, context and waiter
hooks, and this skill. `--level report` presents only your own report, for one agent and its
person; `--level team` adds working with other Actors.

- **Tools.** Use `mcp__org__attach`, `mcp__org__interfaces` and `mcp__org__call`. For example, call
  `{name: "status_set", input: {line: "The build passed; releasing next."}}` using the schema from
  `interfaces {name}`.
- **Attachment.** A resumed session recovers its saved Actor. A new session attaches with the Actor
  ID in its brief, or creates a position once when the user directly appoints it.
- **Delivery.** On startup and after a turn, the hook waits on `attention` from where the session
  attached, and hands what other Actors did that concerns you to the session as input, each item
  with what to do. Your own writes never come back. Delivery is at least once; the same item can
  arrive again, and no public receipt is written.
- **Provenance.** Delivered content is an Actor record. A Form response requires a validated client
  binding before it can authorize a native request. Ordinary text and buttons do not create that
  binding through the generic adapter.
- **Helpers.** Subagents sharing this MCP server share its Actor. They do not create an independent
  position merely by running. Use the user's authorized workflow for separate report sessions.
- **Lifecycle.** Close an accepted leaf Actor with `actor_close`, then end its session through an
  authorized client operation. Actor closure does not manage Provider resources.

A session kept from before delivery moved to `attention` starts from now: what happened before its
first wait is in your records, not delivered as input.
