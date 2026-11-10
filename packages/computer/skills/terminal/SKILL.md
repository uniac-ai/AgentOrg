---
name: terminal
description: Run commands on your computer, including ones that take a while or wait for input. Use when a task needs a program, a build, tests, git or anything else from the command line.
---

# Using the terminal

`computer__exec_command` runs a command in a shell, in your workspace unless you pass `workdir`. `computer__write_stdin` checks on a command that is still running, or types into it.

Every answer has the same four parts:

- `exit_code`: how it ended, or `running` if it hasn't.
- `seconds`: how long this call waited.
- `session_id`: what to pass to `computer__write_stdin` while it runs, or `none`.
- `text`: what it wrote since the last answer. Long output has its middle cut.

## Commands that take a while

A command that doesn't finish within `yield_time_ms` (10 seconds by default) keeps running and answers with a `session_id`. Call `computer__write_stdin` with that id and no `chars` to wait for more. Keep checking until `exit_code` is a number. Don't start the command again.

## Typing into a command

Pass `chars`, with `\n` to press Enter. `\u0003` is Ctrl-C and interrupts it. `\u0004` is Ctrl-D and ends its input.

Commands run without a terminal, so a program that needs a full screen, such as an editor or `top`, won't work. Use a non-interactive form: `git --no-pager`, `git commit -m`, a package manager's `--yes`.

## Sessions on your computer

`computer__list_sessions` lists them, running or lately ended: each command you started and each shell a person opened, with its `session_id` and who started it. Use it to find a command whose `session_id` you no longer have. `computer__write_stdin` reads and types into a person's shell too, by its `session_id`.

A person's shell is theirs. Read it when the task needs it. Type into it only when they asked you to. It is on a terminal, unlike your commands: what you type joins anything they have already typed, `\u0003` interrupts what they are running, and `\u0004` at its prompt closes it.

## Good habits

- Read what a command said before you run the next one, and when one fails, find out why before trying something else.
- Ask for less output when you can: `| tail -n 50`, or a quiet flag.
- A non-zero `exit_code` is an answer, not a broken tool. Plenty of commands use it to say "nothing found".
- Each call starts a new shell, so a `cd` or an exported variable doesn't carry over. Use `workdir`, or put it all in one command.
- Stop what you started when you've finished with it, such as a server you ran to test something.
