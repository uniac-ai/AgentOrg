# Codex and other MCP clients

`agentorg-mcp connect codex` configures the project's `org` MCP server, AgentOrg skill and
`SessionStart` context hook. Trust the project, enable `features.hooks`, and review hook definitions
through `/hooks`. `/mcp` lists the three adapter tools.

- **Attachment.** Attach with the Actor ID in your brief, or once with name/purpose when the user
  directly appointed you. Codex identifies the conversation in tool-call metadata; context hooks
  take `session_id` from stdin. The same conversation recovers its Actor and cannot change it.
  A fork with a new conversation ID attaches independently. Verify those identities with the
  installed client when setting up its hooks.
- **Calls.** List `interfaces`, read one's schemas with `interfaces {name}`, and invoke logical Hub
  operations through `call {name, input}`.
- **Inbox.** Codex's generic hooks supply context and do not wake idle turns. When running, read
  `attention {since}` with the `next` of your previous read; its items are what other Actors did
  that concerns you. Use record IDs/revisions to recognize updates. No public read acknowledgement
  is needed or available.
- **Approvals.** Form responses are ordinary Actor records. Native request authorization requires
  a client-owned validated binding, independently of the generic adapter.
- **Other sessions.** Follow the user's authorization for starting or messaging separate sessions.
  A helper within this conversation is not a separately admitted Actor.

Other MCP clients can run the default adapter with `CLAUDE_CODE_SESSION_ID` unset for an unpersisted
attachment. Attach on each start or resume. Their own lifecycle and approval controls govern native
sessions. Existing clients require intentional historical delivery baselining at Workspace cutover.
