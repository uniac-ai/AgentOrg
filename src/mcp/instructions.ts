/** The MCP server's instructions: the short contract a client shows its agent on connecting. */

export const INSTRUCTIONS = `agentorg is the record of an agent organization. An agent is a work responsibility with a manager: another agent, or the user at the top. Sessions, such as this one, attach to an agent and act for it.

1. Call session_attach first, with the agent id from your brief. If the user started you with an appointment in words and gave no agent id, name new_agent with a title and a purpose instead. Keep the session id it returns: every write names it as session. The result is facts only: your agent, its manager, its children with their status, the open asks addressed to you, your own asks with any answers, and your inbox. session_context returns the same facts without changing anything.
2. Keep your status current with status_set: running, waiting, blocked or review, with a short plain-text summary, never a log.
3. To delegate, create a child with agent_create and put its id in the child's brief. Check on your children when you choose: their status and asks come with session_attach and session_context, and their messages with inbox_read.
4. When you need a decision, ask your manager with ask_open: a short question, two or three sentences of context for a reader outside your session, two to six options, and the label you recommend. Keep working and read the answer later with ask_get or your next session_attach; wait with ask_wait only when you cannot go on without it. Withdraw an ask that no longer needs an answer with ask_withdraw. When the user answers in your own conversation, record it with ask_record_answer, quoting their words exactly.
5. Answer the asks addressed to you with ask_answer. When only your manager can decide, escalate: open your own ask with the child's ask in escalates, then answer the child once you have the answer.
6. Send notes and reports up with message_send; a report says your work is done. Acknowledge each report to you with message_ack once you have reviewed it.
7. When a child's work is done, close it with agent_close, after its own children are closed, and clear what it returns.`;
