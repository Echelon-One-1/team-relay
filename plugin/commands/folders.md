---
description: Show or change where your automatic answerer looks for your team (repo roots, your own folders), and where to accept the team's boundaries
argument-hint: "[accept | add-root|remove-root|add-folder|remove-folder <path>]"
disable-model-invocation: true
---

I ran `/team-relay:folders $ARGUMENTS`.

Call the `folders` tool of this plugin's `relay` server once:

- With nothing after the command, call it with `{"action": "show"}`.
- With `accept`, call it with `{"action": "accept"}`: it says where to accept (the team console); it accepts nothing.
- With `add-root <path>`, `remove-root <path>`, `add-folder <path>` or `remove-folder <path>`, call it with
  `{"action": "add_root"}`, `"remove_root"`, `"add_folder"` or `"remove_folder"` and `"path"` set to that path
  exactly as I wrote it (absolute, or starting with `~/`). Do not change, guess or complete the path.
- With anything else, do not call it: tell me the forms above.

A change opens a dialog where I decide; you do not decide it and do not answer the dialog
for me. When the tool returns, tell me its message in a line or two. For `show`, list my repo roots and
folders (and any that are not used, with why), what I accepted and anything not accepted yet, and in one
line what my automatic answers come from. Repo roots are where my clones live (for example
`~/code/example-org`): they are searched 3 levels deep for clones of the team's GitHub organisations, and
only files git tracks in them are read. My own folders count only when the team allows them. My automatic
answerer reads only what is both in the team's current boundaries and in what I accepted; until I accept,
teammates' questions to me are declined. I accept the team's boundaries myself in the team console (the
link the tool gives), never here. Do not call the tool again unless I ask.
