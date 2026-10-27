# Claude Code

These notes cover the Claude desktop app's session tools, plus the agentorg plugin. With the plugin, agentorg's tools come from its `agentorg` MCP server, and the start hook prints the session's facts once the session has attached.

- **Create a child with `agent_create`, then start its session with `start_session`.** `start_session` starts a session only on the user's own words in that session. On any other turn, which is every turn of a session the user does not write in, the session proposes the child's session as an `own_initiative` card. It carries the headcount request up, with a link to its own session, and the user starts the card there or types the go-ahead there. The `title` stays under 60 characters, convention included.
- **Detach a session whose agent is directly under the user** with the session-management `detach_session` tool once it runs. Its starter detaches it, or the session detaches itself with `self`. Otherwise the app nests it under its starter, relays its turns there and archives it with it.
- **`Agent` and `Workflow` are helpers.** The app's advice to do a handful of tool calls in place applies to executing sessions only.
- **Look for an owner in `ListAgents`.** It lists the sessions one can message. Send the owner the evidence with `SendMessage`.
- **The brief is everything the child receives.** It names the child's agent id, and names the manager's session two ways:
  - its session name, which `ListAgents` prints at the top of its listing;
  - its title, which finds it in `ListAgents` if that name stops resolving.
- **The app's relay is a cue to check in, not a report.** When a child ends a turn, the first 400 characters of its wrap-up recap and last message reach the session that started it, so they lead with the outcome and any step for the manager. The record holds the child's status, asks and messages; the manager reads them when it checks in. The session-management `send_message` tool is for one-off handoffs, not for managing execution.
- **Archive with the session-management `archive_session` tool** once `agent_close` has closed the child's agent.
- **Retitle with `set_session_title`** (`self` for the current session). The app asks the user to approve replacing a title the user set.
