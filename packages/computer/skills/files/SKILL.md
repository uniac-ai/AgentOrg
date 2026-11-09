---
name: files
description: Read, find and change files in your workspace. Use when a task involves looking through a project or a folder, or editing a file.
---

# Using files

Use only the tools you have. You may be able to read and not change.

| Tool               | What it does                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `computer__list`   | A folder. Folders end in `/`; files give their size in bytes                                                           |
| `computer__search` | Text under a folder, as `path:line:text`. Exact text unless you pass `regex: true`. It skips what `.gitignore` ignores |
| `computer__read`   | A file as numbered lines. Use `offset` and `limit` for part of a long one                                              |
| `computer__edit`   | Replaces exact text and answers with a diff                                                                            |

Paths are relative to your workspace. A path outside it is refused.

## Finding your way

Start with `computer__list` and `computer__search` rather than reading whole files, then read the parts that matter.

## Editing

- Read the file first. `old_text` has to match exactly, spaces and line breaks included. The numbers `computer__read` shows at the start of each line aren't part of the file.
- `old_text` must appear exactly once. If it's refused for appearing more than once, include a line or two around it, or pass `replace_all: true` when you mean every one.
- To make a new file, pass an empty `old_text`.
- Check the diff in the answer. It shows what actually changed.
