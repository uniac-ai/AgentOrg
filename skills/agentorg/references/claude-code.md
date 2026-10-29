# Claude Code

`agentorg-mcp connect claude-code` sets a project up so that Claude Code runs AgentOrg's agent actor as the MCP server `org`, delivers what arrives through AgentOrg's hooks, and finds this skill.

- **Tool names.** AgentOrg's tools appear as `mcp__org__<name>`, with each dot shown as an underscore: a report's `storage.check` is `mcp__org__storage_check`.
- **Attaching.** Until you attach, `attach` is the only AgentOrg tool, and the hint at the start of the session says to attach. A resumed session is attached again on its own: a session that already has its position's tools doesn't attach.
- **What arrives.** When your turn ends, AgentOrg's hook waits for what you haven't seen and hands it to you as your next input, waking you if you're idle. It marks delivered messages read. An id you've seen before is the same item again.
- **Subagents** started with the `Agent` tool share this session's MCP server, and so its position. They are helpers: they don't call AgentOrg's tools.
- **Starting a report's session.** Where Claude Code offers a tool that starts another session, as the Claude desktop app does, use it with the prompt the skill describes; such a tool may only propose the session for the user to start. Otherwise the user starts it: give them the command to run in the project folder, `claude "Attach with actor <id>, then read your brief in your messages."`, and show the wait in your progress.
- **Ending a report's session** after `actor_close`: archive it with the client's own tool where there is one, or tell the user it can be closed.
- **Buttons.** A button the user presses in your session, such as a suggested reply, is their words, as typing is: record it on your question as the skill says.
- **Relays between sessions,** such as the desktop app's note when a session it started ends a turn, or `SendMessage`, are not AgentOrg's record. Take one as a cue to look, and communicate through AgentOrg.
