# Claude Code

These notes cover the Claude desktop app's session tools, plus the `agentorg` plugin. The plugin's MCP server is `org`, so its tools appear as `mcp__plugin_agentorg_org__<name>`, with each dot shown as an underscore: a report's `storage.check` appears as `mcp__plugin_agentorg_org__storage_check`.

- **Attach first.** Before attaching, `attach` is the only tool offered. After it, the tools are the position's interfaces, and a resumed session is reattached on its own.
- **Messages arrive as input.** The plugin delivers each message and answer to the session as input, framed as an AgentOrg message with its sender's path and its id, and wakes an idle session for it. A repeated id is the same message, delivered again.
- **Start a report's session with `start_session`** once `actor_create` has made its position. `start_session` starts a session only on the user's own words in that session; on any other turn, which is every turn of a session the user does not write in, the session proposes it as an `own_initiative` card and asks the approval question up with a link to its own session, where the user starts the card or types the go-ahead. The `title` stays under 60 characters, convention included.
- **Detach a session whose position is directly under the user** with the session-management `detach_session` tool once it runs. Its starter detaches it, or the session detaches itself with `self`. Otherwise the app nests it under its starter, relays its turns there and archives it with it.
- **`Agent` and `Workflow` are helpers.** The app's advice to do a handful of tool calls in place applies to executing sessions only.
- **A next-step button or a typed reply that answers a question is the user's words in the asking session:** record it as the skill says, unless the question is an approval with `answerer`, which the user answers in the web app.
- **The app's relay and `SendMessage` are not the organization's record.** Within the organization, communication is `message_send` and `question_ask`; a relayed turn-end note is only a cue to look.
- **Archive with the session-management `archive_session` tool** once `actor_close` has closed the report's position.
- **Retitle with `set_session_title`** (`self` for the current session). The app asks the user to approve replacing a title the user set.
