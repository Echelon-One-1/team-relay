---
description: Set up the team relay on this Mac in your browser (no Terminal needed)
disable-model-invocation: true
---

I ran `/team-relay:setup`. Call the `setup` tool of this plugin's `relay` server, with no arguments, once.

If I am not signed in yet, it first opens the relay's sign-in in my browser and waits (up to 5 minutes)
while I sign in with Google and choose my team. Then it opens the setup page on this Mac in my browser
and returns at once. On that page I accept what my team shares, pick the folders my Claude answers my
team from with the Mac's folder chooser, and choose whether my Mac answers in the background.
I decide everything there: you do not decide anything, and you do not open, fetch or change the page.

When the tool returns, tell me its message in one line. If it says the sign-in did not finish, tell me
that in one line and that I can run `/team-relay:setup` again. Do not call it again unless I ask.
