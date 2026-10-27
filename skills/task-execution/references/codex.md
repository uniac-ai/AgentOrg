# Codex

Codex separates subagents within the current task from user-owned app tasks. The current host's tool contracts define exact arguments and availability; below, `collaboration` names the subagent tools and `mcp__codex_app__*` the app tools. [OpenAI's subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) explains the delegation and context model.

## Subagents within the current task

A subagent is a child.

- **Create with `collaboration.spawn_agent`** for a concrete, bounded subtask that runs independently. `task_name` is an address component, not a title; the returned canonical task name, such as `/root/review_schema`, is the child's address.
- **Write `message` to stand alone**: the child's agent id from `agent_create`, the parent's purpose and address, the expected deliverable, scope, relevant paths, constraints, dependencies and file ownership, even when history is inherited. Keep the inherited model and reasoning settings unless instructions require an override.
- **Steer with the matching operation.** `send_message` delivers information without starting a turn, `followup_task` starts an idle non-root agent or steers a running one, and `interrupt_agent` stops the current turn and keeps the agent. Address an agent by its returned ID or canonical task name, and a child also by its relative name.
- **Wait for notifications.** `wait_agent` returns a summary of mailbox updates and completions; messages and final results arrive in the parent's conversation. Wait with a bound once no independent work is left; `list_agents` is a status snapshot, not a polling loop.
- **Allocate file ownership.** Subagents share the filesystem and working directory, so concurrent editors get disjoint files or their own worktrees, and one owner integrates.
- **Report with the final answer**, which reaches the parent automatically; before completion, `send_message` carries blockers and conflicts with other agents.

## Separate app tasks requested by the user

- **Create only on an explicit request for a new task**, with `create_thread`, which creates a user-owned task; delegated subtasks are subagents. For repository work, select a project ID from `list_projects`: a worktree for a Git repository and local for a non-Git project, unless the user asks for the saved checkout. Omit model overrides unless requested.
- **Carry identity and context in the prompt**: scope, relevant paths, expected result, reporting expectations, and a verified parent task ID when available — a collaboration address such as `/root` is not one. Set the title at creation with the title convention in `SKILL.md`; `set_thread_title` renames app tasks, not subagents. `list_threads` discovers existing tasks, which are named to the user by their returned title.
- **Wait for an addressable task.** Creation is asynchronous, and a pending `clientThreadId` is a receipt, not a `threadId`. Find the task with `list_threads` by its title and project, and proceed only on an unambiguous match that supplies a real `threadId` and `hostId`; otherwise keep the receipt, and neither guess an ID nor send work to another task. The final response includes `::created-thread{threadId="..."}`, with the `clientThreadId` while setup is pending.
- **Send and observe through app tools.** `send_message_to_thread` continues a task with a user-visible prompt. Track it with bounded `wait_threads` calls, passing each target's ID, host and last cursor as `afterCursor`, and use `read_thread` when actual history or output is needed. Once the task is addressable, check its progress, and keep supervising it when the user's request includes completing that work; creation establishes neither progress nor completion. Approval and user-input requests stay with the user.
