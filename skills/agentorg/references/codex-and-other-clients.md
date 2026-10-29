# Codex and other MCP clients

Codex, and any other MCP client that runs AgentOrg's agent actor (`agentorg agent`) as its server `org`, works without the hooks AgentOrg adds in Claude Code. That changes three things.

- **Attach on every start.** The client names no session to the agent actor, so a resumed session isn't attached for you. Attach each time a session starts or resumes, with your actor id. If the user appointed you, your first attach created your position and returned its id: keep it in your role line, and attach with that id from then on, since attaching with a name and purpose again would try to create a second position.
- **Nothing arrives on its own yet.** Nothing delivers messages to the session or wakes it. At the start of each turn and at each milestone, read what waits on you: your unread `messages`, the open `questions` addressed to you, and answers to the questions you asked (yours, since the cursor your last read returned). Mark the messages you have handled read with `message_read`, so their senders see they arrived. When only a wait remains, end your turn with it shown in your progress; you read what arrived when your next turn starts.
- **Starting a report's session.** The user starts it, unless your client offers a tool that starts a session: give them the prompt for a new session in the project folder, "Attach with actor <id>, then read your brief in your messages.", and show the wait in your progress. Subagents within your session are helpers, never briefed to attach to a position.

Tools appear under the server `org`, named as your client lists them; in Codex, `/mcp` lists them.
