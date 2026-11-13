---
description: List or change the folders on this Mac your automatic answerer may read for your team
argument-hint: "[list | add <path> | remove <path>]"
disable-model-invocation: true
---

I ran `/team-relay:folders $ARGUMENTS`.

Call the `folders` tool of this plugin's `relay` server once:

- With nothing after the command, or with `list`, call it with `{"action": "list"}`.
- With `add <path>` or `remove <path>`, call it with `{"action": "add"}` or `{"action": "remove"}` and
  `"path"` set to that path exactly as I wrote it (absolute, or starting with `~/`). Do not change, guess
  or complete the path.
- With anything else, do not call it: tell me the forms above.

A change opens a dialog where I decide; you do not decide it and do not answer the dialog
for me. When the tool returns, tell me its message in a line or two. For `list`, list my folders (and any
that are not used, with why), any I chose before 13 Nov 2026 (not used now; I add again the ones I want with
`add <path>`, never you), whether I
accepted my team's boundaries, and in one line what my automatic answers come from. I choose at most 20
folders on this Mac; inside a git repository only the files git tracks are read, and elsewhere every
file except credentials and other secrets. Until I accept my team's boundaries, teammates' questions to
me are declined; I accept them myself in the team console (the link the tool gives), never here. Do not
call the tool again unless I ask.
